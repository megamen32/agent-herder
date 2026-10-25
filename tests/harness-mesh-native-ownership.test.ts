import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {CoordinationNoteStore} from '../src/coordination-notes.js';
import {registerWorkspaceTools} from '../src/mesh/workspace-tools.js';
import {LocalHarnessMesh} from '../src/mesh/local.js';
import {HerderEventBus} from '../src/herder-events.js';
import {HerderJobRegistry} from '../src/herder-jobs.js';
import {UserMessageDelivery} from '../src/user-message-delivery.js';
import {MinimaxExecPolicyStore} from '../src/permission-control/minimax-exec-policy.js';
import {unwrapResult} from '../src/mesh/protocol.js';
import {TRUSTED_MESH_MCP_CLIENT_ID,TRUSTED_MESH_MCP_SCOPE,trustedMeshIngressFromMcpAuthInfo} from '../src/mesh/authenticated-ingress.js';

let root:string;const clients:Client[]=[];
afterEach(async()=>{await Promise.all(clients.splice(0).map(c=>c.close()));if(root)await rm(root,{recursive:true,force:true});});

/** One node of the fleet with its own workspace state and its own native sessions. */
async function node(hostId:string,transport:any){
 const store=new CoordinationNoteStore(join(root,hostId+'.json'));const server=new McpServer({name:hostId,version:'1'});
 registerWorkspaceTools(server,{hostId,coordination:store,transport});
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'workspace-test',version:'1'});await server.connect(b);await client.connect(a);clients.push(client);
 return {store,call:async(name:string,args:any)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result));return unwrapResult(result);}};
}

describe('remote ownership of a native MiniMax Code session',()=>{
 it('reserves on the remote host, reports the conflict and delivers it to the native session',async()=>{
  root=await mkdtemp(join(tmpdir(),'herder-native-ownership-'));const work=await realpath(await mkdtemp(join(root,'project')));
  const remote=await node('host88',{call:()=>{throw new Error('unexpected onward route');}});
  // The native session of the remote machine, reached through its own mesh.
  const delivered:any[]=[];
  const nativeAdapter={type:'minimax-code',getSession:async()=>({id:'mvs_native',harness:'minimax-code',status:'idle',title:'t',cwd:work,hostId:'host88',lastActivity:new Date().toISOString(),needsPermission:false}),sendMessage:async(id:string,options:any)=>{delivered.push({id,options});return {ok:true,admitted:true,turnId:'item-1',inputId:options.inputId};},isReady:()=>true};
  const nativeJobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,'host88-jobs.json')});
  const nativeDelivery=new UserMessageDelivery(new Map([['minimax-code',nativeAdapter as any]]),{sendMessage:async(_harness,id,options)=>nativeAdapter.sendMessage(id,options)},nativeJobs,{pollMs:1,maxWaitMs:2_000,maxPending:4},new MinimaxExecPolicyStore(join(root,'host88-policies.json')));
  const macMesh=new LocalHarnessMesh({hostId:'host88',adapters:new Map([['minimax-code',nativeAdapter as any]]),userMessageDelivery:nativeDelivery,supervisor:{sendMessage:async(_harness,id,options)=>nativeAdapter.sendMessage(id,options)},ledgerPath:join(root,'mac-ledger.json'),nativeObserve:async(_harness,id)=>({nativeSessionId:id,status:'idle',cwd:work})});
  const ingress=trustedMeshIngressFromMcpAuthInfo({token:'owner-mcp-test',clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]})!;
  const requests:any[]=[];
  const local=await node('host100',{call:async(target:string,name:string,args:any)=>{requests.push({target,name});if(name==='mesh_deliver')return macMesh.deliver(args,ingress);return remote.call(name,args);}});
  // The remote machine already owns the path of another session.
  await remote.store.create({authorSessionId:'native88',kind:'working',cwd:work,hostId:'host88',message:'editing file',paths:['src/a.ts']});
  const identity={sessionId:'mvs_native',harness:'minimax-code'};
  const declared=await local.call('workspace_declare',{...identity,hostId:'host88',cwd:work});
  expect(declared.workspace).toMatchObject({hostId:'host88',cwd:work,source:'declared'});
  // The reservation of the hub is proxied to the machine that owns the paths.
  const activity=await local.call('workspace_activity',{...identity,paths:['src/a.ts']});
  expect((activity.conflicts as any[]).map(c=>c.note.authorSessionId)).toEqual(['native88']);
  expect(requests.filter(r=>r.name==='workspace_reserve').every(r=>r.target==='mcp:shell:host88:AgentHerder')).toBe(true);
  // The conflict reaches the native session through the mesh delivery.
  const receipt=await macMesh.deliver({target:{hostId:'host88',harness:'minimax-code',nativeSessionId:'mvs_native'},sender:{hostId:'host100',harness:'codex',nativeSessionId:'s'},inputId:'conflict-1',message:'Conflict on src/a.ts: native88 owns it.'},ingress);
  expect(['queued','admitted']).toContain(receipt.state);
  await vi.waitFor(()=>expect(nativeJobs.list(10).some(job=>job.ownerSessionId==='mvs_native'&&job.state==='completed')).toBe(true));
  expect((await macMesh.deliver({target:{hostId:'host88',harness:'minimax-code',nativeSessionId:'mvs_native'},sender:{hostId:'host100',harness:'codex',nativeSessionId:'s'},inputId:'conflict-1',message:'Conflict on src/a.ts: native88 owns it.'},ingress)).state).toBe('admitted');
  expect(String(delivered[0]?.options?.message??'')).toContain('src/a.ts');
  expect(delivered[0]?.options).toMatchObject({origin:'automation',steer:false,inputId:'conflict-1'});
  expect(delivered[0]?.options?.humanRequestedAt).toBeUndefined();
  nativeDelivery.close();
 });
 it('keeps a native session of the remote machine apart from a local session of the same id',async()=>{
  root=await mkdtemp(join(tmpdir(),'herder-native-ownership-'));const work=await realpath(await mkdtemp(join(root,'project')));
  const remote=await node('host88',{call:()=>{throw new Error('unexpected onward route');}});
  const local=await node('host100',{call:async(_target:string,name:string,args:any)=>remote.call(name,args)});
  const identity={sessionId:'mvs_native',harness:'minimax-code'};
  await local.call('workspace_declare',{...identity,hostId:'host88',cwd:work});
  // A reservation of an owner of another machine keeps the full address, so
  // a local session of the same native id can never collide with it.
  const reserved=await remote.call('workspace_reserve',{owner:{hostId:'host100',harness:'minimax-code',nativeSessionId:'mvs_native'},cwd:work,paths:['src/a.ts']});
  expect((reserved.reservations as any[])[0]?.authorSessionId).toBe(JSON.stringify(['host100','minimax-code','mvs_native']));
  const owners=await remote.call('workspace_owners',{cwd:work});
  expect((owners.owners as any[]).some(o=>o.authorSessionId===JSON.stringify(['host100','minimax-code','mvs_native']))).toBe(true);
 });
});
