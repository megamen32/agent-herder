import {spawn} from 'node:child_process';
import {hostname,userInfo} from 'node:os';
import type {GptAdminTransport} from './gptadmin.js';
/** Reuses owner-authorized fleet SSH, transporting HTTP to each existing singleton. Never starts MCP stdio or a native controller. */
export type DirectPeer={hostId:string;sshHost:string;nativeUser:string;port:number;python:string};
export const directFleetPeers:readonly DirectPeer[]=[
 {hostId:'roomhacker-server-100',sshHost:'192.168.2.100',nativeUser:'roomhacker',port:18787,python:'/usr/bin/python3'},
 {hostId:'server-44',sshHost:'192.168.2.5',nativeUser:'roomhacker',port:18791,python:'/usr/bin/python3'},
 {hostId:'roomhacker-server-88',sshHost:'192.168.2.75',nativeUser:'roomhacker',port:18791,python:'/usr/bin/python3'},
 {hostId:'mac-mini-2012.lan',sshHost:'192.168.2.4',nativeUser:'roomhacker',port:18789,python:'/usr/bin/python3'},
 // Direct LAN is the independent recovery leg when the primary reverse route through100 is absent.
 {hostId:'MacBook-Pro-User.local',sshHost:'192.168.2.8',nativeUser:'user',port:18789,python:'/opt/homebrew/bin/python3'},
];
const quote=(s:string)=>"'"+s.replace(/'/g,"'\"'\"'")+"'";
const bridge=String.raw`import sys,json,socket,pwd,os,time,urllib.request,urllib.parse,uuid,signal
body=sys.stdin.buffer.read(16385)
if len(body)>16384:raise RuntimeError('request_limit')
r=json.loads(body)
if socket.gethostname()!=r['hostId'] or pwd.getpwuid(os.getuid()).pw_name!=r['nativeUser']:raise RuntimeError('native_owner_identity_mismatch')
deadline=time.monotonic()+r['timeoutMs']/1000
signal.setitimer(signal.ITIMER_REAL,r['timeoutMs']/1000)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect())
session=None
url='http://127.0.0.1:'+str(r['port'])+'/mcp'
def rpc(method,params):
 global session
 identity=str(uuid.uuid4());headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'}
 if session:headers['Mcp-Session-Id']=session
 data={'jsonrpc':'2.0','method':method,'params':params}
 if not method.startswith('notifications/'):data['id']=identity
 remaining=deadline-time.monotonic()
 if remaining<=0:raise RuntimeError('direct_deadline')
 with opener.open(urllib.request.Request(url,json.dumps(data).encode(),headers),timeout=remaining) as response:
  if method.startswith('notifications/'):return {}
  if method=='initialize':session=response.headers.get('Mcp-Session-Id')
  buf=b''
  while True:
   chunk=response.read1(4096)
   if not chunk:break
   buf+=chunk
   if len(buf)>1048576:raise RuntimeError('direct_response_limit')
   if 'text/event-stream' in response.headers.get('Content-Type',''):
    for raw_frame in buf.replace(b'\r\n',b'\n').split(b'\n\n')[:-1]:
     frame=raw_frame.decode('utf8')
     text='\n'.join(line[5:].lstrip() for line in frame.split('\n') if line.startswith('data:'))
     try:value=json.loads(text)
     except ValueError:continue
     if value.get('id')==identity:return value
  value=json.loads(buf)
  if value.get('id')!=identity:raise RuntimeError('direct_rpc_identity_mismatch')
  return value
rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'herder-fleet-direct','version':'1'}})
rpc('notifications/initialized',{})
if r['method']=='session/read':
 info=rpc('tools/call',{'name':'fleet_node_info','arguments':{}})
 info=json.loads(info['result']['content'][0]['text'])
 if info.get('hostId')!=r['hostId'] or info.get('nativeUser')!=r['nativeUser']:raise RuntimeError('native_owner_identity_mismatch')
 p=r['params'];path='/api/sessions/'+urllib.parse.quote(p['harness'],safe='')+'/'+urllib.parse.quote(p['sessionId'],safe='')+'/details?limit=3&quick=1'
 with opener.open(url[:-4]+path,timeout=max(.001,deadline-time.monotonic())) as response:body=response.read(1048577)
 if len(body)>1048576:raise RuntimeError('direct_response_limit')
 details=json.loads(body);session=details['session']
 if session.get('id')!=p['sessionId'] or session.get('harness')!=p['harness']:raise RuntimeError('native_session_identity_mismatch')
 print(json.dumps({'hostId':r['hostId'],'details':details}))
else:
 value=rpc(r['method'],r['params'])
 if value.get('error'):raise RuntimeError('direct_rpc_failed')
 print(json.dumps(value['result']))
`;
export class FleetDirectTransport implements GptAdminTransport {
 constructor(private readonly peers:readonly DirectPeer[]=directFleetPeers,private readonly deadlineMs=10000){
  if(!peers.length||peers.length>5||new Set(peers.map(p=>p.hostId)).size!==peers.length)throw new Error('direct_peer_limit');
 }
 async discover():Promise<unknown>{return {servers:this.peers.flatMap(p=>[{server_id:`shell:${p.hostId}`,kind:'virtual_shell',status:'configured'},{server_id:`mcp:shell:${p.hostId}:AgentHerder`,kind:'child_mcp',status:'configured'}])};}
 private peer(target:string){const p=this.peers.find(p=>target===`mcp:shell:${p.hostId}:AgentHerder`);if(!p)throw new Error('direct_target_not_authorized');return p;}
 private rpc(peer:DirectPeer,method:string,params:Record<string,unknown>,timeoutMs:number):Promise<unknown>{
  const request=JSON.stringify({...peer,method,params,timeoutMs});if(Buffer.byteLength(request)>16384)throw new Error('direct_request_limit');
  const local=peer.hostId===hostname()&&peer.nativeUser===userInfo().username;
  const executable=local?peer.python:'/usr/bin/ssh';
  const args=local?['-I','-S','-B','-c',bridge]:['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=3','-o','ConnectionAttempts=1','-o','ServerAliveInterval=3','-o','ServerAliveCountMax=1','-l',peer.nativeUser,peer.sshHost,`${quote(peer.python)} -I -S -B -c ${quote(bridge)}`];
  return new Promise((resolve,reject)=>{
   const child=spawn(executable,args,{stdio:['pipe','pipe','pipe']});let size=0;const chunks:Buffer[]=[];let failure:Error|undefined;
   const timer=setTimeout(()=>{failure=new Error('direct_deadline');child.kill('SIGKILL');},timeoutMs+500);
   child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>1048576){failure=new Error('direct_response_limit');child.kill('SIGKILL');}else chunks.push(data);});
   child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',error=>{clearTimeout(timer);reject(error);});
   child.on('close',code=>{clearTimeout(timer);if(failure||code!==0)return reject(failure??new Error('direct_peer_unavailable'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('direct_response_invalid'));}});
   child.stdin.end(request);
  });
 }
 readSession(target:string,harness:string,sessionId:string):Promise<unknown>{
  if(!['codex','zcode','opencode'].includes(harness)||!sessionId||sessionId.length>512||/[\x00-\x1f\x7f]/.test(sessionId))throw new Error('direct_session_invalid');
  return this.rpc(this.peer(target),'session/read',{harness,sessionId},this.deadlineMs);
 }
 schema(target:string):Promise<unknown>{return this.rpc(this.peer(target),'tools/list',{},this.deadlineMs);}
 call(target:string,tool:string,args:Record<string,unknown>,idempotencyKey?:string):Promise<unknown>{
  if(!['fleet_node_info','mesh_snapshot','create_session'].includes(tool))throw new Error('direct_tool_not_authorized');
  if(tool==='create_session'){
   if(!idempotencyKey||!/^[a-f0-9]{64}$/.test(idempotencyKey))throw new Error('direct_create_identity_missing');
   return this.rpc(this.peer(target),'tools/call',{name:'fleet_create_session',arguments:{...args,inputId:idempotencyKey}},30000);
  }
  return this.rpc(this.peer(target),'tools/call',{name:tool,arguments:args},this.deadlineMs);
 }
}
