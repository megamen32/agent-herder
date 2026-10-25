import {randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {homedir,hostname} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldToConsumers} from 'node:timers/promises';

/** A disposable mirror. Never point this at a native harness database. */
export const SESSION_SEARCH_PATH=process.env.AGENT_HERDER_SESSION_SEARCH_DB??join(homedir(),'.local/state/agent-herder/session-search/index.sqlite');
export interface SearchSessionInput {harness:string;nativeSessionId:string;title:string;cwd:string;revision:string;chunks:AsyncIterable<{id:string;text:string}>;contentUnavailable?:boolean}
export interface SearchSourceReceipt {harness:string;source:string;state:'complete'|'partial'|'unavailable'|'unsupported';sessions:number;scanId?:string;catalogSessions?:number;textSessions?:number;missingContent?:number;chunks?:number;processedTextSessions?:number;processedChunks?:number;indexedTextSessions?:number;indexedChunks?:number;reason?:string}
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
 private hasRunScanId=false;
 constructor(readonly path=SESSION_SEARCH_PATH,readonly hostId=hostname(),options:{readOnly?:boolean}={}){
  if(!options.readOnly)mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(path,{readOnly:options.readOnly===true});
  const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if(tables.length&&!tables.some(row=>row.name==='search_schema')){this.db.close();throw new Error('search_database_not_owned');}
  if(tables.length&&(this.db.prepare('SELECT version FROM search_schema').get() as {version:number})?.version!==1){this.db.close();throw new Error('search_schema_incompatible');}
  if(options.readOnly){
   if(!tables.length){this.db.close();throw new Error('search_index_not_ready');}
   this.hasRunScanId=(this.db.prepare('PRAGMA table_info(search_run)').all() as Array<{name:string}>).some(column=>column.name==='scan_id');
   this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
   return;
  }
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
   CREATE TABLE IF NOT EXISTS search_run(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,updated_at TEXT NOT NULL,processed INTEGER NOT NULL,error TEXT,scan_id TEXT);
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
  if(!(this.db.prepare('PRAGMA table_info(search_run)').all() as Array<{name:string}>).some(column=>column.name==='scan_id'))this.db.exec('ALTER TABLE search_run ADD COLUMN scan_id TEXT');
  this.hasRunScanId=true;
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
 /** Owner-only recovery after an interrupted generation; never a query action. */
 pruneInterruptedGenerations(){this.db.exec('DELETE FROM chunks WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.harness=chunks.harness AND s.native_id=chunks.native_id AND s.generation=chunks.generation)');}
 status(){
  const run=this.db.prepare(`SELECT status,updated_at AS updatedAt,processed,error${this.hasRunScanId?',scan_id AS scanId':''} FROM search_run WHERE id=1`).get();
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
 finishSource(receipt:SearchSourceReceipt,scan:string,options:{pruneComplete?:boolean}={}){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(receipt.state==='complete'&&options.pruneComplete!==false){
    this.db.prepare('DELETE FROM chunks WHERE harness=? AND native_id IN (SELECT native_id FROM sessions WHERE harness=? AND scan<>?)').run(receipt.harness,receipt.harness,scan);
    this.db.prepare('DELETE FROM sessions WHERE harness=? AND scan<>?').run(receipt.harness,scan);
   }
   const indexed=this.db.prepare("SELECT count(DISTINCT native_id) AS textSessions,count(*) AS chunks FROM chunks WHERE harness=? AND length(text)>0").get(receipt.harness) as {textSessions:number;chunks:number};
   const recorded={...receipt,scanId:scan,processedTextSessions:receipt.textSessions??0,processedChunks:receipt.chunks??0,indexedTextSessions:Number(indexed?.textSessions??0),indexedChunks:Number(indexed?.chunks??0),observedAt:new Date().toISOString()};
   this.db.prepare('INSERT INTO sources VALUES(?,?) ON CONFLICT(harness) DO UPDATE SET receipt=excluded.receipt').run(receipt.harness,JSON.stringify(recorded));
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async scan(sessions:AsyncIterable<SearchSessionInput>,receipts:SearchSourceReceipt[]):Promise<void>{
  if(this.ingesting)throw new Error('search_indexing_busy');
  this.ingesting=true;const scan=randomUUID();let processed=0;
  const record=(status:string,error:string|null=null)=>this.db.prepare('INSERT INTO search_run(id,status,updated_at,processed,error,scan_id) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,processed=excluded.processed,error=excluded.error,scan_id=excluded.scan_id').run(status,new Date().toISOString(),processed,error,scan);
  record('running');
  try{
   const failures=new Map<string,number>();
   let recorded=0;
   const withIngestFailures=(receipt:SearchSourceReceipt)=>failures.has(receipt.harness)?{...receipt,state:'partial' as const,reason:`session_content_read_failed:${failures.get(receipt.harness)}`} : receipt;
   const publishAvailableReceipts=()=>{for(;recorded<receipts.length;recorded++)this.finishSource(withIngestFailures(receipts[recorded]),scan,{pruneComplete:false});};
   for await(const session of sessions){
    try{await this.ingest(session,scan);}catch{failures.set(session.harness,(failures.get(session.harness)??0)+1);}
    processed++;record('running');publishAvailableReceipts();if(processed%16===0)await yieldToConsumers();
   }
   // Only normal iterator exhaustion proves a complete source snapshot safe to prune.
   for(const receipt of receipts)this.finishSource(withIngestFailures(receipt),scan,{pruneComplete:true});
   record('complete');
  }
  catch(error){
   // A source iterator can fail outside the per-session catch. Keep its prior
   // indexed rows and make any provisional complete receipt explicitly partial.
   for(const receipt of receipts){
    const failed:SearchSourceReceipt=receipt.state==='complete'?{...receipt,state:'partial',reason:'source_scan_failed'}:receipt;
    this.finishSource(failed,scan,{pruneComplete:false});
   }
   record('error',error instanceof Error?error.message.slice(0,160):'source_scan_failed');throw error;
  }
  finally{this.ingesting=false;}
 }
 search(input:SessionSearchQuery){
  const started=performance.now(),match=lexicalMatch(input.query),limit=input.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('search_limit_invalid');
  const harnesses=input.harnesses??[];
  if(harnesses.length>32||harnesses.some(h=>!h||h.length>64))throw new Error('search_harness_invalid');
  // The hidden FTS rank column gives SQLite its indexed rank-order iterator.
  // Compute snippets only for winning sessions, not every matching message.
  const rows=this.db.prepare(`SELECT s.harness,s.native_id,s.title,s.cwd,s.revision,c.id,c.chunk_id,chunks_fts.rank rank FROM chunks_fts CROSS JOIN chunks c ON c.id=chunks_fts.rowid CROSS JOIN sessions s ON s.harness=c.harness AND s.native_id=c.native_id AND s.generation=c.generation WHERE chunks_fts MATCH ? AND rank MATCH 'bm25(4.0,1.0)' ${harnesses.length?'AND s.harness IN ('+harnesses.map(()=>'?').join(',')+')':''} ORDER BY rank`).iterate(match,...harnesses);
  const snippet=this.db.prepare("SELECT snippet(chunks_fts,1,'','', ' … ',24) snippet FROM chunks_fts WHERE rowid=? AND chunks_fts MATCH ?");
  const results=[];const seen=new Set<string>();
  for(const row of rows){const key=JSON.stringify([row.harness,row.native_id]);if(seen.has(key))continue;seen.add(key);results.push({hostId:this.hostId,harness:row.harness,nativeSessionId:row.native_id,title:row.title,cwd:row.cwd,revision:row.revision,chunkId:row.chunk_id,snippet:snippet.get(row.id,match)?.snippet??'',rank:row.rank});if(results.length>=limit)break;}
  const status=this.status();
  const sources=new Map(status.sources.map((source:SearchSourceReceipt)=>[source.harness,source]));
  const requested=harnesses.length?[...new Set(harnesses)]:[...sources.keys()];
  const runScanId=typeof status.run?.scanId==='string'?status.run.scanId:undefined;
  const partial=requested.length===0||requested.some(harness=>{
   const source=sources.get(harness);
   if(!source||source.state!=='complete')return true;
   // A receipt from an older snapshot cannot certify a selected source while
   // a new run is pending, nor after a run with an identifiable scan completes.
   if((status.run?.status==='running'||status.run?.status==='error')&&!runScanId)return true;
   return Boolean(runScanId&&source.scanId!==runScanId);
  });
  return {hostId:this.hostId,results,index:status,partial,elapsedMs:Math.round((performance.now()-started)*100)/100};
 }
}
