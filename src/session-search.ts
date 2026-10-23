import {randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {homedir,hostname} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldToConsumers} from 'node:timers/promises';

/** A disposable mirror. Never point this at a native harness database. */
export const SESSION_SEARCH_PATH=process.env.AGENT_HERDER_SESSION_SEARCH_DB??join(homedir(),'.local/state/agent-herder/session-search/index.sqlite');
export interface SearchSessionInput {harness:string;nativeSessionId:string;title:string;cwd:string;revision:string;chunks:AsyncIterable<{id:string;text:string}>;contentUnavailable?:boolean}
export interface SearchSourceReceipt {harness:string;source:string;state:'complete'|'partial'|'unavailable'|'unsupported';sessions:number;catalogSessions?:number;textSessions?:number;missingContent?:number;chunks?:number;reason?:string}
export interface SessionSearchQuery {query:string;harnesses?:string[];limit?:number}

/** Quote user words: the public API accepts words, never raw FTS operators. */
export function lexicalMatch(query:string):string {
 const words=query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)??[];
 if(!words.length||words.length>64||query.length>1000)throw new Error('search_query_invalid');
 return words.map(word=>'"'+word.replaceAll('"','""')+'"').join(' AND ');
}

export class SessionSearchIndex {
 private readonly db:DatabaseSync;
 private ingesting=false;
 constructor(readonly path=SESSION_SEARCH_PATH,readonly hostId=hostname()){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(path);
  const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if(tables.length&&!tables.some(row=>row.name==='search_schema')){this.db.close();throw new Error('search_database_not_owned');}
  if(tables.length&&(this.db.prepare('SELECT version FROM search_schema').get() as {version:number})?.version!==1){this.db.close();throw new Error('search_schema_incompatible');}
  chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS search_schema(version INTEGER NOT NULL);
   INSERT INTO search_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM search_schema);
   CREATE TABLE IF NOT EXISTS sessions(harness TEXT NOT NULL,native_id TEXT NOT NULL,title TEXT NOT NULL,cwd TEXT NOT NULL,revision TEXT NOT NULL,generation TEXT NOT NULL,scan TEXT NOT NULL,PRIMARY KEY(harness,native_id));
   CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,harness TEXT NOT NULL,native_id TEXT NOT NULL,generation TEXT NOT NULL,chunk_id TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS chunks_session ON chunks(harness,native_id,generation);
   CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title,text,content='chunks',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,title,text) VALUES(new.id,new.title,new.text); END;
   CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,text) VALUES('delete',old.id,old.title,old.text); END;
   CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,text) VALUES('delete',old.id,old.title,old.text); INSERT INTO chunks_fts(rowid,title,text) VALUES(new.id,new.title,new.text); END;
   CREATE TABLE IF NOT EXISTS sources(harness TEXT PRIMARY KEY,receipt TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS search_run(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,updated_at TEXT NOT NULL,processed INTEGER NOT NULL,error TEXT);
   CREATE TABLE IF NOT EXISTS search_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL);
   BEGIN IMMEDIATE;
   CREATE TABLE IF NOT EXISTS search_counts(name TEXT PRIMARY KEY,n INTEGER NOT NULL);
   INSERT OR IGNORE INTO search_counts SELECT 'sessions',count(*) FROM sessions;
   INSERT OR IGNORE INTO search_counts SELECT 'chunks',count(*) FROM chunks;
   CREATE TRIGGER IF NOT EXISTS search_count_s_ai AFTER INSERT ON sessions BEGIN UPDATE search_counts SET n=n+1 WHERE name='sessions'; END;
   CREATE TRIGGER IF NOT EXISTS search_count_s_ad AFTER DELETE ON sessions BEGIN UPDATE search_counts SET n=n-1 WHERE name='sessions'; END;
   CREATE TRIGGER IF NOT EXISTS search_count_c_ai AFTER INSERT ON chunks BEGIN UPDATE search_counts SET n=n+1 WHERE name='chunks'; END;
   CREATE TRIGGER IF NOT EXISTS search_count_c_ad AFTER DELETE ON chunks BEGIN UPDATE search_counts SET n=n-1 WHERE name='chunks'; END;
   COMMIT;
  `);
  if((this.db.prepare('SELECT version FROM search_schema').get() as {version:number}).version!==1)throw new Error('search_schema_incompatible');
 }
 close(){this.db.close();}
 claimOwner(token:string):boolean{
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const previous=this.db.prepare('SELECT pid FROM search_owner WHERE id=1').get();
   if(previous){let alive=true;try{process.kill(Number(previous.pid),0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}if(alive){this.db.exec('COMMIT');return false;}}
   this.db.prepare('INSERT INTO search_owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid,token);
   this.db.exec('COMMIT');return true;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 releaseOwner(token:string){this.db.prepare('DELETE FROM search_owner WHERE id=1 AND token=?').run(token);}
 status(){
  const run=this.db.prepare('SELECT status,updated_at AS updatedAt,processed,error FROM search_run WHERE id=1').get();
  const counts=Object.fromEntries(this.db.prepare('SELECT name,n FROM search_counts').all().map(row=>[String(row.name),Number(row.n)]));
  const indexing=this.ingesting||run?.status==='running';
  return {hostId:this.hostId,sessions:counts.sessions??0,chunks:counts.chunks??0,chunksIncludeStaging:indexing,indexing,run:run??null,sources:this.db.prepare('SELECT receipt FROM sources ORDER BY harness').all().map(row=>JSON.parse(String(row.receipt)))};
 }
 /** Staged generations keep the last complete transcript visible on failed reads. */
 async ingest(session:SearchSessionInput,scan:string):Promise<boolean>{
  const old=this.db.prepare('SELECT revision,title,cwd FROM sessions WHERE harness=? AND native_id=?').get(session.harness,session.nativeSessionId);
  if(old&&session.contentUnavailable){
   this.db.exec('BEGIN IMMEDIATE');try{
    this.db.prepare('UPDATE sessions SET scan=?,title=?,cwd=? WHERE harness=? AND native_id=?').run(scan,session.title,session.cwd,session.harness,session.nativeSessionId);
    if(old.title!==session.title)this.db.prepare('UPDATE chunks SET title=? WHERE harness=? AND native_id=?').run(session.title,session.harness,session.nativeSessionId);
    this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   return false;
  }
  if(old?.revision===session.revision&&old?.title===session.title&&old?.cwd===session.cwd){this.db.prepare('UPDATE sessions SET scan=? WHERE harness=? AND native_id=?').run(scan,session.harness,session.nativeSessionId);return false;}
  const generation=randomUUID();
  const insert=this.db.prepare('INSERT INTO chunks(harness,native_id,generation,chunk_id,title,text) VALUES(?,?,?,?,?,?)');
  try{
   // A title-only session remains searchable even with no messages.
   insert.run(session.harness,session.nativeSessionId,generation,'title',session.title,'');
   let chunkCount=0;
   for await(const chunk of session.chunks){insert.run(session.harness,session.nativeSessionId,generation,chunk.id,session.title,chunk.text);if(++chunkCount%128===0)await yieldToConsumers();}
   this.db.exec('BEGIN IMMEDIATE');
   try{
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(harness,native_id) DO UPDATE SET title=excluded.title,cwd=excluded.cwd,revision=excluded.revision,generation=excluded.generation,scan=excluded.scan').run(session.harness,session.nativeSessionId,session.title,session.cwd,session.revision,generation,scan);
    this.db.prepare('DELETE FROM chunks WHERE harness=? AND native_id=? AND generation<>?').run(session.harness,session.nativeSessionId,generation);
    this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   return true;
  }catch(error){this.db.prepare('DELETE FROM chunks WHERE harness=? AND native_id=? AND generation=?').run(session.harness,session.nativeSessionId,generation);throw error;}
 }
 /** Only successful exhaustive sources may remove missing sessions. */
 finishSource(receipt:SearchSourceReceipt,scan:string){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(receipt.state==='complete'){
    this.db.prepare('DELETE FROM chunks WHERE harness=? AND native_id IN (SELECT native_id FROM sessions WHERE harness=? AND scan<>?)').run(receipt.harness,receipt.harness,scan);
    this.db.prepare('DELETE FROM sessions WHERE harness=? AND scan<>?').run(receipt.harness,scan);
   }
   this.db.prepare('INSERT INTO sources VALUES(?,?) ON CONFLICT(harness) DO UPDATE SET receipt=excluded.receipt').run(receipt.harness,JSON.stringify({...receipt,observedAt:new Date().toISOString()}));
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async scan(sessions:AsyncIterable<SearchSessionInput>,receipts:SearchSourceReceipt[]):Promise<void>{
  if(this.ingesting)throw new Error('search_indexing_busy');
  this.ingesting=true;const scan=randomUUID();let processed=0;
  const record=(status:string,error:string|null=null)=>this.db.prepare('INSERT INTO search_run VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,processed=excluded.processed,error=excluded.error').run(status,new Date().toISOString(),processed,error);
  record('running');
  try{
   const failures=new Map<string,number>();
   for await(const session of sessions){
    try{await this.ingest(session,scan);}catch{failures.set(session.harness,(failures.get(session.harness)??0)+1);}
    processed++;record('running');if(processed%16===0)await yieldToConsumers();
   }
   for(const receipt of receipts)this.finishSource(failures.has(receipt.harness)?{...receipt,state:'partial',reason:`session_content_read_failed:${failures.get(receipt.harness)}`} : receipt,scan);
   record('complete');
  }
  catch(error){record('error',error instanceof Error?error.message.slice(0,160):'source_scan_failed');throw error;}
  finally{this.ingesting=false;}
 }
 search(input:SessionSearchQuery){
  const started=performance.now(),match=lexicalMatch(input.query),limit=input.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('search_limit_invalid');
  const harnesses=input.harnesses??[];
  if(harnesses.length>32||harnesses.some(h=>!h||h.length>64))throw new Error('search_harness_invalid');
  // Materialize rank before grouping: FTS auxiliary functions cannot run inside
  // aggregate contexts. SQLite's min() selects the matching chunk's bare columns.
  const rows=this.db.prepare(`WITH candidates AS MATERIALIZED (SELECT rowid,bm25(chunks_fts,4.0,1.0) rank FROM chunks_fts WHERE chunks_fts MATCH ?) SELECT s.harness,s.native_id,s.title,s.cwd,s.revision,c.id,c.chunk_id,min(m.rank) rank FROM candidates m JOIN chunks c ON c.id=m.rowid JOIN sessions s ON s.harness=c.harness AND s.native_id=c.native_id AND s.generation=c.generation ${harnesses.length?'WHERE s.harness IN ('+harnesses.map(()=>'?').join(',')+')':''} GROUP BY s.harness,s.native_id ORDER BY rank LIMIT ?`).all(match,...harnesses,limit);
  const snippet=this.db.prepare("SELECT snippet(chunks_fts,1,'','', ' … ',24) snippet FROM chunks_fts WHERE rowid=? AND chunks_fts MATCH ?");
  const results=rows.map(row=>({hostId:this.hostId,harness:row.harness,nativeSessionId:row.native_id,title:row.title,cwd:row.cwd,revision:row.revision,chunkId:row.chunk_id,snippet:snippet.get(row.id,match)?.snippet??'',rank:row.rank}));
  const status=this.status();
  return {hostId:this.hostId,results,index:status,partial:status.sources.length===0||status.indexing||status.run?.status==='error'||status.sources.some((source:SearchSourceReceipt)=>source.state!=='complete'),elapsedMs:Math.round((performance.now()-started)*100)/100};
 }
}
