import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const {reads}=vi.hoisted(()=>({reads:{} as Record<string,number>}));

// A spy at the level of database access: every row a statement hands out is
// counted per database and per bound session id.
vi.mock('node:sqlite',async()=>{
 const actual=await vi.importActual<typeof import('node:sqlite')>('node:sqlite');
 const paths=new WeakMap<object,string>();
 class TracedDatabaseSync extends actual.DatabaseSync{
  constructor(path:string,options?:any){super(path,options===undefined?{}:options);paths.set(this,String(path));}
  prepare(sql:string){
   const tracePath=paths.get(this)??'unknown';
   const statement=super.prepare(sql) as any;
   const text=sql.replace(/\s+/g,' ').trim();
   return new Proxy(statement,{
    get(target,prop){
     if(prop==='iterate')return (...args:any[])=>{const key=`${tracePath}::${text}::${JSON.stringify(args)}`;return (function*(){for(const row of target.iterate(...args)){reads[key]=(reads[key]??0)+1;yield row;}})();};
     if(prop==='get')return (...args:any[])=>{const key=`${tracePath}::${text}::${JSON.stringify(args)}`;const row=target.get(...args);if(row)reads[key]=(reads[key]??0)+1;return row;};
     const value=target[prop];return typeof value==='function'?value.bind(target):value;
    }});
  }
 }
 return {...actual,DatabaseSync:TracedDatabaseSync};
});

import {scanSessionSearchSources} from '../src/session-search-sources.js';
import {SessionSearchIndex} from '../src/session-search.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const key of Object.keys(reads))delete reads[key];await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

function countRows(path:string,match:(sql:string,args:string)=>boolean):number{
 let total=0;
 for(const [key,count] of Object.entries(reads)){
  if(!key.startsWith(`${path}::`))continue;
  const rest=key.slice(path.length+2);const split=rest.lastIndexOf('::');
  if(match(rest.slice(0,split),rest.slice(split+2)))total+=count;
 }
 return total;
}
/** Rows of the content columns: the messages and the parts the hash used to read. */
const contentRows=(path:string,session?:string)=>countRows(path,(sql,args)=>{
 const isContent=(sql.includes('FROM message')||sql.includes('FROM part'))&&sql.includes('data');
 return isContent&&(session===undefined||args.includes(`"${session}"`));
});
/** Rows of the catalog: the sessions are still visited on every cycle. */
const catalogRows=(path:string)=>countRows(path,sql=>sql.includes('FROM session ORDER BY id'));
/** Rows of the cheap key: the index-only aggregates. */
const envelopeRows=(path:string)=>countRows(path,sql=>sql.includes('count(*)'));

