/** Internal, pinned transport companion. The Rust controller owns admission,
 * nonce/handle validation and receipts. This module never retries a mutation. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFleetMeshBinding, type FleetMeshBinding} from './mesh/fleet-mesh-binding.js';
import {FleetGptAdminTransport} from './mesh/fleet-gptadmin-transport.js';
import {unwrapResult} from './mesh/protocol.js';

type ObjectValue=Record<string,unknown>;
type Transport={call(target:string,tool:string,args:Record<string,unknown>):Promise<unknown>};
type Dependencies={
  binding:(options:{configPath:string;pin:string})=>Promise<FleetMeshBinding|undefined>;
  transport:(binding:FleetMeshBinding)=>Transport;
};
const defaults:Dependencies={
  binding:readFleetMeshBinding,
  transport:binding=>new FleetGptAdminTransport({endpoint:binding.endpoint,
    headersProvider:()=>binding.headers,readDeadlineMs:15000}),
};
const object=(v:unknown):ObjectValue=>{
  if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('remote_request_invalid');
  return v as ObjectValue;
};
function fields(v:ObjectValue,keys:string[]):void{
  if(Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!(k in v)))throw new Error('remote_request_invalid');
}
function string(v:unknown,max=4096):string{
  if(typeof v!=='string'||!v||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw new Error('remote_request_invalid');
  return v;
}
function absolute(v:unknown):string{
  const value=string(v);
  if(!value.startsWith('/')||value.split('/').some(p=>p==='..'||p==='.')||resolve(value)!==value)
    throw new Error('remote_request_invalid');
  return value;
}
function digest(v:unknown):string{
  const value=string(v,64);if(!/^[0-9a-f]{64}$/.test(value))throw new Error('remote_request_invalid');return value;
}

export async function remoteProcessCall(input:unknown,deps:Dependencies=defaults):Promise<ObjectValue>{
  const value=object(input);
  fields(value,['version','transport','worker','endpoint_config','endpoint_config_sha256','request']);
  if(value.version!==1)throw new Error('remote_request_invalid');
  const config=object(value.transport);
  fields(config,['node_binary','node_sha256','bridge','bridge_sha256','fleet_mesh_config','credential_pin','target']);
  absolute(config.node_binary);digest(config.node_sha256);absolute(config.bridge);digest(config.bridge_sha256);
  const configPath=absolute(config.fleet_mesh_config),pin=digest(config.credential_pin);
  const target=string(config.target,256);
  // Aliases can be rebound by discovery. Installed routes use a stable exact host.
  if(!/^shell:[A-Za-z0-9._-]+$/.test(target))throw new Error('remote_request_invalid');
  const worker=absolute(value.worker),endpointConfig=absolute(value.endpoint_config);
  const configHash=digest(value.endpoint_config_sha256),request=object(value.request);
  fields(request,['version','request_id','controller_node_ref','executor_node_ref','executor_ref','operation']);
  if(request.version!==1)throw new Error('remote_request_invalid');
  digest(request.request_id);string(request.controller_node_ref,256);string(request.executor_node_ref,256);
  string(request.executor_ref,128);
  const action=object(request.operation).action;
  if(!['prepare','start','status','reconcile','cancel'].includes(String(action)))throw new Error('remote_request_invalid');
  const requestJson=JSON.stringify(request);
  if(Buffer.byteLength(requestJson)>65536)throw new Error('remote_request_invalid');
  const binding=await deps.binding({configPath,pin});
  if(!binding||binding.generation!==pin)throw new Error('remote_transport_unavailable');
  // Exactly one call, including when ACK is lost. argv is structured; no shell
  // interpolation, ssh, discovery, credential mint, or harness continuation.
  let raw:unknown;
  try{
    raw=await deps.transport(binding).call(target,'shell_exec',{
      argv:[worker,'--remote-config',endpointConfig,'--config-sha256',configHash,'--request',requestJson],
      timeout:12,
    });
  }catch{throw new Error('remote_transport_unavailable');}
  let shell:ObjectValue;
  try{shell=unwrapResult(raw);}catch{throw new Error('remote_transport_unavailable');}
  if(shell.returncode!==0||typeof shell.stdout!=='string'||Buffer.byteLength(shell.stdout)>65536
    ||shell.complete===false||shell.saved===true||shell.truncated===true)
    throw new Error('remote_response_unavailable');
  let result:ObjectValue;
  try{result=object(JSON.parse(shell.stdout));}catch{throw new Error('remote_response_invalid');}
  fields(result,['version','request_id','controller_node_ref','executor_node_ref','executor_ref','observation']);
  if(result.version!==1||result.request_id!==request.request_id||result.controller_node_ref!==request.controller_node_ref
    ||result.executor_node_ref!==request.executor_node_ref||result.executor_ref!==request.executor_ref)
    throw new Error('remote_response_identity_mismatch');
  object(result.observation);
  return result;
}

async function main():Promise<void>{
  let bytes=0;const chunks:Buffer[]=[];
  for await(const part of process.stdin){const chunk=Buffer.from(part);bytes+=chunk.length;
    if(bytes>65536)throw new Error('remote_request_limit');chunks.push(chunk);}
  const result=await remoteProcessCall(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(()=>{process.stderr.write('remote_process_transport_failed\n');process.exitCode=1;});
}
