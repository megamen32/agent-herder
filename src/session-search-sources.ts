import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir,readFile,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export interface SearchSourceSession {harness:string;nativeSessionId:string;title:string;cwd:string;revision:string;chunks:AsyncIterable<{id:string;text:string}>;contentUnavailable?:boolean}
export interface SearchSourceStatus {harness:string;source:string;state:'complete'|'partial'|'unavailable'|'unsupported';sessions:number;reason?:string;catalogSessions?:number;textSessions?:number;missingContent?:number;chunks?:number}
type Options={signal?:AbortSignal;onStatus?:(status:SearchSourceStatus)=>void;onIssue?:(reason:string)=>void};
const str=(v:unknown):string=>typeof v==='string'?v:'';
function text(v:any):string {if(typeof v==='string')return v;if(Array.isArray(v))return v.map(text).filter(Boolean).join('\n');return v&&typeof v==='object'?str(v.text)||str(v.content)||'':'';}
function check(signal?:AbortSignal){signal?.throwIfAborted();}
async function stamp(path:string):Promise<string>{const s=await stat(path);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}
async function dbStamp(path:string){return `${await stamp(path)}:${await stamp(path+'-wal').catch(()=>'-')}`;}
async function* files(root:string,signal?:AbortSignal):AsyncGenerator<string>{
 check(signal);for(const e of await readdir(root,{withFileTypes:true})){check(signal);const p=join(root,e.name);if(e.isDirectory())yield* files(p,signal);else if(e.isFile())yield p;}
}
async function* records(path:string,signal?:AbortSignal):AsyncGenerator<{row:any;line:number}>{
 const stream=createReadStream(path,{encoding:'utf8'});const input=createInterface({input:stream,crlfDelay:Infinity});let line=0;
 const abort=()=>stream.destroy(new Error('source_scan_aborted'));signal?.addEventListener('abort',abort,{once:true});
 try{for await(const value of input){check(signal);line++;if(!value.trim())continue;let row:any;try{row=JSON.parse(value);}catch{throw new Error(`source_json_invalid_line_${line}`);}yield {row,line};}}
 finally{signal?.removeEventListener('abort',abort);input.close();stream.destroy();}
}
function jsonMessage(row:any,harness:string):{id:string;text:string;role:string}|undefined{
 if(harness==='codex'){if(row.type!=='response_item'||row.payload?.type!=='message')return;const p=row.payload;return {id:str(p.id),text:text(p.content),role:str(p.role)};}
 const p=row.message??row;return {id:str(row.message_id)||str(row.uuid)||str(p.id),text:text(p.content),role:str(p.role)};
}
async function* jsonChunks(path:string,harness:string,signal?:AbortSignal){for await(const {row,line} of records(path,signal)){const message=jsonMessage(row,harness);if(message?.text)yield {id:message.id||`line:${line}`,text:message.text};}}
const MAX_JSON_METADATA_CACHE=50_000;
type JsonSessionMetadata={nativeSessionId:string;title:string;cwd:string;revision:string};
type JsonMetadataCacheEntry={stamp:string;catalogId:string;catalogTitle:string;catalogCwd:string;metadata:JsonSessionMetadata};
const jsonMetadataCache=new Map<string,JsonMetadataCacheEntry>();
async function jsonSession(path:string,harness:string,options:Options,catalog?:any):Promise<SearchSourceSession>{
 const catalogId=str(catalog?.id),catalogTitle=str(catalog?.title),catalogCwd=str(catalog?.cwd);
 const revision=await stamp(path);
 const cacheKey=JSON.stringify([harness,path]);
 const cached=jsonMetadataCache.get(cacheKey);
 if(cached&&cached.stamp===revision&&cached.catalogId===catalogId&&cached.catalogTitle===catalogTitle&&cached.catalogCwd===catalogCwd){
  return {...cached.metadata,harness,chunks:jsonChunks(path,harness,options.signal)};
 }
 let id=catalogId||basename(path).replace(/\.jsonl$/,'');let title=catalogTitle,cwd=catalogCwd;
 let seenCodexMeta=false;
 for await(const {row} of records(path,options.signal)){
  if(harness==='codex'&&row.type==='session_meta'){
   if(!seenCodexMeta){
    seenCodexMeta=true;
    id=catalogId||str(row.payload?.id)||str(row.payload?.session_id)||id;
    title=catalogTitle||str(row.payload?.title)||title;
    cwd=catalogCwd||str(row.payload?.cwd)||cwd;
   }
  }
  if(harness==='claude'){id=str(row.sessionId)||id;cwd=str(row.cwd)||cwd;}
  const m=jsonMessage(row,harness);if(m?.role==='user'&&m.text){title||=m.text.replace(/\s+/g,' ').slice(0,160);break;}
 }
 if(await stamp(path)!==revision)throw new Error('source_changed_during_metadata_parse');
 const metadata={nativeSessionId:id,title:title||id,cwd,revision:`${revision}:${title}:${cwd}`};
 if(!cached&&jsonMetadataCache.size>=MAX_JSON_METADATA_CACHE){const oldest=jsonMetadataCache.keys().next().value;if(oldest!==undefined)jsonMetadataCache.delete(oldest);}
 jsonMetadataCache.set(cacheKey,{stamp:revision,catalogId,catalogTitle,catalogCwd,metadata});
 return {...metadata,harness,chunks:jsonChunks(path,harness,options.signal)};
}
async function safeJsonSession(path:string,harness:string,options:Options,catalog?:any):Promise<SearchSourceSession|undefined>{
 try{return await jsonSession(path,harness,options,catalog);}catch(error){check(options.signal);options.onIssue?.('native_session_metadata_unavailable');if(catalog?.id)return {harness,nativeSessionId:str(catalog.id),title:str(catalog.title)||str(catalog.id),cwd:str(catalog.cwd),revision:JSON.stringify(catalog),contentUnavailable:true,chunks:(async function*(){})()};return undefined;}
}
async function* codex(options:Options):AsyncGenerator<SearchSourceSession>{
 const home=process.env.CODEX_HOME||join(homedir(),'.codex');const seen=new Set<string>(),seenNativeIds=new Set<string>();const localFiles:string[]=[];for(const name of ['sessions','archived_sessions']){const root=join(home,name);if(await stat(root).catch(()=>null))for await(const path of files(root,options.signal))if(path.endsWith('.jsonl'))localFiles.push(path);}const byName=new Map(localFiles.map(path=>[basename(path),path]));const dbPath=process.env.CODEX_STATE_DB||join(home,'state_5.sqlite');
 const firstForNativeId=(session:SearchSourceSession)=>{const id=session.nativeSessionId;if(!id)return true;if(seenNativeIds.has(id))return false;seenNativeIds.add(id);return true;};
 if(await stat(dbPath).catch(()=>null)){
  const db=new DatabaseSync(dbPath,{readOnly:true});try{db.exec('PRAGMA temp_store=MEMORY; PRAGMA query_only=ON; PRAGMA busy_timeout=1000');for(const row of db.prepare('SELECT id,title,cwd,rollout_path FROM threads ORDER BY id').iterate() as Iterable<any>){check(options.signal);let p=str(row.rollout_path);if(!p)continue;if(!await stat(p).catch(()=>null))p=byName.get(basename(p))||p;seen.add(p);if(!await stat(p).catch(()=>null)){options.onIssue?.('native_rollout_file_missing');const session:SearchSourceSession={harness:'codex',nativeSessionId:str(row.id),title:str(row.title)||str(row.id),cwd:str(row.cwd),revision:JSON.stringify(row),contentUnavailable:true,chunks:(async function*(){})()};if(firstForNativeId(session))yield session;continue;}const session=await safeJsonSession(p,'codex',options,row);if(session&&firstForNativeId(session))yield session;}}finally{db.close();}
 }
 for(const p of localFiles){if(!seen.has(p)){const session=await safeJsonSession(p,'codex',options);if(session&&firstForNativeId(session))yield session;}}
 if(!localFiles.length&&!seen.size)throw new Error('codex_session_sources_missing');
}
async function* minimax(options:Options):AsyncGenerator<SearchSourceSession>{
 const root=process.env.MINIMAX_CODE_SESSION_STORE||join(homedir(),'.minimax/v2/sessions');
 for await(const p of files(root,options.signal)){
  if(basename(p)!=='manifest.json')continue;try{const manifest=JSON.parse(await readFile(p,'utf8'));const dir=p.slice(0,-'/manifest.json'.length);const id=str(manifest.sessionId);if(!id)throw new Error('minimax_manifest_identity_missing');
  const messagePath=join(dir,'messages.jsonl');let title=id,cwd='';let revision=await stamp(p);const exists=await stat(messagePath).catch(()=>null);if(!exists)options.onIssue?.('native_message_file_missing');
  if(exists){const session=await jsonSession(messagePath,'minimax-code',options);title=session.title==='messages'?id:session.title;revision+=':'+session.revision;}
  const snapshot=join(dir,'snapshot.json');if(await stat(snapshot).catch(()=>null)){const value=JSON.parse(await readFile(snapshot,'utf8'));title=str(value.record?.title)||title;cwd=str(value.record?.workspaceDir);revision+=':'+await stamp(snapshot);}
  yield {harness:'minimax-code',nativeSessionId:id,title,cwd,revision,...(!exists?{contentUnavailable:true}:{}),chunks:exists?jsonChunks(messagePath,'minimax-code',options.signal):(async function*(){})()};
  }catch(error){check(options.signal);options.onIssue?.('native_session_metadata_unavailable');}
 }
}
/** Column names of a native table; an absent table simply has no columns. */
function columnsOf(db:DatabaseSync,table:string):Set<string>{
 try{const rows=db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Iterable<any>;return new Set(Array.from(rows,row=>str(row.name)).filter(Boolean));}catch{return new Set();}
}
function quoteIdentifier(value:string):string{return `"${value.replaceAll('"','""')}"`;}
/** Prefer a non-partial composite part lookup index; fall back to message_id-leading. */
function partLookupIndexOf(db:DatabaseSync,table:string):string|undefined{
 try{
  const composite:string[]=[],messageLeading:string[]=[];
  for(const item of db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Iterable<any>){
   const name=str(item.name);if(!name||Number(item.partial)!==0)continue;
   const columns=Array.from(db.prepare(`PRAGMA index_info(${quoteIdentifier(name)})`).all() as Iterable<any>,entry=>str(entry.name)).filter(Boolean);
   if(columns[0]==='session_id'&&columns[1]==='message_id')composite.push(name);
   else if(columns[0]==='message_id')messageLeading.push(name);
  }
  return composite[0]??messageLeading[0];
 }catch{return undefined;}
}
/** Columns of an index that starts with session_id; undefined means no such index. */
function sessionIndexOf(db:DatabaseSync,table:string):string[]|undefined{
 try{
  const list=db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as Iterable<any>;
  for(const item of list){const name=str(item.name);if(!name)continue;
   const info=db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Iterable<any>;
   const columns=Array.from(info,entry=>str(entry.name)).filter(Boolean);
   if(columns[0]==='session_id')return columns;}
 }catch{}
 return undefined;
}
interface DigestCache{entries:Map<string,{envelope:string;digest:string}>;scans:number;sourceRevision?:string}
/** Per native source: the last content digest and the cheap key it was taken under. */
const digestCaches=new Map<string,DigestCache>();
/** A periodic full rehash bounds how long an unnoticed in-place edit may stay. */
function resyncScans():number{const value=Number(process.env.AGENT_HERDER_SESSION_SEARCH_RESYNC_SCANS);return Number.isInteger(value)&&value>0?value:60;}
async function* sqliteSessions(harness:'opencode'|'zcode'|'hermes',path:string,options:Options):AsyncGenerator<SearchSourceSession>{
 await stat(path);const sourceRevision=await dbStamp(path);const db=new DatabaseSync(path,{readOnly:true});
 let cacheKey='',dbClosed=false;
 const closeDb=()=>{if(!dbClosed){db.close();dbClosed=true;}};
 try{
  db.exec('PRAGMA temp_store=MEMORY; PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  const hermes=harness==='hermes';
  const sessionTable=hermes?'sessions':'session',messageTable=hermes?'messages':'message';
  const sessionColumns=columnsOf(db,sessionTable);
  const sessionKey=hermes?null:(['time_updated','updated_at'].find(column=>sessionColumns.has(column))??null);
  const sessions=db.prepare(hermes?'SELECT id,title,cwd FROM sessions ORDER BY id':sessionKey?`SELECT id,title,directory AS cwd,${sessionKey} FROM session ORDER BY id`:'SELECT id,title,directory AS cwd FROM session ORDER BY id');
  const messages=db.prepare(hermes?'SELECT id,content FROM messages WHERE session_id=? ORDER BY timestamp,id':'SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id');
  const partLookupIndex=hermes?undefined:partLookupIndexOf(db,'part');
  const parts=hermes?null:db.prepare(`SELECT id,data FROM part${partLookupIndex?` INDEXED BY ${quoteIdentifier(partLookupIndex)}`:''} WHERE session_id=? AND message_id=? ORDER BY time_created,id`);
  // A source that publishes its own change key may skip the content hash.
  // Hermes publishes none: its rows carry creation time only, so the hash stays.
  const messageIndex=sessionIndexOf(db,messageTable);
  const partIndex=hermes?undefined:sessionIndexOf(db,'part');
  const incremental=!hermes&&!!sessionKey&&!!messageIndex;
  const messageEnvelope=incremental?db.prepare(messageIndex!.includes('time_created')&&messageIndex!.includes('id')?'SELECT count(*) c,max(time_created) t,max(id) i FROM message WHERE session_id=?':'SELECT count(*) c FROM message WHERE session_id=?'):null;
  const partEnvelope=incremental&&partIndex?db.prepare('SELECT count(*) c FROM part WHERE session_id=?'):null;
  const identity=(await stamp(path)).split(':').slice(0,2).join(':');
  cacheKey=`${harness}|${path}|${identity}`;
  const previous=digestCaches.get(cacheKey);
  const cache:DigestCache=hermes?{entries:new Map(previous?.entries),scans:(previous?.scans??0)+1,sourceRevision}:previous??{entries:new Map<string,{envelope:string;digest:string}>(),scans:0};
  if(!hermes)cache.scans++;
  const resync=cache.scans%resyncScans()===0;
  const exactSnapshot=hermes&&previous?.sourceRevision===sourceRevision;
  const seen=new Set<string>();
  let snapshotComplete=true;
  for(const row of sessions.iterate() as Iterable<any>){check(options.signal);const id=str(row.id);if(!id)continue;
   seen.add(id);
   const digestOf=async():Promise<string>=>{
    // Native schemas do not all advance a content update timestamp (Hermes
    // messages use creation time). Hash persisted content to detect same-size edits.
    const digest=createHash('sha256').update(JSON.stringify({id:row.id,title:row.title,cwd:row.cwd}));
    let hashedRows=0;for(const message of messages.iterate(id) as Iterable<any>){check(options.signal);digest.update(JSON.stringify(message));if(++hashedRows%128===0)await yieldEventLoop();if(parts)for(const part of parts.iterate(id,message.id) as Iterable<any>){check(options.signal);digest.update(JSON.stringify(part));if(++hashedRows%128===0)await yieldEventLoop();}}
    return digest.digest('hex');
   };
   let revision:string;
   const cached=cache.entries.get(id);
   if(exactSnapshot&&cached)revision=cached.digest;
   else if(incremental){
    // Cheap key: the session row the harness maintains, plus index-only counts.
    const message=messageEnvelope!.get(id) as any;const part=partEnvelope?.get(id) as any;
    const envelope=`${String((row as any)[sessionKey!]??'')}|${message?.c??0}|${message?.t??''}|${message?.i??''}|${part?.c??0}`;
    if(cached&&!resync&&cached.envelope===envelope)revision=cached.digest;
    else{revision=await digestOf();cache.entries.set(id,{envelope,digest:revision});}
   }else{revision=await digestOf();if(hermes)cache.entries.set(id,{envelope:'',digest:revision});}
   let chunksStarted=false,chunksCompleted=false;
   const chunks=async function*(){chunksStarted=true;try{for(const m of messages.iterate(id) as Iterable<any>){check(options.signal);if(hermes){let value=m.content;try{value=JSON.parse(value);}catch{/* Native plain-text content is valid. */}const body=text(value);if(body)yield {id:String(m.id),text:body};}else{JSON.parse(str(m.data));for(const part of parts!.iterate(id,m.id) as Iterable<any>){const data=JSON.parse(str(part.data));const body=str(data.text);if(body)yield {id:String(part.id),text:body};}}}chunksCompleted=true;}catch(error){snapshotComplete=false;throw error;}};
   yield {harness,nativeSessionId:id,title:str(row.title)||id,cwd:str(row.cwd),revision:`${revision}:${str(row.title)}:${str(row.cwd)}`,chunks:chunks()};
   if(chunksStarted&&!chunksCompleted)snapshotComplete=false;
  }
  for(const key of Array.from(cache.entries.keys()))if(!seen.has(key))cache.entries.delete(key);
  closeDb();
  if(!hermes)digestCaches.set(cacheKey,cache);
  check(options.signal);
  if(await dbStamp(path)!==sourceRevision)throw new Error('native_source_changed_during_scan');
  check(options.signal);
  if(hermes&&snapshotComplete)digestCaches.set(cacheKey,cache);
 }finally{closeDb();}
}
/** Read persisted source files only. No adapter caps, native writes or model calls. */
export async function* scanSessionSearchSources(options:Options={}):AsyncGenerator<SearchSourceSession>{
 options={...options};
 const home=homedir();const sources:Array<{harness:string;source:string;scan:()=>AsyncGenerator<SearchSourceSession>}>= [
  {harness:'codex',source:process.env.CODEX_HOME||join(home,'.codex'),scan:()=>codex(options)},
  {harness:'minimax-code',source:process.env.MINIMAX_CODE_SESSION_STORE||join(home,'.minimax/v2/sessions'),scan:()=>minimax(options)},
  ...(['opencode','zcode','hermes'] as const).map(harness=>{const source=harness==='opencode'?process.env.OPENCODE_DB_PATH||join(home,'.local/share/opencode/opencode.db'):harness==='zcode'?process.env.ZCODE_DB_PATH||join(home,'.zcode/cli/db/db.sqlite'):process.env.HERMES_STATE_DB||join(process.env.HERMES_HOME||join(home,'.hermes'),'state.db');return {harness,source,scan:()=>sqliteSessions(harness,source,options)};}),
  {harness:'claude',source:process.env.CLAUDE_PROJECTS_DIR||join(home,'.claude/projects'),scan:async function*(){for await(const p of files(process.env.CLAUDE_PROJECTS_DIR||join(home,'.claude/projects'),options.signal))if(p.endsWith('.jsonl')){const session=await safeJsonSession(p,'claude',options);if(session)yield session;}}},
 ];
 const originalIssue=options.onIssue;
 for(const source of sources){let sessions=0,textSessions=0,missingContent=0,chunks=0;let issue:string|undefined;options.onIssue=(reason)=>{issue=reason;originalIssue?.(reason);};try{check(options.signal);for await(const session of source.scan()){const original=session.chunks;let hasText=false;if(session.contentUnavailable)missingContent++;session.chunks=(async function*(){try{for await(const chunk of original){if(!hasText){hasText=true;textSessions++;}chunks++;yield chunk;}}catch(error){issue='native_session_content_read_failed';throw error;}})();yield session;sessions++;}options.onStatus?.({harness:source.harness,source:source.source,state:issue?'partial':'complete',sessions,catalogSessions:sessions,textSessions,missingContent,chunks,...(issue?{reason:issue}:{})});}catch(error){check(options.signal);options.onStatus?.({harness:source.harness,source:source.source,state:sessions?'partial':'unavailable',sessions,reason:error instanceof Error?error.message:'source_read_failed'});}}
 for(const harness of ['qoder','fast-agent','chatgpt'])options.onStatus?.({harness,source:'native-persisted-reader',state:'unsupported',sessions:0,reason:'native_persisted_history_reader_not_available'});
}
