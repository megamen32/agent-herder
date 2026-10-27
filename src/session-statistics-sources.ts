import {createReadStream} from 'node:fs';
import {mkdir,readdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {dirname,extname,join,normalize,relative,resolve,sep} from 'node:path';

export type ActivityEvent={at:number;kind:'tool'|'patch';paths?:string[]};
export type ActivitySession={id:string;harness:'codex'|'opencode'|'zcode';firstAt?:number;lastAt?:number;tokens?:number;model?:string;events:ActivityEvent[]};
export type ActivitySource={harness:'codex'|'opencode'|'zcode';state:'ready'|'unavailable'|'partial'|'pending';reason?:string;sessions:number;files?:number;revision?:string};
export type ActivitySources={sessions:ActivitySession[];sources:ActivitySource[]};
export type ActivityProgress={processed:number;total:number;harness:'codex'|'opencode'|'zcode'};
type Stamp={dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number};
type CachedFile={stamp:string;session:ActivitySession};
type NativeSessionEntry={envelope:string;session:ActivitySession};
type NativeCache={revision?:string;sessions?:ActivitySession[];partial?:boolean;identity?:string;entries?:Record<string,NativeSessionEntry>;lastAuditAt?:number};
type DiskCache={version:1;parserVersion:2;codexRoot?:string;codex:Record<string,CachedFile>;native:Partial<Record<'opencode'|'zcode',NativeCache>>};
const CACHE_PATH=join(homedir(),'.cache','agent-herder','activity-statistics-sources-v1.json');
const PATCH_HEADER=/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
const nowMs=Date.now();
const DAY=86_400_000;

async function fileStamp(path:string):Promise<string>{const s=await stat(path);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}
async function dbStamp(path:string):Promise<string>{return `${await fileStamp(path)}:${await fileStamp(path+'-wal').catch(()=>'-')}`;}
function timestamp(value:unknown):number|undefined{if(typeof value!=='string')return;const n=Date.parse(value);return Number.isFinite(n)?n/1000:undefined;}
function addTime(session:ActivitySession,at:number|undefined){if(at===undefined)return;session.firstAt=session.firstAt===undefined?at:Math.min(session.firstAt,at);session.lastAt=session.lastAt===undefined?at:Math.max(session.lastAt,at);}
function normalizePath(path:string,cwd:string):string{const expanded=path.replace(/^~(?=\/|$)/,homedir());if(expanded.startsWith('/')){if(cwd.startsWith('/')){const rel=relative(resolve(cwd),resolve(expanded));if(rel!=='..'&&!rel.startsWith(`..${sep}`))return normalize(rel||'.');}return normalize(expanded);}return normalize(expanded.replace(/^\.\//,''));}
function patchPaths(text:string,cwd:string):string[]{const paths=new Set<string>();PATCH_HEADER.lastIndex=0;for(const match of text.matchAll(PATCH_HEADER)){const p=String(match[1]||'').trim().replace(/^['"`]|['"`]$/g,'');if(p)paths.add(normalizePath(p,cwd));}return [...paths];}
function strings(value:unknown,out:string[]=[]):string[]{if(typeof value==='string')out.push(value);else if(Array.isArray(value))for(const item of value)strings(item,out);else if(value&&typeof value==='object')for(const item of Object.values(value as Record<string,unknown>))strings(item,out);return out;}
function number(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;}
function sumTokens(value:any):number|undefined{if(!value||typeof value!=='object')return;const input=number(value.input),output=number(value.output),reasoning=number(value.reasoning),cache=number(value.cache_read)??number(value.cacheRead)??number(value.cache?.read),write=number(value.cache_write)??number(value.cacheWrite)??number(value.cache?.write);const nums=[input,output,reasoning,cache,write].filter((x):x is number=>x!==undefined);return nums.length?nums.reduce((a,b)=>a+b,0):undefined;}
function tokenUsage(value:any):number|undefined{const total=number(value?.total);return total??sumTokens(value);}
function nestedPathStrings(value:any):string[]{return strings(value).filter((x)=>x.length<4096&&!x.includes('\n')&&(/[\\/]/.test(x)||/^\.?\.?$/.test(x)));}
function successfulOutput(row:any):boolean{const p=row?.payload;if(p?.type!=='function_call_output'&&p?.type!=='custom_tool_call_output')return false;if(p.is_error===true||p.isError===true||p.error||Number(p.exit_code??p.exitCode)>0)return false;const output=typeof p.output==='string'?p.output:JSON.stringify(p.output??p.content??'');if(/^\s*(?:error:|failed:)/i.test(output)||/process exited with code\s+[1-9]\d*/i.test(output))return false;try{const value=JSON.parse(output);if(value?.isError===true||value?.is_error===true||value?.error||Number(value?.exitCode??value?.exit_code)>0)return false;}catch{}return true;}
function decodeCall(payload:any,cwd:string,at:number):ActivityEvent|undefined{const tool=String(payload?.name??payload?.tool_name??'').toLowerCase();let args=payload?.arguments??payload?.input;if(typeof args==='string'){try{args=JSON.parse(args);}catch{}}const candidates=[...(typeof payload?.input==='string'?[payload.input]:[]),...strings(args)];const patchCandidates=candidates.filter(value=>value.includes('*** Begin Patch')||/^\*\*\* (?:Add|Update|Delete) File:/m.test(value));const patchFiles=patchCandidates.flatMap(value=>patchPaths(value.replace(/\\n/g,'\n').replace(/\\t/g,'\t'),cwd));const writePaths=/edit|write|replace|create/.test(tool)?nestedPathStrings(args).map(p=>normalizePath(p,cwd)):[];const paths=patchFiles.length?[...new Set(patchFiles)]:[...new Set(writePaths)];return {at,kind:paths.length?'patch':'tool',...(paths.length?{paths}:{})};}
async function parseCodex(path:string):Promise<ActivitySession>{
 const session:ActivitySession={id:path,harness:'codex',events:[]};let cwd='',latestModel:string|undefined;const pending=new Map<string,ActivityEvent>();
 const stream=createReadStream(path,{encoding:'utf8'}),input=createInterface({input:stream,crlfDelay:Infinity});
 try{for await(const line of input){if(!line.trim())continue;let item:any;try{item=JSON.parse(line);}catch{throw new Error('Некорректная строка Codex JSONL');}const p=item?.payload,at=timestamp(item?.timestamp);addTime(session,at);
  if(item?.type==='turn_context'&&p){if(typeof p.cwd==='string')cwd=p.cwd;if(typeof p.model==='string'&&p.model.trim())latestModel=p.model.trim();}
  if(item?.type==='event_msg'&&p?.type==='token_count'){const total=number(p?.info?.total_token_usage?.total_tokens);if(total!==undefined)session.tokens=total;}
  if(item?.type==='response_item'&&p){if((p.type==='function_call'||p.type==='custom_tool_call')&&at!==undefined){const call=decodeCall(p,cwd,at);if(call)pending.set(String(p.call_id??p.id??`${at}:${pending.size}`),call);}else if(successfulOutput(item)){const callId=String(p.call_id??'');const call=pending.get(callId);if(call){session.events.push(call);pending.delete(callId);}}}
 }}finally{input.close();stream.destroy();}
 session.model=latestModel;return session;
}

function tableColumns(db:DatabaseSync,table:string):Set<string>{try{return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as any[]).map(x=>String(x.name)));}catch{return new Set();}}
function quoteId(value:string):string{return `"${value.replaceAll('"','""')}"`;}
function openCodeLayout(path:string):string{const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row=>String(row.name)));return tables.has('session_v2')&&tables.has('session_message')?'opencode-v2':'opencode-legacy';}finally{db.close();}}
function partLookupIndexOf(db:DatabaseSync):string|undefined{try{const composite:string[]=[],messageLeading:string[]=[];for(const row of db.prepare('PRAGMA index_list("part")').all() as any[]){const name=String(row.name??'');if(!name||Number(row.partial)!==0)continue;const columns=(db.prepare(`PRAGMA index_info(${quoteId(name)})`).all() as any[]).map(x=>String(x.name??''));if(columns[0]==='session_id'&&columns[1]==='message_id')composite.push(name);else if(columns[0]==='message_id')messageLeading.push(name);}return composite[0]??messageLeading[0];}catch{return;}}
function toolPathInputs(value:any):string[]{const out:string[]=[];const visit=(v:any)=>{if(!v)return;if(Array.isArray(v)){for(const x of v)visit(x);return;}if(typeof v==='object'){for(const [k,x] of Object.entries(v)){if(/(?:file|path|target)/i.test(k)&&typeof x==='string')out.push(x);else visit(x);}}};visit(value);return out;}
function dbTime(...values:unknown[]):number|undefined{for(const v of values){const n=number(v);if(n!==undefined)return n>10_000_000_000?n/1000:n;}return;}
async function parseNative(harness:'opencode'|'zcode',path:string,onProgress?:(value:ActivityProgress)=>void,cachedEntries:Record<string,NativeSessionEntry>={},forceAudit=true):Promise<{sessions:ActivitySession[];partial:boolean;entries:Record<string,NativeSessionEntry>}>{
 const db=new DatabaseSync(path,{readOnly:true}),sessionsOut:ActivitySession[]=[],entries:Record<string,NativeSessionEntry>={};let partial=false;
 try{
  db.exec('PRAGMA temp_store=MEMORY; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
  const v2SessionColumns=tableColumns(db,'session_v2'),v2MessageColumns=tableColumns(db,'session_message');
  const useV2=harness==='opencode'&&v2SessionColumns.has('id')&&v2MessageColumns.has('session_id');
  const sessionTable=useV2?'session_v2':'session',messageTable=useV2?'session_message':'message';
  const columns=tableColumns(db,sessionTable);if(!columns.has('id'))throw new Error('session_table_unavailable');
  const total=Number((db.prepare(`SELECT count(*) AS n FROM ${quoteId(sessionTable)}`).get() as any)?.n??0),rows=db.prepare(`SELECT * FROM ${quoteId(sessionTable)} ORDER BY id`).iterate() as Iterable<any>;let processed=0;
  const messageColumns=tableColumns(db,messageTable),messageMax=['time_updated','time_created','id','seq'].filter(name=>messageColumns.has(name));
  const messageEnvelope=db.prepare(`SELECT count(*) AS c${messageMax.map(name=>`,max(${quoteId(name)}) AS ${quoteId(`m_${name}`)}`).join('')} FROM ${quoteId(messageTable)} WHERE session_id=?`);
  const messages=db.prepare(useV2?'SELECT id,type,seq,time_created,time_updated,data FROM session_message WHERE session_id=? ORDER BY seq,id':'SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id');
  const partCols=useV2?new Set<string>():tableColumns(db,'part'),partSession=partCols.has('session_id'),partIndex=partLookupIndexOf(db),partMax=['time_updated','time_created','id'].filter(name=>partCols.has(name));
  const parts=partCols.size?db.prepare(`SELECT id,data${partCols.has('time_created')?',time_created':''} FROM part${partIndex?` INDEXED BY ${quoteId(partIndex)}`:''} WHERE ${partSession?'session_id=? AND ':''}message_id=? ORDER BY ${partCols.has('time_created')?'time_created,':''}id`):undefined;
  const partEnvelope=partCols.size?db.prepare(`SELECT count(*) AS c${partMax.map(name=>`,max(${quoteId(name)}) AS ${quoteId(`p_${name}`)}`).join('')} FROM part${partSession?' WHERE session_id=?':' WHERE message_id IN (SELECT id FROM message WHERE session_id=?)'}`):undefined;
  const metadataFields=['time_updated','updated_at','directory','cwd','model','tokens_total','total_tokens','tokens_input','input_tokens','tokens_output','output_tokens','tokens_cache','tokens_cache_read','cache_read','tokens_cache_write','cache_write','tokens_reasoning','reasoning_tokens'];
  for(const row of rows){processed++;if(processed%64===0||processed===total)onProgress?.({harness,processed,total});const id=String(row.id??'');if(!id)continue;
   const updated=dbTime(row.time_updated,row.updated_at);if(updated!==undefined&&updated*1000<nowMs-365*DAY)continue;
   let envelope:string|undefined;
   if(harness==='opencode'){
    const message=messageEnvelope.get(id) as any,partsRow=partEnvelope?(partEnvelope.get(id) as any):undefined;
    envelope=JSON.stringify([...metadataFields.map(name=>row[name]??null),message,partsRow]);
    const cached=cachedEntries[id];if(cached?.envelope===envelope&&!forceAudit){sessionsOut.push(cached.session);entries[id]=cached;continue;}
   }
   const session:ActivitySession={id,harness,events:[]};let latestModel:string|undefined,assistantTokens=0,hasAssistantTokens=false,sessionPartial=false;
   const sessionToken=number(row.tokens_total??row.total_tokens)??sumTokens({input:row.tokens_input??row.input_tokens,output:row.tokens_output??row.output_tokens,reasoning:row.tokens_reasoning??row.reasoning_tokens,cache_read:row.tokens_cache_read??row.tokens_cache??row.cache_read,cache_write:row.tokens_cache_write??row.cache_write});
   for(const msg of messages.iterate(id) as Iterable<any>){let data:any;try{data=JSON.parse(String(msg.data));}catch{partial=true;sessionPartial=true;continue;}const at=dbTime(data?.time?.created,data?.time_created,msg.time_created);addTime(session,at);const messageTokens=tokenUsage(data?.tokens??data?.metadata?.tokens);const role=useV2?String(msg.type??''):String(data?.role??'');if(messageTokens!==undefined&&(role==='assistant'||role==='Assistant')){assistantTokens+=messageTokens;hasAssistantTokens=true;}const modelValue=data?.modelID??data?.model?.modelID??data?.model?.id??data?.model;const model=typeof modelValue==='string'?modelValue:'';if(model)latestModel=model;
    const appendTool=(pd:any,created:unknown)=>{if(pd?.type!=='tool')return;const state=pd.state??{};if(state.status!=='completed'||state.error||pd.executed===false)return;const pAt=dbTime(state.time?.end,state.time?.start,pd.time?.start,pd.time?.created,created,at)??at;if(pAt===undefined)return;addTime(session,pAt);const name=String(pd.tool??pd.name??'').toLowerCase(),input=state.input??pd.input;const patchTextPaths=strings(input).flatMap(value=>patchPaths(value,String(row.directory??row.cwd??'')));const pathValues=patchTextPaths.length?patchTextPaths:/edit|write|patch|replace|create/.test(name)?toolPathInputs(input):[];const paths=[...new Set(pathValues.map((p)=>normalizePath(p,String(row.directory??row.cwd??''))))];session.events.push({at:pAt,kind:paths.length?'patch':'tool',...(paths.length?{paths}:{})});};
    if(useV2&&Array.isArray(data?.content)){for(const part of data.content)appendTool(part,undefined);}
    else if(parts&&at!==undefined){const iterable=parts.iterate(...(partSession?[id,msg.id]:[msg.id])) as Iterable<any>;for(const part of iterable){let pd:any;try{pd=JSON.parse(String(part.data));}catch{partial=true;sessionPartial=true;continue;}appendTool(pd,part.time_created);}}
   }
   if(updated!==undefined)session.lastAt=Math.max(session.lastAt??updated,updated);if(session.firstAt===undefined)session.firstAt=dbTime(row.time_created,row.created_at,updated);session.tokens=sessionToken!==undefined&&sessionToken>0?sessionToken:hasAssistantTokens?assistantTokens:sessionToken;const rowModel=typeof row.model==='string'?row.model:typeof row.model?.modelID==='string'?row.model.modelID:typeof row.model?.id==='string'?row.model.id:undefined;session.model=latestModel||rowModel;sessionsOut.push(session);
   if(harness==='opencode'&&envelope&&!sessionPartial)entries[id]={envelope,session};
  }
  db.exec('COMMIT');return {sessions:sessionsOut,partial,entries};
 }finally{db.close();}
}
async function readCache():Promise<DiskCache>{try{const value=JSON.parse(await readFile(CACHE_PATH,'utf8'));if(value?.version===1&&value?.parserVersion===2&&value.codex&&value.native)return value as DiskCache;}catch{}return {version:1,parserVersion:2,codex:{},native:{}};}
async function writeCacheIfChanged(oldValue:DiskCache,value:DiskCache):Promise<void>{const content=JSON.stringify(value);if(JSON.stringify(oldValue)===content)return;await mkdir(dirname(CACHE_PATH),{recursive:true});const tmp=`${CACHE_PATH}.${process.pid}.tmp`;await writeFile(tmp,content+'\n',{mode:0o600});await rename(tmp,CACHE_PATH);}
async function walk(root:string):Promise<{paths:string[];partial:boolean}>{const out:string[]=[];let partial=false;const visit=async(path:string)=>{let entries;try{entries=await readdir(path,{withFileTypes:true});}catch{partial=true;return;}for(const item of entries){const full=join(path,item.name);if(item.isDirectory())await visit(full);else if(item.isFile()&&extname(item.name)==='.jsonl')out.push(full);}};await visit(root);return {paths:out.sort(),partial};}
export async function readActivitySources(days:number,sessionRoot:string,onProgress?:(value:ActivityProgress)=>void,includeArchived=false):Promise<ActivitySources>{
 const roots=[sessionRoot];if(includeArchived)roots.push(resolve(sessionRoot,'..','archived_sessions'));
 const cacheRoot=JSON.stringify(roots),disk=await readCache(),next:DiskCache={version:1,parserVersion:2,codex:disk.codexRoot===cacheRoot?{...disk.codex}:{},native:{...disk.native},codexRoot:cacheRoot},sources:ActivitySource[]=[],records:ActivitySession[]=[];const cutoff=Date.now()/1000-days*86400;
 let codexState:ActivitySource['state']='ready',codexReason:string|undefined;let paths:string[]=[];
 try{await stat(sessionRoot);const first=await walk(sessionRoot);paths=first.paths;if(first.partial){codexState='partial';codexReason='Не все каталоги Codex удалось просканировать';}if(includeArchived){try{await stat(roots[1]);const archived=await walk(roots[1]);for(const path of archived.paths)paths.push(path);if(archived.partial){codexState='partial';codexReason='Не все каталоги Codex удалось просканировать';}}catch{/* Archived directory is optional. */}}}catch{codexState='unavailable';codexReason='Каталог Codex сессий недоступен';}
 onProgress?.({harness:'codex',processed:0,total:paths.length});
 const live=new Set(paths);for(const path of Object.keys(next.codex))if(!live.has(path))delete next.codex[path];
 let processed=0;for(const path of paths){try{const stamp=await fileStamp(path),cached=next.codex[path];let session:ActivitySession;if(cached?.stamp===stamp)session=cached.session;else session=await parseCodex(path);if(await fileStamp(path)!==stamp)throw new Error('Файл изменился во время чтения');if(cached?.stamp!==stamp)next.codex[path]={stamp,session};if(session.lastAt!==undefined&&session.lastAt>=cutoff)records.push(session);}catch{codexState='partial';codexReason='Некоторые файлы Codex прочитать не удалось или они изменились';}processed++;if(processed%64===0||processed===paths.length)onProgress?.({harness:'codex',processed,total:paths.length});}
 const codexRecent=records.filter(x=>x.harness==='codex');sources.push({harness:'codex',state:codexState,...(codexReason?{reason:codexReason}:{}),sessions:codexRecent.length,files:codexRecent.length});
 const home=homedir();for(const harness of ['opencode','zcode'] as const){onProgress?.({harness,processed:0,total:1});const path=harness==='opencode'?process.env.OPENCODE_DB_PATH||join(home,'.local/share/opencode/opencode.db'):process.env.ZCODE_DB_PATH||join(home,'.zcode/cli/db/db.sqlite');try{
  if(harness==='opencode'){
   const nativeStamp=await dbStamp(path),identity=`${(await fileStamp(path)).split(':').slice(0,2).join(':')}|${openCodeLayout(path)}`,cached=next.native[harness],sameIdentity=cached?.identity===identity,lastAuditAt=cached?.lastAuditAt??0,forceAudit=!sameIdentity||!lastAuditAt||Date.now()-lastAuditAt>=60*60_000;
   const parsed=await parseNative(harness,path,onProgress,sameIdentity?cached?.entries:{},forceAudit),afterStamp=await dbStamp(path),partial=parsed.partial||afterStamp!==nativeStamp;
   if(!parsed.partial){const previousRevision=sameIdentity?cached?.revision:`${path}|${nativeStamp}`;next.native[harness]={identity,revision:previousRevision,entries:parsed.entries,lastAuditAt:forceAudit?Date.now():cached?.lastAuditAt};}
   const recent=parsed.sessions.filter(s=>s.lastAt!==undefined&&s.lastAt>=cutoff);for(const session of recent)records.push(session);sources.push({harness,state:partial?'partial':'ready',...(partial?{reason:'Нативная база прочитана не полностью или изменилась во время снимка'}:{}),sessions:recent.length,revision:`${path}|${nativeStamp}`});
  }else{
   const nativeStamp=await dbStamp(path),revision=`${path}|${nativeStamp}`,cached=next.native[harness];let nativeSessions:ActivitySession[],partial=false;
   if(cached?.revision===revision&&cached.sessions){nativeSessions=cached.sessions;partial=Boolean(cached.partial);onProgress?.({harness,processed:1,total:1});}
   else{const parsed=await parseNative(harness,path,onProgress);nativeSessions=parsed.sessions;partial=parsed.partial;}
   if(await dbStamp(path)!==nativeStamp)partial=true;else if(!cached||cached.revision!==revision){if(!partial)next.native[harness]={revision,sessions:nativeSessions};}
   const recent=nativeSessions.filter(s=>s.lastAt!==undefined&&s.lastAt>=cutoff);for(const session of recent)records.push(session);sources.push({harness,state:partial?'partial':'ready',...(partial?{reason:'Нативная база прочитана не полностью или изменилась во время чтения'}:{}),sessions:recent.length,revision});
  }
 }catch{sources.push({harness,state:'unavailable',reason:'Нативная база отсутствует, недоступна или имеет неподдерживаемую схему',sessions:0});}}
 await writeCacheIfChanged(disk,next).catch(()=>undefined);
 return {sessions:records,sources};
}
