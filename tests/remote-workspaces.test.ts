import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {CoordinationNoteStore} from '../src/coordination-notes.js';
import {registerWorkspaceTools} from '../src/mesh/workspace-tools.js';
import {unwrapResult,compactSession} from '../src/mesh/protocol.js';
import {HerderEventBus} from '../src/herder-events.js';
import {HerderJobRegistry} from '../src/herder-jobs.js';
import {HumanRequestRegistry} from '../src/human-request/registry.js';
import {HarnessEventHealthRegistry} from '../src/harness-event-health.js';
import {registerHerderResources} from '../src/mcp/resources.js';
import {projectPeerSession} from '../src/mesh/gptadmin.js';
let root:string;const clients:Client[]=[];
afterEach(async()=>{await Promise.all(clients.splice(0).map(c=>c.close()));if(root)await rm(root,{recursive:true,force:true});});
async function node(hostId:string,transport:any){
 const store=new CoordinationNoteStore(join(root,hostId+'.json'));const server=new McpServer({name:hostId,version:'1'});registerWorkspaceTools(server,{hostId,coordination:store,transport});
 const events=new HerderEventBus();registerHerderResources(server,{adapters:new Map(),coordination:store,events,jobs:new HerderJobRegistry(events),humanRequests:new HumanRequestRegistry(join(root,hostId+'-human.json'),events),eventHealth:new HarnessEventHealthRegistry()});
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'workspace-test',version:'1'});await server.connect(b);await client.connect(a);clients.push(client);
 return {store,read:async(uri:string)=>client.readResource({uri}),call:async(name:string,args:any)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result));return unwrapResult(result);}};
}
describe('actual host workspace MCP',()=>{
 it('declares100→88, preserves launch address, shares remote conflicts and separates equal local path',async()=>{
  root=await mkdtemp(join(tmpdir(),'herder-workspace-'));const work=join(root,'project');await mkdir(work);
  const remote=await node('host88',{call:()=>{throw new Error('unexpected onward route');}});
  const requests:any[]=[];const local=await node('host100',{call:async(target:string,name:string,args:any)=>{requests.push({target,name});return remote.call(name,args);}});
  const id={sessionId:'codex100',harness:'codex'};
  const declared=await local.call('workspace_declare',{...id,hostId:'host88',cwd:work});expect(declared.session).toEqual({hostId:'host100',harness:'codex',nativeSessionId:'codex100'});expect(declared.workspace).toMatchObject({hostId:'host88',cwd:work,source:'declared'});
  await local.store.heartbeatSession({sessionId:id.sessionId,cwd:'/local'});expect(await local.store.activeWorkspaceObservation(id.sessionId)).toMatchObject({hostId:'host88'});
  await remote.store.create({authorSessionId:'native88',kind:'working',cwd:work,hostId:'host88',message:'editing file',paths:['src/a.ts']});
  await local.store.create({authorSessionId:'native100',kind:'working',cwd:work,hostId:'host100',message:'independent local file',paths:['src/a.ts']});
  const activity=await local.call('workspace_activity',{...id,paths:['src/a.ts']});expect((activity.conflicts as any[]).map(x=>x.note.authorSessionId)).toEqual(['native88']);
  const resource=await remote.read('herder://coordination/workspaces/'+encodeURIComponent(JSON.stringify(['host88',work])));expect(JSON.parse(resource.contents[0].text as string).some((n:any)=>n.authorSessionId==='native88')).toBe(true);
  const on88=await remote.call('workspace_owners',{cwd:work});expect((on88.owners as any[]).some(x=>x.authorSessionId==='["host100","codex","codex100"]')).toBe(true);
  expect((await local.call('workspace_status',id)).workspace).toMatchObject({hostId:'host88'});
  const observed=await local.store.activeWorkspaceObservation(id.sessionId);
  const session=compactSession('host100',{id:id.sessionId,harness:'codex',cwd:'/launch',status:'running',title:'work',lastActivity:'now',meta:{activeCwd:observed!.cwd,workspaceHostId:observed!.hostId,projectSource:observed!.source}});
  expect(projectPeerSession(session,'host100')).toMatchObject({address:{hostId:'host100'},project:{launchCwd:'/launch',currentCwd:work,hostId:'host88'}});
  await local.call('workspace_release',id);expect(await local.store.activeWorkspaceObservation(id.sessionId)).not.toMatchObject({source:'declared'});
  expect(requests.every(r=>r.target==='mcp:shell:host88:AgentHerder')).toBe(true);
 });
 it('locates one project across the fleet with explicit absent and unreachable hosts',async()=>{
  root=await mkdtemp(join(tmpdir(),'herder-locate-'));const work=join(root,'project');await mkdir(work);
  const remote=await node('host88',{call:async(_target:string,name:string,args:any)=>{if(name==='workspace_probe')return {hostId:'host88',cwd:(args as {cwd:string}).cwd};return {hostId:'host88'};}});
  const transport={discover:async()=>({servers:[{kind:'child_mcp',server_id:'mcp:shell:host100:AgentHerder',status:'online'},{kind:'child_mcp',server_id:'mcp:shell:host88:AgentHerder',status:'online'},{kind:'child_mcp',server_id:'mcp:shell:host44:AgentHerder',status:'online'}]}),call:async(target:string,name:string,args:any)=>{if(target.includes(':host88:'))return remote.call(name,args);throw new Error('ssh: connect to host host44 port 22: Connection refused');}};
  const local=await node('host100',transport);
  const answer=await local.call('workspace_locate',{cwd:work});
  expect(answer).toMatchObject({cwd:work,localHostId:'host100'});
  const hosts=(answer.hosts as Array<Record<string,unknown>>).slice().sort((a,b)=>String(a.hostId).localeCompare(String(b.hostId)));
  expect(hosts).toEqual([
   {hostId:'host100',cwd:work,present:true},
   {hostId:'host44',present:false,reason:'host_unreachable'},
   {hostId:'host88',cwd:work,present:true},
  ]);
 });
 it('refuses nonexistent directories and wrong peer host without persisting a declaration',async()=>{
  root=await mkdtemp(join(tmpdir(),'herder-workspace-'));const local=await node('host100',{call:async()=>({hostId:'wrong',cwd:'/unverified'})});
  await expect(local.call('workspace_declare',{sessionId:'s',harness:'codex',hostId:'host88',cwd:'/repo'})).rejects.toThrow('workspace_peer_identity_mismatch');
  expect(await local.store.activeWorkspaceObservation('s')).toBeUndefined();
  await expect(local.call('workspace_declare',{sessionId:'s',harness:'codex',hostId:'host100',cwd:join(root,'absent')})).rejects.toThrow();
  await expect(local.call('workspace_activity',{sessionId:'s',harness:'codex',paths:['x']})).rejects.toThrow('workspace_declaration_required');
 });
});
