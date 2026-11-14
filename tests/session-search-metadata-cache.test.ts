import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const fsState=vi.hoisted(()=>({blockedPath:undefined as string|undefined}));
vi.mock('node:fs',async()=>{
 const actual=await vi.importActual<typeof import('node:fs')>('node:fs');
 return {...actual,createReadStream:(path:any,...rest:any[])=>{
  if(typeof path==='string'&&path===fsState.blockedPath)throw new Error('metadata_read_blocked');
  return actual.createReadStream(path,...rest);
 }};
});

const roots:string[]=[];
const sources=import('../src/session-search-sources.js');
afterEach(async()=>{fsState.blockedPath=undefined;vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

describe('persisted JSON metadata cache',()=>{
 it('evicts by total bytes through the public scan and keeps catalog fallback available',async()=>{
  const root=await mkdtemp(join(tmpdir(),'search-metadata-cache-'));roots.push(root);
  const home=join(root,'CODEX_HOME'),sessions=join(home,'sessions');await mkdir(sessions,{recursive:true});
  for(const [key,value] of Object.entries({CODEX_HOME:home,MINIMAX_CODE_SESSION_STORE:join(root,'minimax'),OPENCODE_DB_PATH:join(root,'opencode.db'),ZCODE_DB_PATH:join(root,'zcode.db'),HERMES_STATE_DB:join(root,'hermes.db'),CLAUDE_PROJECTS_DIR:join(root,'claude'),AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT:join(root,'browser')}))vi.stubEnv(key,value);
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id,title,cwd,rollout_path)');const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?)');
  const paths:string[]=[],titles:string[]=[];const titleBytes=1_000_000;
  for(let n=0;n<8;n++){
   const id=`session-${String(n).padStart(2,'0')}`,path=join(sessions,`${id}.jsonl`),title=`catalog-${n}-`+'x'.repeat(titleBytes);
   await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:`native-${n}`,cwd:'/work'}})+'\n');insert.run(id,title,'/work',path);paths.push(path);titles.push(title);
  }
  db.close();
  const scan=async()=>{const sessions:any[]=[],statuses:any[]=[];const {scanSessionSearchSources}=await sources;for await(const session of scanSessionSearchSources({onStatus:status=>statuses.push(status)}))if(session.harness==='codex')sessions.push(session);return {sessions,statuses};};
  const first=await scan();expect(first.sessions).toHaveLength(8);
  fsState.blockedPath=paths[0];
  const second=await scan();
  expect(second.sessions[0]).toMatchObject({nativeSessionId:'session-00',title:titles[0],contentUnavailable:true});
  expect(second.statuses.find(status=>status.harness==='codex')).toMatchObject({state:'partial',reason:'native_session_metadata_unavailable'});
 });
});
