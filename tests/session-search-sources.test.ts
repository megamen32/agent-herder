import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {scanSessionSearchSources,type SearchSourceStatus} from '../src/session-search-sources.js';
const roots:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'search-sources-'));roots.push(root);for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','HERMES_STATE_DB','CLAUDE_PROJECTS_DIR'])vi.stubEnv(key,join(root,key));return root;}
describe('persisted session search sources',()=>{
 it('streams every Codex message and preserves catalog identity and title beyond UI caps',async()=>{
  const root=await fixture(),home=join(root,'CODEX_HOME');await mkdir(home,{recursive:true});const path=join(root,'archived.jsonl');
  const lines=[{type:'session_meta',payload:{id:'native-id',cwd:'/work'}},...Array.from({length:240},(_,n)=>({type:'response_item',payload:{type:'message',role:n%2?'assistant':'user',content:[{text:`needle-${n}`}]}}))];await writeFile(path,lines.map(x=>JSON.stringify(x)).join('\n'));
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id,title,cwd,rollout_path)');db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('native-id','Saved title','/work',path);db.close();
  const statuses:SearchSourceStatus[]=[];const chunks:any[]=[];let found:any;
  for await(const s of scanSessionSearchSources({onStatus:s=>statuses.push(s)})){found=s;for await(const c of s.chunks)chunks.push(c);}
  expect(found).toMatchObject({harness:'codex',nativeSessionId:'native-id',title:'Saved title',cwd:'/work'});expect(chunks).toHaveLength(240);expect(chunks.at(-1).text).toBe('needle-239');expect(statuses.find(s=>s.harness==='codex')?.state).toBe('complete');expect(statuses.find(s=>s.harness==='opencode')?.state).toBe('unavailable');
 });
 it('keeps catalog titles searchable when historical rollout files are unavailable',async()=>{
  const root=await fixture(),home=join(root,'CODEX_HOME');await mkdir(home,{recursive:true});
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id,title,cwd,rollout_path)');db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('missing-id','Historical title','/old',join(root,'missing.jsonl'));db.close();
  const statuses:SearchSourceStatus[]=[];const sessions:any[]=[];for await(const s of scanSessionSearchSources({onStatus:s=>statuses.push(s)})){sessions.push(s);for await(const _ of s.chunks){}}
  expect(sessions[0]).toMatchObject({nativeSessionId:'missing-id',title:'Historical title'});expect(statuses.find(s=>s.harness==='codex')).toMatchObject({state:'partial',reason:'native_rollout_file_missing'});
 });
 it('reads all SQLite parts and Hermes messages without adapter limits or source writes',async()=>{
  const root=await fixture(),path=join(root,'OPENCODE_DB_PATH');const db=new DatabaseSync(path);db.exec('CREATE TABLE session(id,title,directory,time_created,time_updated);CREATE TABLE message(id,session_id,data,time_created);CREATE TABLE part(id,session_id,message_id,data,time_created)');db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('s','Database title','/project',1,2);
  db.exec('BEGIN');for(let n=0;n<205;n++){db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m'+n,'s','{"role":"user"}',n);db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('p'+n,'s','m'+n,JSON.stringify({type:'text',text:'full-history-'+n}),n);}db.exec('COMMIT');db.close();
  const before=await import('node:fs/promises').then(fs=>fs.readFile(path));let count=0;
  for await(const s of scanSessionSearchSources())for await(const c of s.chunks){count++;expect(c.id.startsWith('p')).toBe(true);}
  expect(count).toBe(205);expect(await import('node:fs/promises').then(fs=>fs.readFile(path))).toEqual(before);
 });
 it('changes a Hermes revision for same-length edits without an update timestamp',async()=>{
  const root=await fixture(),path=join(root,'HERMES_STATE_DB');const db=new DatabaseSync(path);db.exec("CREATE TABLE sessions(id,title,cwd);CREATE TABLE messages(id,session_id,content,timestamp);INSERT INTO sessions VALUES('h','title','/work');INSERT INTO messages VALUES(1,'h','firstword',1)");
  const scan=async()=>{let found:any;for await(const s of scanSessionSearchSources()){found=s;for await(const _ of s.chunks){}}return found;};
  const before=await scan();db.exec("UPDATE messages SET content='otherword' WHERE id=1");const after=await scan();expect(after.revision).not.toBe(before.revision);db.close();
 });
 it('marks a damaged native source unavailable without calling it exhaustive',async()=>{
  const root=await fixture(),home=join(root,'CODEX_HOME','sessions');await mkdir(home,{recursive:true});await writeFile(join(home,'broken.jsonl'),'not-json');const statuses:SearchSourceStatus[]=[];
  for await(const s of scanSessionSearchSources({onStatus:s=>statuses.push(s)}))for await(const _ of s.chunks){}
  expect(statuses.find(s=>s.harness==='codex')).toMatchObject({state:'partial',sessions:0});
 });
 it('honors abort before opening native sources',async()=>{await fixture();const controller=new AbortController();controller.abort();await expect((async()=>{for await(const _ of scanSessionSearchSources({signal:controller.signal})){} })()).rejects.toThrow();});
});
