import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
const state=vi.hoisted(()=>({home:'',spawns:[] as any[],reply:{} as any}));
vi.mock('node:os',()=>({hostname:()=>'roomhacker-server-100',userInfo:()=>({username:'roomhacker'}),homedir:()=>state.home,platform:()=>'linux'}));
vi.mock('node:child_process',()=>({spawn:(bin:string,args:string[])=>{
 const child=new EventEmitter() as any;
 child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=vi.fn(()=>queueMicrotask(()=>child.emit('close',137,'SIGKILL')));
 child.stdin=new EventEmitter();child.stdin.end=(body:string)=>{const parsed=JSON.parse(body);state.spawns.push({bin,args,body:parsed});queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify(state.reply)));child.emit('close',0);});};
 return child;
}}));
import {FleetDirectTransport,setFleetMeshTransportFactory,resetFleetMeshTransportFactory} from '../src/mesh/fleet-direct-transport.js';
import {readFleetMeshBinding,meshFleetTarget,MESH_FLEET_CHILD_REF} from '../src/mesh/fleet-mesh-binding.js';
import type {GptAdminTransport} from '../src/mesh/gptadmin.js';

const remote={hostId:'server-44',sshHost:'192.168.2.5',nativeUser:'roomhacker',port:18791,python:'/usr/bin/python3'};
const local={hostId:'roomhacker-server-100',sshHost:'192.168.2.100',nativeUser:'roomhacker',port:18787,python:'/usr/bin/python3'};
const mini={hostId:'mac-mini-2012.lan',sshHost:'192.168.2.4',nativeUser:'roomhacker',port:18789,python:'/usr/bin/python3'};
/** A recording stub of the mesh lane. */
function stubMesh(answers:{[tool:string]:unknown}={}){
 const calls:{target:string;tool:string;args:Record<string,unknown>}[]=[];
 const mesh:GptAdminTransport={
  async discover(){return {servers:[{server_id:'shell:server-44',kind:'virtual_shell',status:'online'},{server_id:'mcp:shell:server-44:HerderFleet',kind:'child_mcp',status:'online'}]};},
  async schema(){return {tools:[{name:'fleet_node_info'},{name:'mesh_snapshot'},{name:'automation_disarm'}]};},
  async call(target,tool,args){calls.push({target,tool,args});const answer=answers[tool];if(answer instanceof Error)throw answer;return answer??{ok:true};},
 };
 return {mesh,calls};
}
beforeEach(async()=>{const {tmpdir}=await vi.importActual<typeof import('node:os')>('node:os');state.home=await mkdtemp(join(tmpdir(),'mesh-fleet-'));state.spawns=[];state.reply={};vi.stubEnv('AGENT_HERDER_AUTOPILOT_STATE_DIR','/tmp/herder-quota-policy-none');});
afterEach(async()=>{resetFleetMeshTransportFactory();await rm(state.home,{recursive:true,force:true});vi.useRealTimers();vi.unstubAllEnvs();});

