import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CodexAdapter} from '../src/adapters/codex.js';
import {CodexAppServerAdapter} from '../src/adapters/codex-app-server.js';

// Fast unit: expected2s/max20s. Detects bounded native pages triggering global
// rollout/history/open-writer scans; fixtures never launch native Codex or LLMs.
const folders:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function index(){
 const folder=await mkdtemp(join(tmpdir(),'mesh-codex-discovery-'));folders.push(folder);
 const db=new DatabaseSync(join(folder,'state_5.sqlite'));
 db.exec('create table threads(id text primary key,thread_source text,agent_role text,is_pinned integer);create table thread_spawn_edges(child_thread_id text primary key,parent_thread_id text)');
 db.prepare('insert into threads values(?,?,?,?)').run('native-1','subagent','worker',1);
 db.prepare('insert into thread_spawn_edges values(?,?)').run('native-1','parent-1');
 const row=db.prepare('insert into threads values(?,?,?,?)');
 db.exec('begin');for(let i=0;i<1000;i++)row.run(`unrelated-${i}`,'cli','unused',0);db.exec('commit');db.close();
 return folder;
}
function fixture(folder:string){
 const adapter=new CodexAppServerAdapter({codexDir:folder,socketPath:'/fixture/shared.sock',codexBin:'/never/launched'});
 const internals=adapter as unknown as {ensureReady():Promise<void>;request(method:string,args:Record<string,unknown>):Promise<unknown>;rawTranscriptAdapter:CodexAdapter};
 vi.spyOn(internals,'ensureReady').mockResolvedValue();
 const request=vi.spyOn(internals,'request').mockImplementation(async(method)=>{
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
  expect(request).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledWith('thread/list',expect.objectContaining({limit:3,archived:false}));
  expect(global).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();expect(writers).not.toHaveBeenCalled();
  expect(adapter.getSessionSnapshotReceipt()).toMatchObject({exhaustive:false,reason:'bounded_native_page'});
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
