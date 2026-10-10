import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CodexAdapter} from '../src/adapters/codex.js';
import {CodexAppServerAdapter} from '../src/adapters/codex-app-server.js';
import {HumanStopStore} from '../src/human-stop-store.js';
import {SessionSupervisor} from '../src/session-supervisor.js';

// Fast unit: expected2s/max20s. Detects bounded native pages triggering global
// rollout/history/open-writer scans; fixtures never launch native Codex or LLMs.
const folders:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function index(){
 const folder=await mkdtemp(join(tmpdir(),'mesh-codex-discovery-'));folders.push(folder);
 const db=new DatabaseSync(join(folder,'state_5.sqlite'));
 db.exec('create table threads(id text primary key,thread_source text,agent_role text,is_pinned integer,has_user_event integer default 1,archived integer default 0,updated_at integer default 1700000000);create table thread_spawn_edges(child_thread_id text primary key,parent_thread_id text)');
 db.prepare('insert into threads(id,thread_source,agent_role,is_pinned) values(?,?,?,?)').run('native-1','subagent','worker',1);
 db.prepare('insert into thread_spawn_edges values(?,?)').run('native-1','parent-1');
 const row=db.prepare('insert into threads(id,thread_source,agent_role,is_pinned) values(?,?,?,?)');
 db.exec('begin');for(let i=0;i<1000;i++)row.run(`unrelated-${i}`,'cli','unused',0);db.exec('commit');db.close();
 return folder;
}
function fixture(folder:string){
 const adapter=new CodexAppServerAdapter({codexDir:folder,socketPath:'/fixture/shared.sock',codexBin:'/never/launched'});
 const internals=adapter as unknown as {ensureReady():Promise<void>;request(method:string,args:Record<string,unknown>):Promise<unknown>;rawTranscriptAdapter:CodexAdapter};
 vi.spyOn(internals,'ensureReady').mockResolvedValue();
 const request=vi.spyOn(internals,'request').mockImplementation(async(method)=>{
  if(method==='thread/loaded/list')return {data:[],nextCursor:null};
  if(method!=='thread/list')throw new Error(`Unexpected discovery RPC ${method}`);
  return {data:[{id:'native-1',cwd:'/native/project',name:'Native title',status:{type:'active',activeFlags:['waitingOnApproval']},updatedAt:1700000000}],nextCursor:'next-page'};
 });
 return {adapter,raw:internals.rawTranscriptAdapter,request};
}
describe('bounded native Codex discovery',()=>{
 it('projects one native page without global metadata, history, or writer inspection',async()=>{
  const folder=await index();const {adapter,raw,request}=fixture(folder);
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockRejectedValue(new Error('global_metadata_must_not_run'));
  const history=vi.spyOn(raw,'getSessionMessages').mockRejectedValue(new Error('history_must_not_run'));
  const scan=vi.spyOn(raw as unknown as {getSessionStates():Promise<unknown>},'getSessionStates').mockRejectedValue(new Error('global_rollout_scan_must_not_run'));
  const writers=vi.spyOn(raw as unknown as {getOpenCodexRolloutPaths():Promise<unknown>},'getOpenCodexRolloutPaths').mockRejectedValue(new Error('global_writer_scan_must_not_run'));
  const sessions=await adapter.listSessions({limit:3});
  expect(sessions).toMatchObject([{id:'native-1',cwd:'/native/project',title:'Native title',status:'needs_input',needsPermission:true,meta:{parentThreadId:'parent-1',threadSource:'subagent',agentRole:'worker',pinned:true}}]);
  expect(request).toHaveBeenCalledTimes(2);expect(request).toHaveBeenCalledWith('thread/list',expect.objectContaining({limit:3,archived:false}));
  expect(request).toHaveBeenCalledWith('thread/loaded/list',{limit:3});
  expect(global).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();expect(writers).not.toHaveBeenCalled();
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'bounded_native_page'});
 });
 it('includes the exact unmaterialized native ID absent from persisted and loaded lists',async()=>{
  const folder=await index();const db=new DatabaseSync(join(folder,'state_5.sqlite'));
  db.exec("insert into threads(id,has_user_event,updated_at) values('empty-44',0,1800000000);insert into threads(id,has_user_event,archived) values('archived-empty',0,1)");db.close();
  const {adapter,raw,request}=fixture(folder);
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockRejectedValue(new Error('no_global'));
  const history=vi.spyOn(raw,'getSessionMessages').mockRejectedValue(new Error('no_history'));
  request.mockImplementation(async(method,args)=>{
   if(method==='thread/list')return {data:[{id:'native-1',updatedAt:1700000000,status:'idle'}],nextCursor:null};
   if(method==='thread/loaded/list')return {data:['native-1'],nextCursor:null};
   if(method==='thread/read'&&args.threadId==='empty-44'&&args.includeTurns===false)return {thread:{id:'empty-44',name:'Accepted empty',cwd:'/actual',status:{type:'notLoaded'},updatedAt:1800000000,turns:[]}};
   throw new Error('unexpected native operation');
  });
  const sessions=await adapter.listSessions({limit:3});
  expect(sessions.map(s=>s.id)).toEqual(['empty-44','native-1']);
  expect(sessions[0]).toMatchObject({title:'Accepted empty',cwd:'/actual',status:'idle'});
  expect(sessions[0]).not.toHaveProperty('messageCount');
  expect(request.mock.calls.filter(([m])=>m==='thread/read')).toEqual([['thread/read',{threadId:'empty-44',includeTurns:false}]]);
  expect(global).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled();
  expect(adapter.getSessionSnapshotReceipt().exhaustive).toBe(true);
 });
 it('merges native loaded-only IDs, deduplicates, bounds reads/output and marks omitted pages partial',async()=>{
  const folder=await index();const {adapter,request}=fixture(folder);
  request.mockImplementation(async(method,args)=>{
   if(method==='thread/list')return {data:[{id:'native-1',updatedAt:1700000000,status:'idle'}],nextCursor:null};
   if(method==='thread/loaded/list')return {data:['loaded-1','loaded-1'],nextCursor:'loaded-next'};
   if(method==='thread/read'&&args.includeTurns===false)return {thread:{id:args.threadId,status:'active',updatedAt:1800000000}};
   throw new Error('unexpected');
  });
  expect((await adapter.listSessions({limit:1})).map(s=>s.id)).toEqual(['loaded-1']);
  expect(request).toHaveBeenCalledWith('thread/loaded/list',{limit:1});
  expect(request.mock.calls.filter(([m])=>m==='thread/read')).toHaveLength(1);
  expect(adapter.getSessionSnapshotReceipt().exhaustive).toBe(false);
 });
 it.each(['failed','wrong-id'])('keeps native rows but marks %s candidate metadata partial',async outcome=>{
  const folder=await index();const {adapter,request}=fixture(folder);
  request.mockImplementation(async(method)=>{
   if(method==='thread/list')return {data:[{id:'native-1',status:'idle'}],nextCursor:null};
   if(method==='thread/loaded/list')return {data:['loaded-1'],nextCursor:null};
   if(outcome==='failed')throw new Error('metadata unavailable');
   return {thread:{id:'foreign'}};
  });
  expect((await adapter.listSessions({limit:3})).map(s=>s.id)).toEqual(['native-1']);
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'native_candidate_metadata_unavailable'});
 });
 it('reports unavailable native loaded discovery without reusing cached threads',async()=>{
  const folder=await index();const {adapter,request}=fixture(folder);
  request.mockImplementation(async(method)=>{if(method==='thread/list')return {data:[],nextCursor:null};throw new Error('unsupported');});
  expect(await adapter.listSessions({limit:3})).toEqual([]);
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'native_loaded_page_unavailable'});
 });
 it('caps an unrelated 527-char preview title so strict STOP observation cannot reject details',async()=>{
  const folder=await index();const {adapter,request}=fixture(folder);
  request.mockImplementation(async(method)=>method==='thread/list'?{data:[{id:'native-1',preview:'x'.repeat(527),status:'idle'}],nextCursor:null}:{data:[],nextCursor:null});
  const [session]=await adapter.listSessions({limit:3});expect(session.title).toHaveLength(500);expect(session.lastMessage).toHaveLength(527);
  await expect(new HumanStopStore(join(folder,'stops.json')).observe(session)).resolves.toBe(false);
 });
 it('quick details survives the unrelated long title and keeps missing native history explicitly unavailable',async()=>{
  const folder=await index();const {adapter,raw,request}=fixture(folder);
  const target={id:'empty-44',name:'Accepted empty',cwd:'/actual',status:{type:'notLoaded'},turns:[]};
  request.mockImplementation(async(method,args)=>{
   if(method==='thread/list')return {data:[{id:'native-1',preview:'x'.repeat(527),status:'idle'}],nextCursor:null};
   if(method==='thread/read'&&args.includeTurns===false)return {thread:target};
   throw new Error('invalid paginated history lineage: missing source rollout');
  });
  vi.spyOn(raw,'getNativeSessionMetadata').mockResolvedValue(new Map());
  vi.spyOn(raw,'getSessionObservation').mockResolvedValue(null);
  vi.spyOn(raw,'getSessionMessages').mockRejectedValue(Object.assign(new Error('missing source rollout'),{code:'ENOENT'}));
  const supervisor=new SessionSupervisor(new Map([['codex',adapter]]),{
   convert:vi.fn(),read:vi.fn().mockRejectedValue(new Error('missing source rollout')),
  },{get:vi.fn().mockResolvedValue(null)} as never,{humanStopStore:new HumanStopStore(join(folder,'stops.json')),autoResumeFailedSessions:false});
  const details=await supervisor.getSessionDetails('codex','empty-44',{quick:true,limit:3});
  expect(details.session).toMatchObject({id:'empty-44',title:'Accepted empty',cwd:'/actual'});
  expect(details.history).toMatchObject({source:'unavailable',complete:false,warning:expect.stringContaining('missing source rollout')});
  expect(details.messages).toEqual([]);
  expect(request.mock.calls.some(([method])=>/start|resume|steer/.test(method))).toBe(false);
 });
 it('bounds the separate index page, excludes archived/materialized rows and reports its cap',async()=>{
  const folder=await index();const db=new DatabaseSync(join(folder,'state_5.sqlite'));
  db.exec("insert into threads(id,has_user_event,updated_at) values('empty-a',0,1800000000),('empty-b',0,1800000001);insert into threads(id,has_user_event,archived) values('archived',0,1)");db.close();
  const raw=new CodexAdapter({codexDir:folder});
  expect(await raw.getNativeUnmaterializedThreadIds(1)).toEqual({available:true,ids:['empty-b'],limited:true});
  expect(await raw.getNativeUnmaterializedThreadIds(3)).toEqual({available:true,ids:['empty-b','empty-a'],limited:false});
  await expect(raw.getNativeUnmaterializedThreadIds(101)).rejects.toThrow(/bounded/i);
 });
 it('marks unknown index schema partial while retaining authoritative persistent metadata',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mesh-codex-old-schema-'));folders.push(folder);
  const db=new DatabaseSync(join(folder,'state_5.sqlite'));db.exec('create table threads(id text primary key)');db.close();
  const {adapter,raw,request}=fixture(folder);
  request.mockImplementation(async method=>method==='thread/list'?{data:[{id:'native-1',status:'idle'}],nextCursor:null}:{data:[],nextCursor:null});
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockRejectedValue(new Error('no_fallback'));
  expect((await adapter.listSessions({limit:3})).map(s=>s.id)).toEqual(['native-1']);
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'native_unmaterialized_index_unavailable'});
  expect(global).not.toHaveBeenCalled();
 });
 it('queries exact selected native IDs and bounds metadata without global fallback',async()=>{
  const raw=new CodexAdapter({codexDir:await index()});
  const read=await raw.getNativeSessionMetadataForIds(['native-1','missing-id','native-1']);
  expect(read.available).toBe(true);const selected=read.metadata;
  expect([...selected.keys()]).toEqual(['native-1']);
  expect(selected.get('native-1')).toMatchObject({parentThreadId:'parent-1',threadSource:'subagent',agentRole:'worker',pinned:true});
  expect(selected.get('native-1')).not.toHaveProperty('status');expect(selected.get('native-1')).not.toHaveProperty('automationStop');
  await expect(raw.getNativeSessionMetadataForIds(Array.from({length:101},(_,i)=>`id-${i}`))).rejects.toThrow(/bounded.*IDs/i);
 });
 it('keeps native sessions when an old installation has no optional metadata index',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mesh-codex-no-index-'));folders.push(folder);
  const {adapter,raw}=fixture(folder);
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockRejectedValue(new Error('global_metadata_must_not_run'));
  expect(await adapter.listSessions({limit:1})).toMatchObject([{id:'native-1',cwd:'/native/project',status:'needs_input'}]);
  expect(global).not.toHaveBeenCalled();
 });
 it('keeps authoritative native rows with explicit partial metadata when the index is corrupt',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mesh-codex-corrupt-index-'));folders.push(folder);
  await writeFile(join(folder,'state_5.sqlite'),'corrupt sqlite fixture');
  const {adapter,raw}=fixture(folder);
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockRejectedValue(new Error('global_metadata_must_not_run'));
  expect(await adapter.listSessions({limit:1})).toMatchObject([{id:'native-1',cwd:'/native/project',status:'needs_input',meta:{nativeIndexMetadata:'unavailable'}}]);
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'native_index_metadata_unavailable'});
  expect(global).not.toHaveBeenCalled();
 });
 it('keeps the native page when an optional index writer holds an exclusive lock',async()=>{
  const folder=await index();const db=new DatabaseSync(join(folder,'state_5.sqlite'));
  db.exec('begin exclusive');
  try{
   const {adapter}=fixture(folder);
   expect(await adapter.listSessions({limit:1})).toMatchObject([{id:'native-1',status:'needs_input',meta:{nativeIndexMetadata:'unavailable'}}]);
   expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'native_index_metadata_unavailable'});
  }finally{db.exec('rollback');db.close();}
 });
 it('preserves the unbounded metadata/STOP branch',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mesh-codex-unbounded-'));folders.push(folder);
  const {adapter,raw,request}=fixture(folder);
  request.mockResolvedValue({data:[{id:'native-1',cwd:'/native/project',status:'idle'}],nextCursor:null});
  const stop={id:'native-stop',at:new Date(0).toISOString(),turnId:'native-stopped-turn',reason:'interrupted' as const};
  const global=vi.spyOn(raw,'getNativeSessionMetadata').mockResolvedValue(new Map([['native-1',{pinned:true,automationStop:stop}]]));
  expect(await adapter.listSessions()).toMatchObject([{id:'native-1',meta:{pinned:true,automationStop:stop}}]);
  expect(global).toHaveBeenCalledOnce();
 });
});
