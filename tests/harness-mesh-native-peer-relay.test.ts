import {describe,expect,it,vi} from "vitest";
import {relayNativePeerDeliveryToOwner} from "../src/mesh/native-peer-owner-relay.js";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {HerderEventBus} from "../src/herder-events.js";
import {HerderJobRegistry} from "../src/herder-jobs.js";
import {UserMessageDelivery} from "../src/user-message-delivery.js";
import {MinimaxExecPolicyStore} from "../src/permission-control/minimax-exec-policy.js";
import {TRUSTED_MESH_MCP_CLIENT_ID,TRUSTED_MESH_MCP_SCOPE,trustedMeshIngressFromMcpAuthInfo} from "../src/mesh/authenticated-ingress.js";
import type {HarnessAdapter} from "../src/types/index.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const request={target:{hostId:"target",harness:"minimax-code",nativeSessionId:"mvs_target"},sender:{hostId:"source",harness:"opencode",nativeSessionId:"session_source"},inputId:"stable-input",message:"bounded delta"};

describe("native peer owner relay",()=>{
 it("forwards exactly once to the shared owner and preserves its durable pending job receipt",async()=>{
  const call=vi.fn(async()=>({content:[{type:"text",text:JSON.stringify({state:"queued",inputId:request.inputId,jobId:"job_exact",retryable:false})}]}));
  await expect(relayNativePeerDeliveryToOwner(request,call)).resolves.toEqual({state:"queued",inputId:request.inputId,jobId:"job_exact",retryable:false,reason:"durable_job_pending"});
  expect(call).toHaveBeenCalledOnce();expect(call).toHaveBeenCalledWith(request);
 });
 it("preserves explicit prewrite refusal and turns a lost owner reply into terminal unknown without retry",async()=>{
  const refused=vi.fn(async()=>({state:"not_attempted",inputId:request.inputId,retryable:false,reason:"project_policy"}));
  await expect(relayNativePeerDeliveryToOwner(request,refused)).resolves.toMatchObject({state:"not_attempted",retryable:false,reason:"project_policy"});
  const lost=vi.fn(async()=>{throw new Error("connection closed after call");});
  await expect(relayNativePeerDeliveryToOwner(request,lost)).resolves.toMatchObject({state:"unknown",retryable:false});
  expect(lost).toHaveBeenCalledOnce();
 });
 it("routes the peer through the co-located shared job registry and exact native receipt",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-peer-core-"));
  const nativeSend=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,turnId:"native-turn",inputId:options.inputId}));
  const adapter={type:"minimax-code",getSession:async(id:string)=>({id,harness:"minimax-code",status:"idle",title:"fixture",cwd:dir,hostId:"target",lastActivity:new Date().toISOString(),needsPermission:false}),sendMessage:nativeSend,isReady:()=>true} as unknown as HarnessAdapter;
  const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(dir,"jobs.json")});
  const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage:async(_h,id,options)=>nativeSend(id,options)},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:4},new MinimaxExecPolicyStore(join(dir,"policies")));
  const owner=new LocalHarnessMesh({hostId:"target",adapters:new Map([["minimax-code",adapter]]),userMessageDelivery:delivery,supervisor:{sendMessage:async(_h,id,options)=>nativeSend(id,options)},nativeObserve:async(_harness,id)=>({nativeSessionId:id,status:"idle"})});
  const ingress=trustedMeshIngressFromMcpAuthInfo({token:"owner-mcp-test",clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]})!;
  const ownerCall=vi.fn(async(args:typeof request)=>owner.deliver(args,ingress));
  try{
   const receipt=await relayNativePeerDeliveryToOwner(request,ownerCall);
   expect(receipt).toMatchObject({state:"queued",inputId:request.inputId,retryable:false});
   expect(receipt.jobId).toMatch(/^job_[a-f0-9]{64}$/);
   expect(ownerCall).toHaveBeenCalledOnce();
   await vi.waitFor(()=>expect(jobs.list(10).find(job=>job.id===receipt.jobId)?.state).toBe("completed"));
   expect(nativeSend).toHaveBeenCalledOnce();
   expect(nativeSend.mock.calls[0]?.[1]).toMatchObject({origin:"automation",inputId:request.inputId});
   expect(nativeSend.mock.calls[0]?.[1]?.humanRequestedAt).toBeUndefined();
   const job=jobs.list(10).find(job=>job.id===receipt.jobId);
   expect(jobs.list(10).filter(job=>job.ownerSessionId===request.target.nativeSessionId)).toHaveLength(1);
   expect(job?.result).toMatchObject({ok:true,admitted:true,turnId:"native-turn",inputId:request.inputId});
   await delivery.getMinimaxExecPolicy({hostId:"target",harness:"minimax-code",sessionId:request.target.nativeSessionId});
  }finally{delivery.close();await rm(dir,{recursive:true,force:true});}
 });
});
