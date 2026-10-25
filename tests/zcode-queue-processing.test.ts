import {expect,it,vi} from 'vitest';
import {ZcodeAdapter} from '../src/adapters/zcode.js';

function fixture(options:{stale?:boolean;reset?:boolean;lost?:boolean;foreign?:boolean;unloaded?:boolean}={}) {
 let revision=7, autoDrain=false, listener:(frame:any)=>void=()=>{};
 const calls:any[]=[];
 const frame=()=>({topic:'conversation/owned',subscriptionId:'sub',fromSeq:0,toSeq:revision,payload:{kind:'snapshot',snapshot:{sessionId:'owned',revision,logEpoch:'epoch',seq:revision,control:{phase:'completedSuccess'},queue:{autoDrain,items:[{queueItemId:'oldest'},{queueItemId:'newer'}]}}}});
 const call=vi.fn(async(_channel:string,method:string,args:any[])=>{
  const p=args[0];calls.push({method,p});
  if(method==='readSession'){if(options.unloaded)throw Object.assign(Error('Session not found'),{code:'proto.sessionNotFound'});return{session:{sessionId:'owned',status:'idle'},runtime:{pendingRequestIds:[]}};}
  if(method==='subscribeConversationV4'){if(options.foreign)listener({...frame(),subscriptionId:'foreign'});listener(frame());return{ack:{subscriptionId:'sub',mode:'snapshot',logEpoch:'epoch'}};}
  if(method==='resyncConversationV4'){listener(frame());return{ack:{subscriptionId:'sub',mode:'snapshot',logEpoch:'epoch'}};}
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
