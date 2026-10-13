import type {MeshAddress} from '../../mesh/protocol.js';
import type {FleetSessionControl} from '../../mesh/fleet-session-control.js';
export function remoteSessionQuery(address:MeshAddress){return new URLSearchParams({hostId:address.hostId,harness:address.harness,sessionId:address.nativeSessionId});}
export function remoteSessionStorage(storage:Storage,scope:string,address:MeshAddress){
 const prefix='agent-herder.remote:'+JSON.stringify([scope,address.hostId,address.harness,address.nativeSessionId])+':';
 return {getItem:(key:string)=>storage.getItem(prefix+key),setItem:(key:string,value:string)=>storage.setItem(prefix+key,value),removeItem:(key:string)=>storage.removeItem(prefix+key)};
}
export async function remoteSessionRequest(base:string,address:MeshAddress,control:FleetSessionControl){
 const query=remoteSessionQuery(address),read=['details','message-status'].includes(control.operation);
 if(read){query.set('operation',control.operation);if(control.inputId)query.set('inputId',control.inputId);}
 const response=await fetch(base+'/control?'+query,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(read?20000:35000),...(!read?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(control)}:{})});
 return {status:response.status,body:await response.json()};
}
