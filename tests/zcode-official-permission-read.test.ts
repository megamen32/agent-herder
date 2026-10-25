import {expect,it,vi} from 'vitest';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';

it('reads a pending permission from the existing official owner before reporting running',async()=>{
 const call=vi.fn(async(_channel:string,method:string)=>{
  if(method!=='readSession')throw Error('unexpected mutation or lookup: '+method);
  return {session:{sessionId:'known',status:'running',workspace:{workspacePath:'/repo'},model:{providerId:'account:zai',modelId:'GLM'}},runtime:{activeTurnId:'turn',pendingRequestIds:['perm']},projection:{pendingPermissions:[{requestId:'perm',toolName:'ctx_execute',reason:'High risk tools require explicit approval',riskLevel:'high',input:{secret:'must not expose'}}]}};
 });
 const adapter=new ZcodeAdapter({client:{start:async()=>{},call,close:async()=>{}},localDbPath:'/missing',tasksIndexDbPath:'/missing'});
 // Model the already-selected official WebSocket seam, without any live socket.
 Object.assign(adapter,{officialWebSocketSelected:true,officialRunning:{observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString(),pid:123,generation:1,tasks:[{sessionId:'known',workspacePath:'/repo'}]}});
 const session=await adapter.getSession('known');
 expect(session).toMatchObject({status:'needs_input',needsPermission:true,model:'account:zai/GLM',permissionDetails:{id:'perm',type:'permission',toolName:'ctx_execute',description:'High risk tools require explicit approval'}});
 expect(JSON.stringify(session?.permissionDetails)).not.toContain('must not expose');
 expect(call).toHaveBeenCalledWith('zcode-agent','readSession',[expect.objectContaining({sessionId:'known',workspacePath:'/repo',runtimePolicy:'existing-only'})]);
});

it('allows Fleet to read an official existing-owner seam while lazy initialization is false',async()=>{
 const session={id:'known',harness:'zcode',status:'needs_input',needsPermission:true,cwd:'/repo',title:'Task',hostId:'h',lastActivity:new Date().toISOString(),permissionDetails:{id:'perm',type:'permission',description:'Approval required'}};
 const tools=new Map<string,any>();
 const getSession=vi.fn(async()=>session);
 registerFleetNodeTools({registerTool:(name:string,_schema:any,handler:any)=>tools.set(name,handler)} as any,{adapters:new Map([['zcode',{lazyStart:true,isReady:()=>false,nativeReadWithoutActivation:true} as any]]),readSupervisor:{getSession,getSessionDetails:async()=>({session,messages:[],history:{source:'unavailable'}})} as any});
 const result=await tools.get('fleet_session_view')({harness:'zcode',sessionId:'known'});
 expect(result.structuredContent.details.session).toMatchObject({status:'needs_input',needsPermission:true,permissionDetails:{id:'perm'}});
 expect(getSession).toHaveBeenCalledOnce();
});

it('keeps sleeping adapters without an existing-owner read seam blocked',async()=>{
 const tools=new Map<string,any>(),getSession=vi.fn();
 registerFleetNodeTools({registerTool:(name:string,_schema:any,handler:any)=>tools.set(name,handler)} as any,{adapters:new Map([['zcode',{lazyStart:true,isReady:()=>false} as any]]),readSupervisor:{getSession} as any});
 await expect(tools.get('fleet_session_view')({harness:'zcode',sessionId:'known'})).rejects.toThrow('fleet_session_native_not_ready');
 expect(getSession).not.toHaveBeenCalled();
});

it.skipIf(!process.env.ZCODE_PERMISSION_READ_PROBE)('reads the exact existing Broker state without sending or answering anything',async()=>{
 const adapter=new ZcodeAdapter({cwd:'/home/roomhacker/PycharmProjects/account-broker'});
 try {
  await adapter.listActiveSessions();
  const session=await adapter.getSession('session_d609b412-12d2-44c0-999e-507aba8daba1');
  expect(session).toMatchObject({id:'session_d609b412-12d2-44c0-999e-507aba8daba1',cwd:'/home/roomhacker/PycharmProjects/account-broker'});
  expect(session?.model).toMatch(/^account:zai-individual-coding-plan\/GLM-5\.3-Flash(?:\$high)?$/);
  expect(session?.status).toBe(session?.needsPermission ? 'needs_input' : 'running');
  console.log(JSON.stringify({id:session?.id,status:session?.status,needsPermission:session?.needsPermission,model:session?.model,permissionDetails:session?.permissionDetails}));
 } finally {await adapter.dispose();}
});
