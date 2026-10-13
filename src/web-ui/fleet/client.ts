import type {SessionInventoryPage} from '../../mesh/session-page.js';
import type {FleetView,FleetCreateReceipt,FleetCreateRequest,FleetHost} from '../../mesh/fleet-contract.js';
import type {FleetSessionControl} from '../../mesh/fleet-session-control.js';
import {remoteSessionRequest} from './session-control.js';
export interface FleetClient {
 hosts(signal?:AbortSignal,refresh?:boolean):Promise<{hosts:FleetHost[];complete:boolean;defaultHostId:string;scopeKey:string;sessionReadSupported?:boolean}>;
 inventory?(cursors?:Record<string,string>,signal?:AbortSignal,hostId?:string):Promise<{hosts:FleetHost[];pages:Array<SessionInventoryPage&{reason?:string}>;scopeKey:string}>;
 sessions(hostId?:string,signal?:AbortSignal):Promise<FleetView>;
 session?(address:{hostId:string;harness:string;nativeSessionId:string},signal?:AbortSignal):Promise<{hostId:string;details:{session:{id:string;harness:string;title?:string;cwd?:string;model?:string};historyUnavailable?:boolean;messages?:{text?:string;role?:string;kind?:string}[]}}>;
 create(request:FleetCreateRequest):Promise<FleetCreateReceipt>;
 control?(address:{hostId:string;harness:string;nativeSessionId:string},control:FleetSessionControl):Promise<{status:number;body:unknown}>;
}
export function createFleetClient(base='/api/fleet'):FleetClient{
 const read=async<T>(path:string,init?:RequestInit):Promise<T>=>{
  const response=await fetch(base+path,{credentials:'same-origin',cache:'no-store',...init});
  if(!response.ok&&![202,409].includes(response.status))throw new Error('Кабинет временно недоступен');
  return response.json() as Promise<T>;
 };
 return {control:(address,control)=>remoteSessionRequest(base,address,control),inventory:(cursors,signal,hostId)=>read('/inventory?'+new URLSearchParams({...cursors?{cursors:JSON.stringify(cursors)}:{},...hostId?{hostId}:{}}),{signal}),session:(a,signal)=>read('/session?'+new URLSearchParams({hostId:a.hostId,harness:a.harness,sessionId:a.nativeSessionId}),{signal}),hosts:(signal,refresh)=>read('/hosts'+(refresh?'?refresh=1':''),{signal}),sessions:(hostId,signal)=>read('/sessions'+(hostId?'?hostId='+encodeURIComponent(hostId):''),{signal}),create:request=>read('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})};
}
