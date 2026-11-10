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
 const isContent=(sql.includes('FROM message')||sql.includes('FROM session_message')||sql.includes('FROM part'))&&sql.includes('data');
 return isContent&&(session===undefined||args.includes(`"${session}"`));
});
/** Hermes content rows: the messages table the hash used to read. */
const hermesContentRows=(path:string,session?:string)=>countRows(path,(sql,args)=>{
 const isContent=sql.includes('FROM messages')&&sql.includes('content');
 return isContent&&(session===undefined||args.includes(`"${session}"`));
});
/** Rows of the catalog: the sessions are still visited on every cycle. */
const catalogRows=(path:string)=>countRows(path,sql=>sql.includes('FROM session ORDER BY id')||sql.includes('FROM sessions ORDER BY id'));
/** Rows of the cheap key: the index-only aggregates. */
const envelopeRows=(path:string)=>countRows(path,sql=>sql.includes('count(*)'));

function readRevisions(path:string):Record<string,string>{
 const db=new DatabaseSync(path,{readOnly:true});
 try{const rows=db.prepare('SELECT native_id,revision FROM sessions').all() as any[];const out:Record<string,string>={};for(const row of rows)out[String(row.native_id)]=String(row.revision);return out;}finally{db.close();}
}

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'l72-session-search-'));
 roots.push(root);
 for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','HERMES_STATE_DB','CLAUDE_PROJECTS_DIR','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT'])vi.stubEnv(key,join(root,key));
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
  const scan=async()=>{
   const receipts:any[]=[];
   await index.scan(scanSessionSearchSources({onStatus:status=>receipts.push(status)}),receipts);
   return index.status().sources.find(source=>source.harness==='opencode');
  };
  try{
   // First cycle: the index is empty, so every record is read once for the hash
   // and once for the chunks.
   const firstReceipt=await scan();
   expect(firstReceipt).toMatchObject({indexedTextSessions:2,indexedChunks:80,processedTextSessions:2,processedChunks:80});
   const firstSearch=index.search({query:'alpha-needle-7',harnesses:['opencode']}).results[0];
   expect(firstSearch).toMatchObject({nativeSessionId:'ses-alpha',chunkId:'prt-alpha-7'});
   const firstContent=contentRows(path);
   expect(firstContent).toBeGreaterThan(0);
   const revisions=readRevisions(indexPath);
   expect(Object.keys(revisions).sort()).toEqual(['ses-alpha','ses-beta']);

   // Second cycle over the same database: no content row may be read at all,
   // the catalog and the cheap key are still visited.
   for(const key of Object.keys(reads))delete reads[key];
   const unchangedReceipt=await scan();
   expect(contentRows(path)).toBe(0);
   expect(catalogRows(path)).toBe(2);
   expect(envelopeRows(path)).toBeGreaterThan(0);
   expect(readRevisions(indexPath)).toEqual(revisions);
   expect(unchangedReceipt).toMatchObject({indexedTextSessions:2,indexedChunks:80,processedTextSessions:0,processedChunks:0});
   expect(index.search({query:'alpha-needle-7',harnesses:['opencode']}).results[0]).toMatchObject({nativeSessionId:firstSearch!.nativeSessionId,chunkId:firstSearch!.chunkId,revision:firstSearch!.revision});

   // A changed record is still indexed, and only that session is re-read.
   const db=new DatabaseSync(path);
   db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('msg-beta-new','ses-beta',99,99,JSON.stringify({role:'user',text:'beta-body-new'}));
   db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('prt-beta-new','msg-beta-new','ses-beta',99,99,JSON.stringify({type:'text',text:'beta-needle-new'}));
   db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(21,'ses-beta');
   db.close();
   for(const key of Object.keys(reads))delete reads[key];
   const changedReceipt=await scan();
   expect(changedReceipt).toMatchObject({indexedTextSessions:2,indexedChunks:81,processedTextSessions:1,processedChunks:41});
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

 it('serves an unchanged hermes database from the index-only envelope and rehashes only on the resync scan',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l72-hermes-envelope-'));
  roots.push(root);
  for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','CLAUDE_PROJECTS_DIR','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT'])vi.stubEnv(key,join(root,key));
  const path=join(root,'hermes.db');
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,cwd TEXT NOT NULL,message_count INTEGER DEFAULT 0);CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL);CREATE INDEX idx_messages_session ON messages(session_id,timestamp)');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h-one','One','/work',2);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h-two','Two','/work',1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(1,'h-one','firstword',1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(2,'h-one','secondword',2);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(3,'h-two','twoword',1);
  db.close();
  vi.stubEnv('HERMES_STATE_DB',path);
  const indexPath=join(root,'index.sqlite');
  const index=new SessionSearchIndex(indexPath);
  const scan=async()=>{const receipts:any[]=[];await index.scan(scanSessionSearchSources({onStatus:status=>receipts.push(status)}),receipts).catch(()=>undefined);return receipts;};
  try{
  await scan();
  expect(hermesContentRows(path)).toBeGreaterThan(0);

  // Second cycle with an untouched database: the exact snapshot shortcut
  // serves the cached digests, no message content row is read at all.
  for(const key of Object.keys(reads))delete reads[key];
  await scan();
  expect(hermesContentRows(path)).toBe(0);

  // A same-size in-place edit is invisible to the envelope: the stamp moves
  // (so the exact shortcut no longer applies), the index-only envelope runs,
  // matches and keeps the previous revision, and the forced resync scan
  // rehashes and detects the edit. This is the bounded staleness contract.
  const edit=new DatabaseSync(path);edit.exec('PRAGMA busy_timeout=3000;');
  edit.prepare('UPDATE messages SET content=? WHERE id=1').run('otherword');
  edit.close();
  for(const key of Object.keys(reads))delete reads[key];
  await scan();
  expect(hermesContentRows(path)).toBe(0);
  expect(envelopeRows(path)).toBeGreaterThan(0);
  vi.stubEnv('AGENT_HERDER_SESSION_SEARCH_RESYNC_SCANS','1');
  const revisionsBefore=readRevisions(indexPath);
  await scan();
  expect(hermesContentRows(path)).toBeGreaterThan(0);
  const revisionsAfter=readRevisions(indexPath);
  expect(revisionsAfter['h-one']).not.toBe(revisionsBefore['h-one']);
  expect(revisionsAfter['h-two']).toBe(revisionsBefore['h-two']);
  }finally{index.close();}
 });

 it('keeps the hermes digest cache across a changed-source scan of a live database',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l72-hermes-live-'));
  roots.push(root);
  for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','CLAUDE_PROJECTS_DIR','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT'])vi.stubEnv(key,join(root,key));
  const path=join(root,'hermes.db');
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,cwd TEXT NOT NULL,message_count INTEGER DEFAULT 0);CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL);CREATE INDEX idx_messages_session ON messages(session_id,timestamp)');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h-one','One','/work',1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(1,'h-one','firstword',1);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('h-two','Two','/work',1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(2,'h-two','twoword',1);
  db.close();
  vi.stubEnv('HERMES_STATE_DB',path);
  const indexPath=join(root,'index.sqlite');
  const index=new SessionSearchIndex(indexPath);
  const consume=async(onHermes?:()=>void)=>{const receipts:any[]=[];let hooked=false;
   const wrapped=async function*(){for await(const session of scanSessionSearchSources({onStatus:status=>receipts.push(status)})){if(!hooked&&session.harness==='hermes'){hooked=true;onHermes?.();}yield session;}};
   try{await index.scan(wrapped(),receipts);}catch{/* the changed-source throw is expected */}
   return receipts;};
  try{
  await consume();
  expect(hermesContentRows(path)).toBeGreaterThan(0);

  // The database is written to while the scan is iterating: the source must
  // report a changed-source partial receipt instead of a complete snapshot.
  const live=await consume(()=>{const writer=new DatabaseSync(path);writer.exec('PRAGMA busy_timeout=3000;');writer.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(3,'h-one','liveword',9);writer.close();});
  const hermesReceipt=live.find(receipt=>receipt.harness==='hermes');
  expect(hermesReceipt).toMatchObject({state:'partial',reason:'native_source_changed_during_scan'});

  // The cache written before the changed-source throw must survive: the next
  // quiet scan rehashes only the genuinely changed session (h-one) and reads
  // no message content for the untouched one (h-two).
  for(const key of Object.keys(reads))delete reads[key];
  const quiet=await consume();
  expect(quiet.find(receipt=>receipt.harness==='hermes')).toMatchObject({state:'complete'});
  expect(hermesContentRows(path,'h-two')).toBe(0);
  expect(hermesContentRows(path,'h-one')).toBeGreaterThan(0);
  }finally{index.close();}
 });

 it('serves an unchanged opencode v2 store from index-only envelopes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l72-opencode-v2-'));
  roots.push(root);
  for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','ZCODE_DB_PATH','HERMES_STATE_DB','CLAUDE_PROJECTS_DIR','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT'])vi.stubEnv(key,join(root,key));
  const path=join(root,'opencode.db');
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,directory TEXT NOT NULL,title TEXT);
 CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
 CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id,time_created,id);`);
  const insertSession=db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?)');
  const insertMessage=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)');
  insertSession.run('ses-v2-one','p1','/work','V2 One');
  for(let n=0;n<20;n++)insertMessage.run(`m-${n}`,'ses-v2-one','message',n,n,n,JSON.stringify({text:`v2-needle-${n}`}));
  db.close();
  vi.stubEnv('OPENCODE_DB_PATH',path);
  const indexPath=join(root,'index.sqlite');
  const index=new SessionSearchIndex(indexPath);
  const consume=async()=>{const receipts:any[]=[];await index.scan(scanSessionSearchSources({onStatus:status=>receipts.push(status)}),receipts).catch(()=>undefined);return receipts;};
  try{
  await consume();
  expect(contentRows(path)).toBeGreaterThan(0);

  // Second cycle over the unchanged store: the envelope answers from the
  // (session_id,seq) and (session_id,time_created,id) indexes and no message
  // data row is read for the hash.
  for(const key of Object.keys(reads))delete reads[key];
  await consume();
  expect(contentRows(path)).toBe(0);
  expect(envelopeRows(path)).toBeGreaterThan(0);
  const revisionsBefore=readRevisions(indexPath);

  // A new message changes the envelope and only then is the session rehashed.
  const writer=new DatabaseSync(path);writer.exec('PRAGMA busy_timeout=3000;');
  writer.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('m-new','ses-v2-one','message',99,99,99,JSON.stringify({text:'v2-needle-new'}));
  writer.close();
  for(const key of Object.keys(reads))delete reads[key];
  await consume();
  expect(contentRows(path)).toBeGreaterThan(0);
  const revisionsAfter=readRevisions(indexPath);
  expect(revisionsAfter['ses-v2-one']).not.toBe(revisionsBefore['ses-v2-one']);
  }finally{index.close();}
 });
});
