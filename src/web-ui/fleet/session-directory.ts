import type {InventorySession} from '../../mesh/session-page.js';
import type {FleetHost} from '../../mesh/fleet-contract.js';
import type {SessionListSession} from '../session-list.js';
export function directorySession(s:InventorySession,host:FleetHost,localHostId:string):SessionListSession {
 const remote=host.hostId!==localHostId;
 return {hostId:host.hostId,hostLabel:host.label,remote,id:s.address.nativeSessionId,harness:s.address.harness,title:s.title,cwd:s.project.currentCwd??'',project:s.project,status:s.status,lastActivity:s.lastActivity,createdAt:s.createdAt,model:s.model,...(s.parentAddress?{meta:{parentSessionKey:remote?`mesh:${JSON.stringify([host.hostId,s.parentAddress.harness,s.parentAddress.nativeSessionId])}`:s.parentAddress.harness+':'+s.parentAddress.nativeSessionId}}:{})};
}

export function mergeDirectoryRows(current:InventorySession[],incoming:InventorySession[],maximum=10000){const map=new Map(current.map(row=>[JSON.stringify(row.address),row]));for(const row of incoming)map.set(JSON.stringify(row.address),row);return {rows:[...map.values()].slice(-maximum),limited:map.size>maximum};}
