import {request,type RequestOptions,type ClientRequest,type IncomingMessage} from 'node:http';
import {randomUUID} from 'node:crypto';

export interface RustCoreHostSelector {
 resolveHost(hostId:string,knownHosts:readonly string[],requestId?:string):Promise<string>;
}
type Boundary=(options:RequestOptions,callback:(response:IncomingMessage)=>void)=>ClientRequest;

/** Only same-user private IPC. Authenticated FleetDependencies retain authority. */
export class RustCoreClient implements RustCoreHostSelector {
 private active=0;
 constructor(private readonly socketPath:string,private readonly localHostId:string,private readonly boundary:Boundary=request){
  if(!socketPath.startsWith('/')||!valid(localHostId,512))throw new Error('rust_core_configuration_invalid');
 }
 async resolveHost(hostId:string,knownHosts:readonly string[],requestId:string=randomUUID()):Promise<string>{
  const hosts=[...knownHosts];
  if(hosts.length>100||hosts.some(h=>!valid(h,512))||!valid(hostId,512)||!hosts.includes(hostId)||!valid(requestId,512))throw new Error('rust_core_host_denied');
  if(this.active>=3)throw new Error('rust_core_busy');
  this.active++;
  try{
   const input={local_host_id:this.localHostId,known_hosts:hosts,hosts:hostId,request_id:requestId,origin_host:this.localHostId,hop_count:0};
   const body=Buffer.from(JSON.stringify(input));
   if(body.length>128*1024)throw new Error('rust_core_request_limit');
   const result=await this.call(body);
   if(result.request_id!==requestId||result.origin_host!==this.localHostId||result.hop_count!==0||!Array.isArray(result.hosts)||result.hosts.length!==1||result.hosts[0]!==hostId)throw new Error('rust_core_route_unverified');
   return hostId;
  }finally{this.active--;}
 }
 private call(body:Buffer):Promise<Record<string,unknown>>{
  return new Promise((resolve,reject)=>{
   let response:IncomingMessage|undefined,bytes=0,finished=false;
   const chunks:Buffer[]=[];let req:ClientRequest|undefined;
   const finish=(error?:Error,value?:Record<string,unknown>)=>{
    if(finished)return;finished=true;clearTimeout(timer);req?.destroy();response?.destroy();
    if(error)reject(error);else resolve(value!);
   };
   const timer=setTimeout(()=>finish(new Error('rust_core_deadline')),3000);
   try{
    req=this.boundary({socketPath:this.socketPath,path:'/v1/normalize',method:'POST',agent:false,headers:{'Content-Type':'application/json','Content-Length':body.length}},incoming=>{
     incoming.on('error',()=>finish(new Error('rust_core_response_failed')));
     if(finished){incoming.destroy();return;}
     response=incoming;
     incoming.on('aborted',()=>finish(new Error('rust_core_response_incomplete')));
     incoming.on('data',(chunk:Buffer)=>{if(finished)return;bytes+=chunk.length;if(bytes>1024*1024){finish(new Error('rust_core_response_limit'));return;}chunks.push(chunk);});
     incoming.on('end',()=>{
      if(finished)return;
      if(incoming.statusCode!==200){finish(new Error('rust_core_request_rejected'));return;}
      try{const result:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();finish(undefined,result as Record<string,unknown>);}
      catch{finish(new Error('rust_core_response_invalid'));}
     });
    });
    req.on('error',()=>finish(new Error('rust_core_unavailable')));req.end(body);
   }catch{finish(new Error('rust_core_unavailable'));}
  });
 }
}
const valid=(s:unknown,n:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=n&&!/[\x00-\x1f\x7f]/.test(s);
