import {access,mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {registerHarnessMeshTools} from "../src/mesh/register-tools.js";
import type {McpServer} from "@modelcontextprotocol/server";
import {HerderEventBus} from "../src/herder-events.js";
import {HerderJobRegistry} from "../src/herder-jobs.js";
import {UserMessageDelivery} from "../src/user-message-delivery.js";
import {MinimaxExecPolicyStore} from "../src/permission-control/minimax-exec-policy.js";
import {checkDeliveryModel} from "../src/project-model-delivery-gate.js";
import {holdManualStop} from "../src/human-stop-actions.js";
import {TRUSTED_MESH_MCP_CLIENT_ID,TRUSTED_MESH_MCP_SCOPE,trustedMeshIngressFromMcpAuthInfo} from "../src/mesh/authenticated-ingress.js";
import type {HarnessAdapter,SendMessageResult} from "../src/types/index.js";

afterEach(()=>vi.unstubAllEnvs());

const nativeSession={id:"mvs_native",harness:"minimax-code",status:"idle",title:"t",cwd:"/work",hostId:"h",lastActivity:new Date().toISOString(),needsPermission:false};
const request={target:{hostId:"h",harness:"minimax-code",nativeSessionId:"mvs_native"},sender:{hostId:"src",harness:"opencode",nativeSessionId:"s"},inputId:"i-1",message:"delta"};
function setup(dir:string,options:{status?:string;nativeStatus?:string;nativeRead?:boolean;steer?:boolean;result?:SendMessageResult;notes?:(message:string)=>Promise<string>}={}){
 const session={...nativeSession,status:options.status??"idle"};
 const sendMessage=vi.fn(async(_id:string,sendOptions:any)=>options.result??({ok:true,admitted:true,turnId:"item-1",inputId:sendOptions.inputId}));
 const adapter={type:"minimax-code",getSession:vi.fn(async()=>session),sendMessage,isReady:()=>true,controlCapabilities:{steer:options.steer??false}} as unknown as HarnessAdapter;
 const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(dir,"jobs.json")});
 const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage:async(_harness,id,sendOptions)=>sendMessage(id,sendOptions)},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:4},new MinimaxExecPolicyStore(join(dir,"policies")));
 const ledgerPath=join(dir,"mesh-ledger.json");
 const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]),ledgerPath,userMessageDelivery:delivery,
  supervisor:{sendMessage:async(_harness,id,sendOptions)=>sendMessage(id,sendOptions)},
  ...(options.nativeRead===false?{nativeObserve:async()=>null}:{nativeObserve:async(_h,id)=>({nativeSessionId:id,status:options.nativeStatus??session.status,cwd:"/work"})}),
  notes:async(_session,message)=>options.notes?options.notes(message):message});
 const ingress=trustedMeshIngressFromMcpAuthInfo({token:"test-transport-token",clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]})!;
 return {mesh,deliver:(value=request)=>mesh.deliver(value,ingress),ingress,delivery,jobs,sendMessage,adapter,ledgerPath,session};
}
const waitJob=async(f:ReturnType<typeof setup>)=>await vi.waitFor(()=>{
 const row=f.jobs.list(10).find(j=>j.ownerSessionId==="mvs_native");expect(row?.state).toBe("completed");return row;
});
async function cleanup(dir:string,f:ReturnType<typeof setup>){
 f.delivery.close();await f.delivery.getMinimaxExecPolicy({hostId:"h",harness:"minimax-code",sessionId:"mvs_native"});
 await f.delivery.getMinimaxExecPolicy({hostId:"h",harness:"minimax-code",sessionId:"mvs_native"});
 await rm(dir,{recursive:true,force:true});
}

