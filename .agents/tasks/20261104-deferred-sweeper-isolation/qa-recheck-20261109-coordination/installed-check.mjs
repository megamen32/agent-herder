
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const release='/home/roomhacker/agents-projects/.fleet-candidate/releases/fd99743bcc1875879315ff508b551e5e722b63cc';
const req=createRequire(release+'/package.json');
const {Client,InMemoryTransport}=await import(req.resolve('@modelcontextprotocol/client'));
const {McpServer}=await import(req.resolve('@modelcontextprotocol/server'));
const {CoordinationNoteStore}=await import('file://'+release+'/dist/coordination-notes.js');
const {registerWorkspaceTools}=await import('file://'+release+'/dist/mesh/workspace-tools.js');
const {unwrapResult}=await import('file://'+release+'/dist/mesh/protocol.js');
const root=process.argv[2];const clients=[];const requests=[];const checks=[];
async function node(hostId,transport){
 const store=new CoordinationNoteStore(join(root,hostId+'.json'));const server=new McpServer({name:hostId,version:'test'});
 registerWorkspaceTools(server,{hostId,coordination:store,transport});
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'isolated-workspace-test',version:'1'});
 await server.connect(b);await client.connect(a);clients.push(client);
 return {store,call:async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return unwrapResult(r);}};
}
try{
 const work=join(root,'project');await mkdir(work);
 const remote=await node('fixture88',{call:()=>{throw Error('onward network forbidden in fixture');}});
 const local=await node('fixture100',{call:async(target,name,args)=>{requests.push(target);assert.equal(target,'mcp:shell:fixture88:AgentHerder');return remote.call(name,args);}});
 const id={sessionId:'fixture-session',harness:'codex'};
 const d=await local.call('workspace_declare',{...id,hostId:'fixture88',cwd:work});
 assert.equal(d.workspace.hostId,'fixture88');assert.equal(d.session.hostId,'fixture100');checks.push('declare-preserves-launch-host');
 await remote.store.create({authorSessionId:'other-fixture88',kind:'working',cwd:work,hostId:'fixture88',message:'test overlap',paths:['src/a.ts']});
 await local.store.create({authorSessionId:'other-fixture100',kind:'working',cwd:work,hostId:'fixture100',message:'independent same path',paths:['src/a.ts']});
 const act=await local.call('workspace_activity',{...id,paths:['src/a.ts']});
 assert.deepEqual(act.conflicts.map(x=>x.note.authorSessionId),['other-fixture88']);checks.push('reservation-conflict-on-work-host');checks.push('same-path-other-host-isolated');
 const owners=await remote.call('workspace_owners',{cwd:work});
 assert.ok(owners.owners.some(x=>x.authorSessionId==='["fixture100","codex","fixture-session"]'));checks.push('remote-owner-address-preserved');
 await local.call('workspace_release',id);assert.notEqual((await local.store.activeWorkspaceObservation(id.sessionId))?.source,'declared');checks.push('release-clears-declaration');
 const wrong=await node('fixtureWrong',{call:async()=>({hostId:'mismatch',cwd:'/unverified'})});
 await assert.rejects(wrong.call('workspace_declare',{sessionId:'not-admitted',harness:'codex',hostId:'fixture88',cwd:work}),/workspace_peer_identity_mismatch/);
 assert.equal(await wrong.store.activeWorkspaceObservation('not-admitted'),undefined);checks.push('wrong-peer-no-persist');
 await assert.rejects(wrong.call('workspace_declare',{sessionId:'missing',harness:'codex',hostId:'fixtureWrong',cwd:join(root,'absent')}));
 await assert.rejects(wrong.call('workspace_activity',{sessionId:'missing',harness:'codex',paths:['x']}),/workspace_declaration_required/);checks.push('missing-path-undeclared-activity-rejected');
 console.log(JSON.stringify({passed:checks.length,checks,scope:'installed compiled MCP handlers, in-memory transport, temporary data only',realNetworkCalls:0,realSessionLaunches:0,release,requests:requests.length}));
}finally{await Promise.all(clients.map(c=>c.close()));}
