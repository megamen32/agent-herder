import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';import {homedir,hostname} from 'node:os';import {randomUUID} from 'node:crypto';
import {filterActiveInventory,readActiveInventory,type ActiveInventory,type ActiveInventoryQuery} from './active-session-inventory.js';
import {FleetDirectTransport,directFleetPeers} from './mesh/fleet-direct-transport.js';import {unwrapResult} from './mesh/protocol.js';
type Peer={hostId:string;target:string};type RecordFile={version:1;owners:Record<string,ActiveInventory>;errors:Record<string,string>};
const configured=():Peer[]=>directFleetPeers.map(p=>({hostId:p.hostId,target:`mcp:shell:${p.hostId}:AgentHerder`}));
export const activeFleetInventoryPath=()=>process.env.AGENT_HERDER_ACTIVE_FLEET_INVENTORY||resolve(homedir(),'.local/state/agent-herder/active-fleet-inventory.json');
function validate(value:ActiveInventory,hostId:string){if(!Array.isArray(value?.sessions)||value.hosts?.length!==1||value.hosts[0].hostId!==hostId||value.sessions.some(s=>s.runtimeHostId!==hostId||typeof s.id!=='string'||!Array.isArray(s.workspaces))||typeof value.partial!=='boolean')throw Error('active_fleet_owner_identity_invalid');return value;}
/** A read never starts transport, extends activity TTL or discards an expired known row. */
export async function readFleetActiveInventory(input:ActiveInventoryQuery={},options:{path?:string;peers?:readonly Peer[];now?:number}={}){
 const peers=(options.peers??configured()).filter(p=>!input.runtimeHostId||p.hostId.toLowerCase()===input.runtimeHostId.toLowerCase());if(!peers.length)throw Error('active_runtime_host_unknown');
 let file:RecordFile={version:1,owners:{},errors:{}};try{const stored=JSON.parse(await readFile(options.path??activeFleetInventoryPath(),'utf8'));if(stored.version===1&&stored.owners&&stored.errors)file=stored;}catch{/* Missing/unreadable index is partial, never complete zero. */}
 const now=options.now??Date.now();const values=peers.map(peer=>{
  try{const value=validate(file.owners[peer.hostId],peer.hostId),host=value.hosts[0],age=now-Date.parse(host.observedAt??'');const stale=!Number.isFinite(age)||age< -5000||age>30000;
   const sessions=value.sessions.map(s=>{const expiry=Date.parse(s.activity.expiresAt??'');return stale||!Number.isFinite(expiry)||expiry<=now?{...s,activity:{...s.activity,state:'unknown'}}:s;});
   return {...value,sessions,partial:value.partial||stale||Boolean(file.errors[peer.hostId])||sessions.some(s=>s.activity.state==='unknown'),hosts:[{...host,...(stale?{state:'stale',reason:'activity_snapshot_expired'}:file.errors[peer.hostId]?{reason:'cached_owner_after_'+file.errors[peer.hostId]}:{})}]};
  }catch{return {sessions:[],partial:true,hosts:[{hostId:peer.hostId,state:'unavailable',observedAt:null,reason:file.errors[peer.hostId]??'activity_fleet_inventory_warming'}]} as ActiveInventory;}
 });
 return filterActiveInventory({sessions:values.flatMap(v=>v.sessions),hosts:values.flatMap(v=>v.hosts),partial:values.some(v=>v.partial)},input);
}
/** One bounded background read per exact owner; publish each completion independently. */
export function startActiveFleetInventoryOwner(options:{path?:string;peers?:readonly Peer[];intervalMs?:number;readOwner?:(peer:Peer)=>Promise<unknown>}={}){
 const peers=options.peers??configured(),path=options.path??activeFleetInventoryPath(),transport=new FleetDirectTransport(directFleetPeers,10000);
 const readOwner=options.readOwner??(async(peer:Peer)=>peer.hostId===hostname()?readActiveInventory():transport.call(peer.target,'list_active_sessions_local',{}));
 let closed=false;const file:RecordFile={version:1,owners:{},errors:{}};const pending=new Set<string>();let publishing=Promise.resolve();
 const publish=()=>{publishing=publishing.catch(()=>{}).then(async()=>{if(closed)return;await mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(file),{mode:0o600});await rename(tmp,path);});};
 const refresh=()=>{if(closed)return;for(const peer of peers){if(pending.has(peer.hostId))continue;pending.add(peer.hostId);
  void Promise.resolve().then(()=>readOwner(peer)).then(raw=>{if(closed)return;file.owners[peer.hostId]=validate(unwrapResult(raw)as unknown as ActiveInventory,peer.hostId);delete file.errors[peer.hostId];}).catch(error=>{if(!closed)file.errors[peer.hostId]=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'activity_owner_transport_failed';}).finally(()=>{pending.delete(peer.hostId);if(!closed)publish();});
 }};
 // Preserve last success across process restarts, including its original evidence timestamps.
 void readFile(path,'utf8').then(raw=>{const stored=JSON.parse(raw);if(stored.version===1&&stored.owners)for(const peer of peers){try{file.owners[peer.hostId]=validate(stored.owners[peer.hostId],peer.hostId);}catch{}}}).catch(()=>{}).finally(refresh);
 const timer=setInterval(refresh,options.intervalMs??2000);timer.unref();return Object.assign(()=>{closed=true;clearInterval(timer);},{refresh});
}
