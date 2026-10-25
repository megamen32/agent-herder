import {crc32} from 'node:zlib';
import {expect,it,vi} from 'vitest';
import {ZcodeAdapter} from '../src/adapters/zcode.js';

function fixture(options:{stale?:boolean;reset?:boolean;lost?:boolean;foreign?:boolean;unloaded?:boolean;fragment?:boolean;corrupt?:boolean;enabled?:boolean;oversized?:boolean}={}) {
 let revision=7, autoDrain=options.enabled??false, listener:(frame:any)=>void=()=>{};
 const calls:any[]=[];
 const frame=()=>({topic:'conversation/owned',subscriptionId:'sub',fromSeq:0,toSeq:revision,payload:{kind:'snapshot',snapshot:{sessionId:'owned',revision,logEpoch:'epoch',seq:revision,control:{phase:'completedSuccess'},queue:{autoDrain,items:[{queueItemId:'oldest'},{queueItemId:'newer'}]}}}});
 const emit=()=>{const wire={wireVersion:3,logicalFrameId:'f-'+revision,logicalFrameOrdinal:revision,topic:'conversation/owned',subscriptionId:'sub'};if(!options.fragment){listener({...wire,kind:'complete',frame:frame()});return;}const bytes=Buffer.from(JSON.stringify(frame())),mid=Math.floor(bytes.length/2);for(const i of [1,0])listener({...wire,kind:'fragment',fragmentCount:2,fragmentIndex:i,logicalBytes:options.oversized?1:bytes.length,checksum:{algorithm:'crc32',value:options.corrupt?'00000000':crc32(bytes).toString(16).padStart(8,'0')},dataBase64:options.oversized?'AAAA'.repeat(1024):(i?bytes.subarray(mid):bytes.subarray(0,mid)).toString('base64')});};
 const call=vi.fn(async(_channel:string,method:string,args:any[])=>{
  const p=args[0];calls.push({method,p});
  if(method==='readSession'){if(options.unloaded)throw Object.assign(Error('Session not found'),{code:'proto.sessionNotFound'});return{session:{sessionId:'owned',status:'idle'},runtime:{pendingRequestIds:[]}};}
  if(method==='subscribeConversationV4'){if(options.foreign)listener({...frame(),subscriptionId:'foreign'});emit();return{ack:{subscriptionId:'sub',mode:'snapshot',logEpoch:'epoch'}};}
  if(method==='resyncConversationV4'){emit();return{ack:{subscriptionId:'sub',mode:'snapshot',logEpoch:'epoch'}};}
  if(method==='unsubscribeConversationV4')return{};
  if(method==='queryConversationCommandsV4')return{results:[{key:{sessionId:'owned',commandId:'resume'},result:'unknown'}]};
  if(method==='sendConversationCommandV4'){
   if(options.lost)throw Error('lost after write');
   if(options.stale)return{commandId:'resume',status:'stale',revisionAtDecision:8};
   revision++;autoDrain=!options.reset;return{commandId:'resume',status:'accepted',revisionAtDecision:revision};
  }
  throw Error('Forbidden '+method);
 });
 const client={start:vi.fn(async()=>{}),close:async()=>{},call,callIfReady:call,listen:vi.fn((_c:string,_e:string,_p:unknown,fn:any)=>{listener=fn;return()=>{}})};
 const adapter=new ZcodeAdapter({client,cwd:'/repo',localDbPath:'/missing',tasksIndexDbPath:'/missing'});
 return{adapter,calls,client};
}
it('uses exact V4 CAS, preserves FIFO and creates no input or session',async()=>{
 const {adapter,calls,client}=fixture({foreign:true});
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:true,status:'accepted',state:{baseRevision:8,autoDrain:true,pendingCount:2,oldestQueueItemId:'oldest',loaded:true}});
 expect(calls.find(c=>c.method==='sendConversationCommandV4').p.envelope).toEqual({commandId:'resume',clientId:'agent-herder',sessionId:'owned',type:'setAutoDrain',payload:{autoDrain:true},baseRevision:7,baseLogEpoch:'epoch',issuedAt:expect.any(Number)});
 expect(client.start).not.toHaveBeenCalled();
 expect(calls.map(c=>c.method)).toEqual(['readSession','subscribeConversationV4','queryConversationCommandsV4','sendConversationCommandV4','resyncConversationV4','unsubscribeConversationV4']);
});
it('stale view produces no write',async()=>{
 const {adapter,calls}=fixture();
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:6})).toMatchObject({ok:false,status:'stale-no-write'});
 expect(calls.some(c=>c.method==='sendConversationCommandV4')).toBe(false);
});
it('native CAS stale is no-write even after a matching preflight',async()=>{
 const {adapter}=fixture({stale:true});
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'stale-no-write'});
});
it('accepted ACK with autoDrain reset fails the readback gate',async()=>{
 const {adapter}=fixture({reset:true});
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'unknown',nonRetryable:true,state:{autoDrain:false}});
});
it('lost ACK is never replayed by a repeated action',async()=>{
 const {adapter,calls}=fixture({lost:true});
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'unknown'});
 await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7});
 expect(calls.filter(c=>c.method==='sendConversationCommandV4')).toHaveLength(1);
});
it('unloaded session refuses before subscribe and never invokes destructive resume',async()=>{
 const {adapter,calls}=fixture({unloaded:true});
 expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'not-submitted'});
 expect(calls.map(c=>c.method)).toEqual(['readSession']);
});

it('assembles official out-of-order CRC32 snapshot fragments',async()=>{const{adapter}=fixture({fragment:true});expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:true,status:'accepted'});});
it('rejects corrupted snapshot fragments before any queue write',async()=>{const{adapter,calls}=fixture({fragment:true,corrupt:true});expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'not-submitted',error:expect.stringContaining('checksum')});expect(calls.some(c=>c.method==='sendConversationCommandV4')).toBe(false);});

it('explicitly reevaluates a stalled queue when autoDrain is already true',async()=>{const{adapter,calls}=fixture({enabled:true});expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:true,status:'accepted'});expect(calls.filter(c=>c.method==='sendConversationCommandV4')).toHaveLength(1);});

it('bounds encoded fragment length before allocating decoded bytes',async()=>{const decode=vi.spyOn(Buffer,'from');try{const{adapter,calls}=fixture({fragment:true,oversized:true});expect(await adapter.resumeQueueProcessing('owned',{inputId:'resume',expectedRevision:7})).toMatchObject({ok:false,status:'not-submitted'});expect(decode.mock.calls.some(args=>args[1]==='base64')).toBe(false);expect(calls.some(c=>c.method==='sendConversationCommandV4')).toBe(false);}finally{decode.mockRestore();}});
