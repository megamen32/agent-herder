import type {FleetView,FleetCreateReceipt,FleetCreateRequest,FleetHost} from '../../mesh/fleet-contract.js';
export interface FleetClient {
 hosts(signal?:AbortSignal,refresh?:boolean):Promise<{hosts:FleetHost[];complete:boolean;defaultHostId:string;scopeKey:string;sessionReadSupported?:boolean}>;
 sessions(hostId?:string,signal?:AbortSignal):Promise<FleetView>;
 session?(address:{hostId:string;harness:string;nativeSessionId:string},signal?:AbortSignal):Promise<{hostId:string;details:{session:{id:string;harness:string;title?:string;cwd?:string;model?:string};messages?:{text?:string;role?:string;kind?:string}[]}}>;
 create(request:FleetCreateRequest):Promise<FleetCreateReceipt>;
}
export function createFleetClient(base='/api/fleet'):FleetClient{
 const read=async<T>(path:string,init?:RequestInit):Promise<T>=>{
  const response=await fetch(base+path,{credentials:'same-origin',cache:'no-store',...init});
  if(!response.ok&&![202,409].includes(response.status))throw new Error('Кабинет временно недоступен');
  return response.json() as Promise<T>;
 };
 return {session:(a,signal)=>read('/session?'+new URLSearchParams({hostId:a.hostId,harness:a.harness,sessionId:a.nativeSessionId}),{signal}),hosts:(signal,refresh)=>read('/hosts'+(refresh?'?refresh=1':''),{signal}),sessions:(hostId,signal)=>read('/sessions'+(hostId?'?hostId='+encodeURIComponent(hostId):''),{signal}),create:request=>read('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})};
}
