import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
const state=vi.hoisted(()=>({home:'',spawns:[] as any[],reply:{tools:[]},mode:'ok',auth:false}));
vi.mock('../src/web/fleet-owner-auth.js',()=>({verifyFleetOwnerCookie:vi.fn(async()=>state.auth)}));
vi.mock('node:os',()=>({hostname:()=> 'server-44',userInfo:()=>({username:'roomhacker'}),homedir:()=>state.home,platform:()=> 'linux'}));
vi.mock('node:child_process',()=>({spawn:(bin:string,args:string[])=>{
 const child=new EventEmitter() as any;
 child.stdout=new EventEmitter();child.stderr={resume(){}};child.kill=vi.fn(()=>queueMicrotask(()=>child.emit('close',137)));
 child.stdin=new EventEmitter();child.stdin.end=(body:string)=>{state.spawns.push({bin,args,body:JSON.parse(body),child});queueMicrotask(()=>{if(state.mode==='exit')return child.emit('close',255);if(state.mode==='huge')child.stdout.emit('data',Buffer.alloc(1048577));else child.stdout.emit('data',Buffer.from(JSON.stringify(state.reply)));child.emit('close',0);});};
 return child;
}}));
import {FleetDirectTransport} from '../src/mesh/fleet-direct-transport.js';
import {isDirectOwnerRequest,createManagedFleetHttpGuard,createConfiguredFleetApiHandler} from '../src/web/fleet-wiring.js';
import {FleetCabinetService} from '../src/mesh/fleet-service.js';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';
const peer={hostId:'roomhacker-server-88',sshHost:'192.168.2.75',nativeUser:'roomhacker',port:18791,python:'/usr/bin/python3'};
beforeEach(async()=>{state.home=await mkdtemp(join(process.env.TMPDIR!,'direct-'));state.spawns=[];state.reply={tools:[]};state.mode='ok';state.auth=false;});
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
 it('session reader has an owned remote deadline and cannot accept path/control injection',async()=>{
  const t=new FleetDirectTransport([peer]);expect(()=>t.readSession('mcp:shell:roomhacker-server-88:AgentHerder','codex','bad\nidentity')).toThrow('direct_session_invalid');
  await t.readSession('mcp:shell:roomhacker-server-88:AgentHerder','codex','native-id');const s=state.spawns[0];expect(s.body.method).toBe('session/read');expect(s.args.join(' ')).toContain('signal.setitimer');expect(s.args.join(' ')).toContain('NoRedirect');expect(s.body.params.sessionId).toBe('native-id');
 });
 it('at most three session reads hold slots until their actual requests settle',async()=>{
  let resolve!:()=>void;const pending=new Promise<void>(r=>{resolve=r;});const readSession=vi.fn(()=>pending);
  const service=new FleetCabinetService({hosts:[{hostId:peer.hostId,label:'88'}],scope:{profileId:'owner',userId:'roomhacker'},transportFactory:()=>({readSession,discover:async()=>({}),schema:async()=>({}),call:async()=>({})})});
  const a={hostId:peer.hostId,harness:'codex',nativeSessionId:'native-id'};const reads=[service.readSession(a),service.readSession(a),service.readSession(a)];await expect(service.readSession(a)).rejects.toThrow('fleet_session_read_unavailable');expect(readSession).toHaveBeenCalledTimes(3);resolve();await Promise.all(reads);await service.readSession(a);expect(readSession).toHaveBeenCalledTimes(4);
 });
 it('LAN public guard accepts only verified owner on its exact machine and forbids a foreign POST origin',async()=>{
  const req=(host:string,origin?:string)=>({method:origin?'POST':'GET',socket:{remoteAddress:'192.168.2.101'},headers:{host,cookie:'opaque',...(origin?{origin}:{})}} as IncomingMessage);
  const response=()=>({writeHead:vi.fn(),end:vi.fn()});const guard=createManagedFleetHttpGuard();
  const bad=response();expect(await guard(req('agent44.bezrabotnyi.com'),bad as any)).toBe(true);expect(bad.writeHead).toHaveBeenCalledWith(401,expect.anything());
  state.auth=true;expect(await guard(req('agent44.bezrabotnyi.com'),response() as any)).toBe(false);expect(await guard(req('agent88.bezrabotnyi.com'),response() as any)).toBe(true);
  const foreign=response();expect(await guard(req('agent44.bezrabotnyi.com','https://foreign.example'),foreign as any)).toBe(true);expect(foreign.writeHead).toHaveBeenCalledWith(403,expect.anything());
 });
 it('local native authority remains local and caller identity headers cannot authorize a LAN request',async()=>{
  const guard=createManagedFleetHttpGuard(),response={writeHead:vi.fn(),end:vi.fn()};
  const local={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:18791',authorization:'Bearer existing'}} as IncomingMessage;
  expect(await guard(local,response as any)).toBe(false);
  const fake={...local,socket:{remoteAddress:'192.168.2.75'},headers:{host:'127.0.0.1:18791','x-gptadmin-user':'roomhacker'}} as IncomingMessage;expect(await guard(fake,response as any)).toBe(true);expect(response.writeHead).toHaveBeenCalledWith(401,expect.anything());
 });
 it('managed public owner access does not read or copy another nodes native client credential',async()=>{
  state.auth=true;const handler=createConfiguredFleetApiHandler({clientConfigPath:'/missing/native/client/config.json'});const req={method:'GET',url:'/api/fleet/access',socket:{remoteAddress:'192.168.2.101'},headers:{host:'agent44.bezrabotnyi.com',cookie:'opaque'}} as IncomingMessage;const response={writeHead:vi.fn(),end:vi.fn()};
  expect(await handler(req,response as any)).toBe(true);expect(response.writeHead).toHaveBeenCalledWith(204,expect.anything());expect(state.spawns).toHaveLength(0);
 });
 it('preserves only the existing bearer-protected MCP and fleet routes, not arbitrary session access',async()=>{
  const response={writeHead:vi.fn(),end:vi.fn()};const guard=createManagedFleetHttpGuard('owned-secret');
  const req=(url:string,authorization:string)=>({url,method:'POST',socket:{remoteAddress:'192.168.2.75'},headers:{host:'agent44.bezrabotnyi.com',authorization}} as IncomingMessage);
  expect(await guard(req('/mcp','Bearer owned-secret'),response as any)).toBe(false);
  expect(await guard(req('/mcp','Bearer wrong'),response as any)).toBe(true);
  expect(await guard(req('/api/sessions','Bearer owned-secret'),response as any)).toBe(true);
  expect(await guard(req('/api/fleet/hosts','Bearer downstream-verified'),response as any)).toBe(false);
 });
 it('public owner binding refuses a different configured owner before constructing a fleet scope',async()=>{
  state.auth=true;const handler=createConfiguredFleetApiHandler({userId:'foreign'});const request={method:'GET',url:'/api/fleet/access',socket:{remoteAddress:'192.168.2.101'},headers:{host:'agent44.bezrabotnyi.com',cookie:'opaque'}} as IncomingMessage;const response={writeHead:vi.fn(),end:vi.fn()};
  expect(await handler(request,response as any)).toBe(true);expect(response.writeHead).toHaveBeenCalledWith(403,expect.anything());expect(state.spawns).toHaveLength(0);
 });
 it('public access probe never accepts a mutation',async()=>{
  state.auth=true;const handler=createConfiguredFleetApiHandler();const request={method:'POST',url:'/api/fleet/access',socket:{remoteAddress:'192.168.2.101'},headers:{host:'agent44.bezrabotnyi.com',cookie:'opaque',origin:'https://agent44.bezrabotnyi.com'}} as IncomingMessage;const response={writeHead:vi.fn(),end:vi.fn()};
  expect(await handler(request,response as any)).toBe(true);expect(response.writeHead).toHaveBeenCalledWith(405,expect.anything());expect(state.spawns).toHaveLength(0);
 });
 it('actual Python frame logic tolerates a UTF8 character split between HTTP chunks (fake network, local logic only)',async()=>{
  const {execFileSync}=await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const program=readFileSync('src/mesh/fleet-direct-transport.ts','utf8').split('const bridge=String.raw`')[1]!.split('`;')[0]!;
  const fixture=String.raw`import sys,json,io,socket,pwd,os,urllib.request
source=json.loads(sys.stdin.read())['program']
class Response:
 def __init__(self,request):
  r=json.loads(request.data);self.headers={'Content-Type':'text/event-stream'}
  data=('event: message\ndata: '+json.dumps({'jsonrpc':'2.0','id':r.get('id'),'result':{'marker':'Я'*3000}},ensure_ascii=False)+'\n\n').encode()
  split=data.index('Я'.encode())+1;self.chunks=[data[:split],data[split:]]
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def read1(self,n):return self.chunks.pop(0) if self.chunks else b''
class Opener:
 def open(self,request,timeout):return Response(request)
urllib.request.build_opener=lambda *args:Opener()
request={'hostId':socket.gethostname(),'nativeUser':pwd.getpwuid(os.getuid()).pw_name,'port':18791,'timeoutMs':10000,'method':'tools/call','params':{'name':'mesh_snapshot','arguments':{'limit':3}}}
sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
exec(compile(source,'owned-http-bridge','exec'))`;
  const stdout=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',fixture],{input:JSON.stringify({program}),encoding:'utf8',timeout:5000,maxBuffer:65536});expect(JSON.parse(stdout).marker).toBe('Я'.repeat(3000));
 });
 it.each(['history-unavailable','foreign-id','auth-failure'])('actual bridge local logic preserves native metadata/history distinction: %s',async(mode)=>{
  const {execFileSync}=await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const program=readFileSync('src/mesh/fleet-direct-transport.ts','utf8').split('const bridge=String.raw`')[1]!.split('`;')[0]!;
  const fixture=String.raw`import sys,json,io,socket,pwd,os,urllib.request,urllib.error
packet=json.loads(sys.stdin.read());source=packet['program'];mode=packet['mode']
class Response:
 def __init__(self,value):self.headers={'Content-Type':'application/json'};self.body=io.BytesIO(json.dumps(value).encode())
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def read1(self,n):return self.body.read(n)
 def read(self,n):return self.body.read(n)
class Opener:
 def open(self,request,timeout):
  if isinstance(request,str):
   if '/details?' in request:raise urllib.error.HTTPError(request,401 if mode=='auth-failure' else 502,'unavailable',{},io.BytesIO())
   return Response({'session':{'id':'foreign' if mode=='foreign-id' else 'native-id','harness':'codex','title':'verified'}})
  r=json.loads(request.data);result={'content':[{'text':json.dumps({'hostId':socket.gethostname(),'nativeUser':pwd.getpwuid(os.getuid()).pw_name})}]} if r['method']=='tools/call' else {}
  return Response({'jsonrpc':'2.0','id':r.get('id'),'result':result})
urllib.request.build_opener=lambda *args:Opener()
request={'hostId':socket.gethostname(),'nativeUser':pwd.getpwuid(os.getuid()).pw_name,'port':18791,'timeoutMs':10000,'method':'session/read','params':{'harness':'codex','sessionId':'native-id'}}
sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
exec(compile(source,'owned-http-bridge','exec'))`;
  const execute=()=>execFileSync('/usr/bin/python3',['-I','-S','-B','-c',fixture],{input:JSON.stringify({program,mode}),encoding:'utf8',timeout:5000,maxBuffer:65536,stdio:['pipe','pipe','pipe']});
  if(mode==='history-unavailable'){const actual=JSON.parse(execute());expect(actual.details.session.id).toBe('native-id');expect(actual.details.historyUnavailable).toBe(true);expect(actual.details.messages).toBeUndefined();}
  else expect(execute).toThrow(mode==='foreign-id'?'native_session_identity_mismatch':'HTTP Error 401');
 });
 it('receiver once-record survives client/server factory replacement and preserves unknown without another native create',async()=>{
  let callback:any;const server={registerTool:(name:string,_spec:any,fn:any)=>{if(name==='fleet_create_session')callback=fn;}};const create=vi.fn(async()=>({id:'native-id',cwd:'/home/roomhacker'}));const deps={adapters:new Map([['codex',{createSession:create}]])} as any;
  registerFleetNodeTools(server as any,deps);const args={inputId:'a'.repeat(64),harness:'codex',name:'empty',cwd:'/home/roomhacker'};const first=await callback(args);registerFleetNodeTools(server as any,deps);expect(await callback(args)).toEqual(first);expect(create).toHaveBeenCalledOnce();
  create.mockRejectedValueOnce(new Error('native socket closed'));const lost={...args,inputId:'b'.repeat(64)};const unknown=await callback(lost);registerFleetNodeTools(server as any,deps);expect(await callback(lost)).toEqual(unknown);expect(create).toHaveBeenCalledTimes(2);expect(JSON.parse(unknown.content[0].text).state).toBe('unknown');
 });
});