describe("native MiniMax Code common delivery core",()=>{
 it("does not treat a caller-supplied sender address as an authenticated agent ingress",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-forged-sender-"));const f=setup(dir);
  try{
   const receipt=await f.mesh.deliver({...request,sender:{hostId:"claimed-source",harness:"opencode",nativeSessionId:"claimed-session"}});
   expect(receipt).toMatchObject({state:"not_attempted",retryable:false,reason:"authenticated_mesh_ingress_required"});
   expect(f.sendMessage).not.toHaveBeenCalled();
   expect(f.jobs.list(10)).toHaveLength(0);
  }finally{await cleanup(dir,f);}
 });

 it("binds authenticated principal per MCP request and does not leak it to a later unauthenticated request",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-auth-context-"));const f=setup(dir);
  const handlers:Record<string,(args:any,extra:any)=>Promise<any>>={};
  const server={registerTool:(name:string,_config:unknown,handler:(args:any,extra:any)=>Promise<any>)=>{handlers[name]=handler;}} as unknown as McpServer;
  try{
   const invalidIngress=trustedMeshIngressFromMcpAuthInfo({token:"x",clientId:"other",scopes:[TRUSTED_MESH_MCP_SCOPE]});
   expect(invalidIngress).toBeUndefined();
   registerHarnessMeshTools(server,{hostId:"h",adapters:new Map([["minimax-code",f.adapter]]),ledgerPath:join(dir,"registered-mesh-ledger.json"),userMessageDelivery:f.delivery,
    supervisor:{sendMessage:async(_harness,id,opts)=>f.sendMessage(id,opts)},nativeObserve:async(_harness,id)=>({nativeSessionId:id,status:"idle",cwd:"/work"}),trustedIngress:f.ingress});
   const bound=handlers.mesh_deliver!;
   const valid=await bound({...request,sender:{hostId:"caller-chosen",harness:"opencode",nativeSessionId:"arbitrary"}},{authInfo:{token:"not-used-at-dispatch",clientId:"other",scopes:[]}});
   expect(JSON.parse(valid.content[0].text).state).toBe("queued");
   await waitJob(f);
   const claim=f.sendMessage.mock.calls[0]?.[1]?.durableUserDelivery;
   expect(claim?.actor).toMatchObject({kind:"agent",principal:TRUSTED_MESH_MCP_CLIENT_ID,senderVerified:false,senderAssertion:{hostId:"caller-chosen",harness:"opencode",nativeSessionId:"arbitrary"}});
   expect(f.sendMessage).toHaveBeenCalledOnce();
   const unauthenticatedHandlers:Record<string,(args:any,extra:any)=>Promise<any>>={};
   const unauthenticatedServer={registerTool:(name:string,_config:unknown,handler:(args:any,extra:any)=>Promise<any>)=>{unauthenticatedHandlers[name]=handler;}} as unknown as McpServer;
   registerHarnessMeshTools(unauthenticatedServer,{hostId:"h",adapters:new Map([["minimax-code",f.adapter]]),ledgerPath:join(dir,"registered-mesh-ledger.json"),userMessageDelivery:f.delivery,
    supervisor:{sendMessage:async(_harness,id,opts)=>f.sendMessage(id,opts)},nativeObserve:async(_harness,id)=>({nativeSessionId:id,status:"idle",cwd:"/work"})});
   const later=await unauthenticatedHandlers.mesh_deliver!({...request,inputId:"after-unauthenticated-request"},{authInfo:{token:"forged",clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]}});
   expect(JSON.parse(later.content[0].text)).toMatchObject({state:"not_attempted",retryable:false,reason:"authenticated_mesh_ingress_required"});
   expect(f.sendMessage).toHaveBeenCalledOnce();
   expect(f.jobs.list(10)).toHaveLength(1);
  }finally{await cleanup(dir,f);}
 });

 it("rechecks HumanStop after queued waiting and blocks the native write without replay",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-before-dispatch-"));
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE",join(dir,"stops.json"));
  const f=setup(dir,{status:"running"});
  try{
   const queued=await f.deliver({...request,inputId:"stop-while-queued"});
   expect(queued.state).toBe("queued");
   await vi.waitFor(()=>expect(f.adapter.getSession.mock.calls.length).toBeGreaterThan(1));
   await holdManualStop(f.session as any);
   f.session.status="idle";
   const job=await waitJob(f);
   expect(job?.result).toMatchObject({ok:false,notSubmitted:true,nonRetryable:true,inputId:"stop-while-queued"});
   expect(f.sendMessage).not.toHaveBeenCalled();
   expect(await f.deliver({...request,inputId:"stop-while-queued"})).toMatchObject({state:"not_attempted",retryable:false});
   expect(f.sendMessage).not.toHaveBeenCalled();
  }finally{await cleanup(dir,f);}
 });

 it("routes idle agent work through one durable job/claim and never records a separate mesh outcome",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-shared-core-"));const f=setup(dir,{notes:async message=>`visible note\n${message}`});
  try{
   const first=await f.deliver(request);
   expect(["queued","admitted"]).toContain(first.state);
   const row=await waitJob(f);
   expect(row?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
   const delivered=await f.deliver(request);
   expect(delivered).toMatchObject({state:"admitted",turnId:"item-1",retryable:false});
   expect(f.sendMessage).toHaveBeenCalledOnce();
   expect(f.sendMessage.mock.calls[0]?.[1]).toMatchObject({origin:"automation",steer:false,inputId:request.inputId});
   expect(f.sendMessage.mock.calls[0]?.[1]?.humanRequestedAt).toBeUndefined();
   expect(f.sendMessage.mock.calls[0]?.[1]?.message).toContain("visible note");
   await expect(access(f.ledgerPath)).rejects.toThrow();
  }finally{await cleanup(dir,f);}
 });

 it("uses the existing current-turn path for an active native session when steer is supported",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-steer-"));const f=setup(dir,{status:"running",nativeStatus:"running",steer:true});
  try{
   const receipt=await f.deliver(request);
   expect(["queued","admitted"]).toContain(receipt.state);
   await waitJob(f);
   expect((await f.deliver(request)).state).toBe("admitted");
   expect(f.sendMessage.mock.calls[0]?.[1]).toMatchObject({steer:true,inputId:request.inputId,origin:"automation"});
   expect(f.sendMessage).toHaveBeenCalledOnce();
  }finally{await cleanup(dir,f);}
 });

 it("fails closed when the exact native observation or shared durable core is missing",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-unavailable-"));const f=setup(dir,{nativeRead:false});
  try{
   const receipt=await f.deliver(request);
   expect(receipt).toMatchObject({state:"not_attempted",reason:"independent_native_identity_unknown"});
   expect(f.sendMessage).not.toHaveBeenCalled();
   const noCore=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",f.adapter]]),ledgerPath:f.ledgerPath,nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"idle"})});
   expect(await noCore.deliver({...request,inputId:"without-core"},f.ingress)).toMatchObject({state:"not_attempted",reason:"shared_durable_delivery_core_unavailable"});
   expect(f.sendMessage).not.toHaveBeenCalled();
  }finally{await cleanup(dir,f);}
 });

 it("keeps ambiguous native admission terminal and does not replay it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-unknown-"));const f=setup(dir,{result:{ok:false,admissionUnknown:true,nonRetryable:true,error:"lost native receipt"}});
  try{
   await f.deliver(request);await waitJob(f);
   expect(await f.deliver(request)).toMatchObject({state:"unknown",retryable:false});
   expect(f.sendMessage).toHaveBeenCalledOnce();
  }finally{await cleanup(dir,f);}
 });

 it("rejects another host before common admission",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-remote-"));const f=setup(dir);
  try{
   expect(await f.mesh.deliver({...request,target:{...request.target,hostId:"mac"}})).toMatchObject({state:"not_attempted",reason:"native_host_identity_mismatch"});
   expect(f.sendMessage).not.toHaveBeenCalled();
  }finally{await cleanup(dir,f);}
 });

 it("uses the exact native DB workspace instead of the runtime-wide pseudo cwd for project policy",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-project-workspace-"));const f=setup(dir);
  try{
   const work=join(dir,"native-project");await mkdir(work);
   const adapter=f.adapter as HarnessAdapter&{getNativeWorkspaceDirectory:()=>Promise<any>};
   adapter.getNativeWorkspaceDirectory=vi.fn(async()=>({hostId:"h",harness:"minimax-code",sessionId:request.target.nativeSessionId,cwd:work}));
   (adapter.getSession as any)=vi.fn(async()=>({...nativeSession,cwd:"/home/agent/.minimax",meta:{workDirectory:"pseudo"}}));
   const policy={kind:"valid" as const,policy:{models:{"minimax-code":"model-b"},projectRoutes:{[work]:{deniedModels:["model-b"]}}}};
   expect(()=>checkDeliveryModel(policy,{directory:work,harness:"minimax-code"})).toThrow(/model_not_permitted_for_project/);
   const policyProvider=vi.fn(async()=>policy);
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]),deliveryPolicy:policyProvider,userMessageDelivery:f.delivery,
    nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"idle",cwd:work})});
   const receipt=await mesh.deliver({...request,inputId:"native-workspace-gate"},f.ingress);
   expect(policyProvider).toHaveBeenCalledOnce();
   expect(adapter.getNativeWorkspaceDirectory).toHaveBeenCalledWith(request.target.nativeSessionId);
   expect(receipt.reason).toContain(work);
   expect(receipt.reason).not.toContain("working directory of the session is unknown");
   expect(f.sendMessage).not.toHaveBeenCalled();
  }finally{await cleanup(dir,f);}
 });
});
