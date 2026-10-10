import {afterEach,expect,it,vi} from 'vitest';
import {CodexAppServerAdapter} from '../src/adapters/codex-app-server.js';
import {LocalHarnessMesh} from '../src/mesh/local.js';
import {inventoryHarnesses} from '../src/mesh/inventory.js';

// Fast unit: expected1s/max5s. Actual M1 thread/list(12) stalls while
// thread/list(3) succeeds. Discovery keeps fresh native IDs and explicit partial.
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('keeps a compact native page when the larger native page would miss discovery deadline',async()=>{
 vi.useFakeTimers();
 const adapter=new CodexAppServerAdapter({socketPath:'/fixture/owned-shared.sock',codexDir:'/fixture/no-history'});
 const native=adapter as any;
 vi.spyOn(adapter,'isReady').mockReturnValue(true);
 vi.spyOn(native,'ensureReady').mockResolvedValue(undefined);
 vi.spyOn(native.rawTranscriptAdapter,'getNativeUnmaterializedThreadIds').mockResolvedValue({available:true,ids:[],limited:false});
 vi.spyOn(native.rawTranscriptAdapter,'getNativeSessionMetadataForIds').mockResolvedValue({available:true,metadata:new Map()});
 const rpc=vi.spyOn(native,'request').mockImplementation(async(method:any,args:any)=>{
  if(method==='thread/loaded/list')return {data:[],nextCursor:null};
  if(method!=='thread/list')throw new Error('discovery must be metadata only');
  if(args.limit>3)return new Promise(()=>{});
  return {data:Array.from({length:3},(_,i)=>({id:`native-${i}`,name:`Native ${i}`,cwd:'/actual/launch',status:'idle',updatedAt:1700000000-i})),nextCursor:'next-native-page'};
 });
 const mesh=new LocalHarnessMesh({hostId:'fixture-host',adapters:new Map([['codex',adapter]])});
 const pending=mesh.snapshot(12);await vi.advanceTimersByTimeAsync(2000);
 const result=await pending;
 expect(result.sessions.map(s=>s.address.nativeSessionId)).toEqual(['native-0','native-1','native-2']);
 expect(result).toMatchObject({complete:false,limited:true});
 expect(result.harnesses.find(h=>h.harness==='codex')).toMatchObject({discovery:'available'});
 expect(result.sessions[0]?.project).toMatchObject({launchCwd:'/actual/launch',currentCwd:null,source:'unverified'});
 expect(rpc).toHaveBeenCalledWith('thread/list',expect.objectContaining({limit:3,archived:false}));
 expect(rpc.mock.calls.every(([m])=>['thread/list','thread/loaded/list'].includes(m as string))).toBe(true);
});

it('marks an overflowing adapter result partial even if its receipt claims exhaustive',async()=>{
 const row=(i:number)=>({id:`native-${i}`,harness:'codex',status:'idle',cwd:'/launch',title:'Native',lastActivity:new Date(0).toISOString()});
 const adapters=new Map(inventoryHarnesses.map(h=>[h,{listSessions:async()=>h==='codex'?Array.from({length:4},(_,i)=>row(i)):[],getSessionSnapshotReceipt:()=>({exhaustive:true})}]));
 const result=await new LocalHarnessMesh({hostId:'fixture',adapters:adapters as any}).snapshot(3);
 expect(result.sessions).toHaveLength(3);expect(result).toMatchObject({limited:true,complete:false});
});
it('reports native bounded page even when the caller requested the same small limit',async()=>{
 const adapters=new Map([['codex',{listSessions:async()=>[],getSessionSnapshotReceipt:()=>({exhaustive:false,reason:'bounded_native_page'})}]]);
 expect(await new LocalHarnessMesh({hostId:'fixture',adapters:adapters as any}).snapshot(3)).toMatchObject({limited:true,complete:false});
});
