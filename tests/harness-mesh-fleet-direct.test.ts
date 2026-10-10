import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
const state=vi.hoisted(()=>({home:'',spawns:[] as any[],reply:{tools:[]},mode:'ok'}));
vi.mock('node:os',()=>({hostname:()=> 'server-44',userInfo:()=>({username:'roomhacker'}),homedir:()=>state.home,platform:()=> 'linux'}));
vi.mock('node:child_process',()=>({spawn:(bin:string,args:string[])=>{
 const child=new EventEmitter() as any;
 child.stdout=new EventEmitter();child.stderr={resume(){}};child.kill=vi.fn(()=>queueMicrotask(()=>child.emit('close',137)));
 child.stdin=new EventEmitter();child.stdin.end=(body:string)=>{state.spawns.push({bin,args,body:JSON.parse(body),child});queueMicrotask(()=>{if(state.mode==='exit')return child.emit('close',255);if(state.mode==='huge')child.stdout.emit('data',Buffer.alloc(1048577));else child.stdout.emit('data',Buffer.from(JSON.stringify(state.reply)));child.emit('close',0);});};
 return child;
}}));
import {FleetDirectTransport} from '../src/mesh/fleet-direct-transport.js';
import {isDirectOwnerRequest} from '../src/web/fleet-wiring.js';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';
const peer={hostId:'roomhacker-server-88',sshHost:'192.168.2.75',nativeUser:'roomhacker',port:18791,python:'/usr/bin/python3'};
beforeEach(async()=>{state.home=await mkdtemp(join(process.env.TMPDIR!,'direct-'));state.spawns=[];state.reply={tools:[]};state.mode='ok';});
afterEach(async()=>{await rm(state.home,{recursive:true,force:true});vi.useRealTimers();});
describe('owner direct route local logic only',()=>{
 it('configured routes never claim discovered health; real peer identity/snapshot is still required',async()=>{
  const t=new FleetDirectTransport([peer]);const r=await t.discover() as any;expect(r.servers.every((p:any)=>p.status==='configured')).toBe(true);expect(state.spawns).toHaveLength(0);
 });
 it('uses existing authenticated SSH and peer loopback HTTP without shell interpolation of user args',async()=>{
  const t=new FleetDirectTransport([peer]);await t.call('mcp:shell:roomhacker-server-88:AgentHerder','mesh_snapshot',{limit:3,name:'$(touch stolen)'});
  const s=state.spawns[0];expect(s.bin).toBe('/usr/bin/ssh');expect(s.args).toContain('StrictHostKeyChecking=yes');expect(s.args.join(' ')).not.toContain('$(touch stolen)');expect(s.body.params.arguments.name).toBe('$(touch stolen)');expect(s.args.join(' ')).toContain('http://127.0.0.1:');expect(s.args.join(' ')).not.toContain('dist/index.js');
 });
 it('cannot route arbitrary hosts or native tools',()=>{
  const t=new FleetDirectTransport([peer]);expect(()=>t.schema('mcp:shell:foreign:AgentHerder')).toThrow('direct_target');expect(()=>t.call('mcp:shell:roomhacker-server-88:AgentHerder','shell_exec',{})).toThrow('direct_tool');
 });
 it('mutation requires exact durable receiver intent and never forwards retryable raw create_session',async()=>{
  const t=new FleetDirectTransport([peer]);expect(()=>t.call('mcp:shell:roomhacker-server-88:AgentHerder','create_session',{})).toThrow('direct_create_identity');
  await t.call('mcp:shell:roomhacker-server-88:AgentHerder','create_session',{harness:'codex',name:'empty',cwd:'/home/roomhacker'},'a'.repeat(64));expect(state.spawns[0].body.params.name).toBe('fleet_create_session');expect(state.spawns[0].body.params.arguments.inputId).toBe('a'.repeat(64));
 });
 it('closed/offline route does not fabricate a response or retry',async()=>{
  state.mode='exit';await expect(new FleetDirectTransport([peer]).schema('mcp:shell:roomhacker-server-88:AgentHerder')).rejects.toThrow('direct_peer_unavailable');expect(state.spawns).toHaveLength(1);
 });
 it('oversized peer output is stopped and never returned',async()=>{
  state.mode='huge';await expect(new FleetDirectTransport([peer]).schema('mcp:shell:roomhacker-server-88:AgentHerder')).rejects.toThrow('direct_response_limit');expect(state.spawns[0].child.kill).toHaveBeenCalledOnce();
 });
 it('local owner gate excludes public aliases, remote clients, configured Hub bearer and foreign POST origin',()=>{
  const request=(headers:any={},method='GET',remoteAddress='127.0.0.1')=>({headers:{host:'localhost:4799',...headers},method,socket:{remoteAddress}} as IncomingMessage);
  expect(isDirectOwnerRequest(request())).toBe(true);expect(isDirectOwnerRequest(request({host:'agent44.bezrabotnyi.com'}))).toBe(false);expect(isDirectOwnerRequest(request({},'GET','192.168.2.75'))).toBe(false);expect(isDirectOwnerRequest(request({authorization:'Bearer existing'}))).toBe(false);expect(isDirectOwnerRequest(request({},'POST'))).toBe(false);expect(isDirectOwnerRequest(request({origin:'http://evil.local'},'POST'))).toBe(false);expect(isDirectOwnerRequest(request({origin:'http://localhost:4799'},'POST'))).toBe(true);
 });
 it('receiver once-record survives client/server factory replacement and preserves unknown without another native create',async()=>{
  let callback:any;const server={registerTool:(name:string,_spec:any,fn:any)=>{if(name==='fleet_create_session')callback=fn;}};const create=vi.fn(async()=>({id:'native-id',cwd:'/home/roomhacker'}));const deps={adapters:new Map([['codex',{createSession:create}]])} as any;
  registerFleetNodeTools(server as any,deps);const args={inputId:'a'.repeat(64),harness:'codex',name:'empty',cwd:'/home/roomhacker'};const first=await callback(args);registerFleetNodeTools(server as any,deps);expect(await callback(args)).toEqual(first);expect(create).toHaveBeenCalledOnce();
  create.mockRejectedValueOnce(new Error('native socket closed'));const lost={...args,inputId:'b'.repeat(64)};const unknown=await callback(lost);registerFleetNodeTools(server as any,deps);expect(await callback(lost)).toEqual(unknown);expect(create).toHaveBeenCalledTimes(2);expect(JSON.parse(unknown.content[0].text).state).toBe('unknown');
 });
});