describe('mesh-first fleet routing',()=>{
 it('answers a remote tool call through the mesh child, not an SSH bridge',async()=>{
  const {mesh,calls}=stubMesh({model_quotas:{structuredContent:{providers:[]}}});
  const transport=new FleetDirectTransport([remote],10_000,mesh);
  await transport.call('mcp:shell:server-44:AgentHerder','fleet_node_info',{});
  expect(calls.map(c=>c.tool)).toEqual(['fleet_node_info']);
  expect(calls[0]!.target).toBe('mcp:shell:server-44:HerderFleet');
  expect(state.spawns).toHaveLength(0);
 });
 it('maps a fleet host id to its mesh node name for the Mac mini',async()=>{
  const {mesh,calls}=stubMesh({model_quotas:{structuredContent:{providers:[]}}});
  const transport=new FleetDirectTransport([mini],10_000,mesh);
  await transport.call('mcp:shell:mac-mini-2012.lan:AgentHerder','fleet_node_info',{});
  expect(calls[0]!.target).toBe('mcp:shell:mac-mini-node:HerderFleet');
 });
 it('keeps the local machine on its in-process bridge even with a mesh lane',async()=>{
  const {mesh,calls}=stubMesh();
  const transport=new FleetDirectTransport([local],10_000,mesh);
  await transport.call('mcp:shell:roomhacker-server-100:AgentHerder','fleet_node_info',{});
  expect(calls).toHaveLength(0);
  expect(state.spawns).toHaveLength(1);
  expect(state.spawns[0]!.bin).toBe(local.python);
 });
 it('falls back to the SSH bridge when the mesh lane is explicitly absent',async()=>{
  const transport=new FleetDirectTransport([remote],10_000,null);
  await transport.call('mcp:shell:server-44:AgentHerder','fleet_node_info',{});
  expect(state.spawns).toHaveLength(1);
  expect(state.spawns[0]!.bin).toBe('/usr/bin/ssh');
 });
 it('maps create_session to the fleet create tool with its idempotency key',async()=>{
  const {mesh,calls}=stubMesh({model_quotas:{structuredContent:{checkedAt:new Date().toISOString(),providers:[{provider:'codex',state:'reported',checkedAt:new Date().toISOString(),details:{primary_used:0,secondary_used:0,allowed:true,limit_reached:false}}]}}});
  const transport=new FleetDirectTransport([remote],10_000,mesh);
  await transport.call('mcp:shell:server-44:AgentHerder','create_session',{harness:'codex'},'a'.repeat(64));
  expect(calls.map(c=>c.tool)).toEqual(['model_quotas','fleet_create_session']);
  expect(calls[1]!.args).toMatchObject({harness:'codex',inputId:'a'.repeat(64)});
 });
 it('serves a remote session read through the verified mesh identity path',async()=>{
  const {mesh,calls}=stubMesh({
   fleet_node_info:{hostId:'server-44',nativeUser:'roomhacker'},
   agent_info:{session:{hostId:'server-44',id:'op-1',harness:'codex'}},
  });
  const transport=new FleetDirectTransport([remote],10_000,mesh);
  const view=await transport.readSession('mcp:shell:server-44:AgentHerder','codex','op-1');
  expect((view as any).session).toMatchObject({hostId:'server-44',id:'op-1'});
  expect(calls.map(c=>c.tool)).toEqual(['fleet_node_info','agent_info']);
 });
 it('refuses a mesh session read whose node identity disagrees',async()=>{
  const {mesh}=stubMesh({
   fleet_node_info:{hostId:'server-88',nativeUser:'roomhacker'},
  });
  const transport=new FleetDirectTransport([remote],10_000,mesh);
  await expect(transport.readSession('mcp:shell:server-44:AgentHerder','codex','op-1')).rejects.toThrow('native_owner_identity_mismatch');
 });
 it('projects the real mesh registry onto the fleet host ids',async()=>{
  const {mesh}=stubMesh();
  const transport=new FleetDirectTransport([remote,mini],10_000,mesh);
  const registry=await transport.discover() as {servers:{server_id:string;status:string}[]};
  const byId=new Map(registry.servers.map(s=>[s.server_id,s.status]));
  expect(byId.get('shell:server-44')).toBe('online');
  expect(byId.get('mcp:shell:server-44:AgentHerder')).toBe('online');
  // The Mac mini node and child are absent from this registry: both entries
  // must say so honestly instead of claiming the configured SSH view.
  expect(byId.get('shell:mac-mini-2012.lan')).toBe('offline');
  expect(byId.get('mcp:shell:mac-mini-2012.lan:AgentHerder')).toBe('offline');
 });
 it('keeps the configured SSH view when the mesh registry cannot be read',async()=>{
  const failing:GptAdminTransport={
   async discover(){throw new Error('gptadmin_http_502');},
   async schema(){throw new Error('gptadmin_http_502');},
   async call(){throw new Error('gptadmin_http_502');},
  };
  const transport=new FleetDirectTransport([remote],10_000,failing);
  const registry=await transport.discover() as {servers:{server_id:string;status:string}[]};
  expect(registry.servers.every(s=>s.status==='configured')).toBe(true);
 });
});

describe('fleet mesh binding',()=>{
 const token='gtok_abcdef0123456789';
const endpoint='https://u-f1102930.t.gptadmin.bezrabotnyi.com/mcp';
 async function writeConfig(origin=endpoint){
  await mkdir(join(state.home,'.zcode','cli'),{recursive:true});
  await writeFile(join(state.home,'.zcode','cli','config.json'),JSON.stringify({mcp:{servers:{gptadmin:{url:origin,headers:{Authorization:'Bearer '+token}}}}}));
 }
 it('accepts the pinned credential of the gptadmin origin',async()=>{
  await writeConfig();
  const {createHash}=await import('node:crypto');
  const pin=createHash('sha256').update(JSON.stringify([endpoint,{Authorization:'Bearer '+token}])).digest('hex');
  const binding=await readFleetMeshBinding({pin});
  expect(binding?.endpoint).toBe(endpoint);
  expect(binding?.headers.Authorization).toBe('Bearer '+token);
 });
 it('refuses a rotated credential and a foreign origin',async()=>{
  await writeConfig();
  const wrong=await readFleetMeshBinding({pin:'0'.repeat(64)});
  expect(wrong).toBeUndefined();
  await writeConfig('https://evil.example.com/mcp');
  const {createHash}=await import('node:crypto');
  const pin=createHash('sha256').update(JSON.stringify(['https://evil.example.com/mcp',{Authorization:'Bearer '+token}])).digest('hex');
  expect(await readFleetMeshBinding({pin})).toBeUndefined();
 });
 it('names the fleet child ref of the mesh lane',()=>{
  expect(MESH_FLEET_CHILD_REF).toBe('HerderFleet');
  expect(meshFleetTarget('server-44')).toBe('mcp:shell:server-44:HerderFleet');
  expect(meshFleetTarget('mac-mini-2012.lan')).toBe('mcp:shell:mac-mini-node:HerderFleet');
 });
});