function readRevisions(path:string):Record<string,string>{
 const db=new DatabaseSync(path,{readOnly:true});
 try{const rows=db.prepare('SELECT native_id,revision FROM sessions').all() as any[];const out:Record<string,string>={};for(const row of rows)out[String(row.native_id)]=String(row.revision);return out;}finally{db.close();}
}

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'l72-session-search-'));
 roots.push(root);
 for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','HERMES_STATE_DB','CLAUDE_PROJECTS_DIR'])vi.stubEnv(key,join(root,key));
 const path=join(root,'OPENCODE_DB_PATH');
 const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT NOT NULL,directory TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
 CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,session_id TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
 CREATE INDEX part_session_idx ON part(session_id);
 CREATE INDEX part_message_id_id_idx ON part(message_id,id);`);
 const insertSession=db.prepare('INSERT INTO session VALUES(?,?,?,?,?)');
 const insertMessage=db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
 const insertPart=db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
 insertSession.run('ses-alpha','Alpha','/work',1,10);
 insertSession.run('ses-beta','Beta','/work',2,20);
 db.exec('BEGIN');
 for(let n=0;n<40;n++){
  insertMessage.run(`msg-alpha-${n}`,'ses-alpha',n,n,JSON.stringify({role:'user',text:`alpha-body-${n}`}));
  insertPart.run(`prt-alpha-${n}`,`msg-alpha-${n}`,'ses-alpha',n,n,JSON.stringify({type:'text',text:`alpha-needle-${n}`}));
  insertMessage.run(`msg-beta-${n}`,'ses-beta',n,n,JSON.stringify({role:'user',text:`beta-body-${n}`}));
  insertPart.run(`prt-beta-${n}`,`msg-beta-${n}`,'ses-beta',n,n,JSON.stringify({type:'text',text:`beta-needle-${n}`}));
 }
 db.exec('COMMIT');
 db.close();
 return {root,path};
}

describe('session search reads a native database incrementally',()=>{
 it('does not re-read an unchanged database, still indexes a changed record and finds it',async()=>{
  const {root,path}=await fixture();
  const indexPath=join(root,'index.sqlite');
  const index=new SessionSearchIndex(indexPath);
  try{
   // First cycle: the index is empty, so every record is read once for the hash
   // and once for the chunks.
   await index.scan(scanSessionSearchSources({}),[]);
   const firstContent=contentRows(path);
   expect(firstContent).toBeGreaterThan(0);
   const revisions=readRevisions(indexPath);
   expect(Object.keys(revisions).sort()).toEqual(['ses-alpha','ses-beta']);

   // Second cycle over the same database: no content row may be read at all,
   // the catalog and the cheap key are still visited.
   for(const key of Object.keys(reads))delete reads[key];
   await index.scan(scanSessionSearchSources({}),[]);
   expect(contentRows(path)).toBe(0);
   expect(catalogRows(path)).toBe(2);
   expect(envelopeRows(path)).toBeGreaterThan(0);
   expect(readRevisions(indexPath)).toEqual(revisions);

   // A changed record is still indexed, and only that session is re-read.
   const db=new DatabaseSync(path);
   db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('msg-beta-new','ses-beta',99,99,JSON.stringify({role:'user',text:'beta-body-new'}));
   db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('prt-beta-new','msg-beta-new','ses-beta',99,99,JSON.stringify({type:'text',text:'beta-needle-new'}));
   db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(21,'ses-beta');
   db.close();
   for(const key of Object.keys(reads))delete reads[key];
   await index.scan(scanSessionSearchSources({}),[]);
   const changed=readRevisions(indexPath);
   expect(changed['ses-beta']).not.toBe(revisions['ses-beta']);
   expect(changed['ses-alpha']).toBe(revisions['ses-alpha']);
   expect(contentRows(path,'ses-alpha')).toBe(0);
   expect(contentRows(path,'ses-beta')).toBeGreaterThan(0);

   // The changed session is searchable again.
   const found=index.search({query:'beta-needle-new'});
   expect(found.results.map(result=>result.nativeSessionId)).toContain('ses-beta');
   expect(index.search({query:'alpha-needle-7'}).results.map(result=>result.nativeSessionId)).toContain('ses-alpha');
  }finally{index.close();}
 });
 it('keeps the exact content hash when the source publishes no change key',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l72-session-search-'));
  roots.push(root);
  for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','CLAUDE_PROJECTS_DIR'])vi.stubEnv(key,join(root,key));
  const path=join(root,'hermes.db');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,cwd TEXT NOT NULL,message_count INTEGER DEFAULT 0);CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL);CREATE INDEX idx_messages_session ON messages(session_id,timestamp)');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h','title','/work',1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(1,'h','firstword',1);
  db.close();
  vi.stubEnv('HERMES_STATE_DB',path);
  const scan=async()=>{let found:any;for await(const session of scanSessionSearchSources()){found=session;for await(const _ of session.chunks){}}return found;};
  const before=await scan();
  const edit=new DatabaseSync(path);
  edit.prepare('UPDATE messages SET content=? WHERE id=1').run('otherword');
  edit.close();
  const after=await scan();
  expect(after.revision).not.toBe(before.revision);
 });
});
