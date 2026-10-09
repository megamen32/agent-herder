import {createHash} from 'node:crypto';
import {addressKey,unwrapResult} from './protocol.js';
import {projectPeerSession,type GptAdminTransport} from './gptadmin.js';
import {fleetHarnesses,type FleetHostDefinition,type FleetHost,type FleetScope,type FleetView,type FleetSession,type FleetCreateRequest,type FleetCreateReceipt} from './fleet-contract.js';
import {FleetCreateJournal} from './fleet-create-journal.js';
type Context=FleetScope&{hostId:string;credentialGeneration?:string};
type Cached={host:FleetHost;sessions:FleetSession[];complete:boolean;limited:boolean;target:string};
export interface FleetDependencies {hosts:readonly FleetHostDefinition[];scope:FleetScope;transportFactory:(context:Context)=>GptAdminTransport;now?:()=>number;ttlMs?:number;readDeadlineMs?:number;createDeadlineMs?:number;journalPath?:string;credentialGeneration?:string}
/** Service scope is supplied by authenticated server code, never by request bodies. */
export class FleetCabinetService {
 private readonly transports=new Map<string,GptAdminTransport>();
 private readonly cache=new Map<string,Cached>();
 private pending?:Promise<FleetView>;
 private lastReadAt:number|null=null;
 private readonly journal?:FleetCreateJournal;
 constructor(private readonly deps:FleetDependencies){
  this.deps={...deps,scope:Object.freeze({...deps.scope}),hosts:deps.hosts.map(h=>Object.freeze({...h}))};
  if(!deps.hosts.length||deps.hosts.length>5||new Set(deps.hosts.map(h=>h.hostId)).size!==deps.hosts.length)throw new Error('Expected 1..5 unique fleet hosts');
  if(deps.journalPath)this.journal=new FleetCreateJournal(this.deps.journalPath!,this.deps.scope);
 }
 get browserScopeKey(){return createHash('sha256').update(JSON.stringify([this.deps.scope.profileId,this.deps.scope.userId])).digest('hex');}
 private now(){return (this.deps.now??Date.now)();}
 private transport(hostId:string){let t=this.transports.get(hostId);if(!t){t=this.deps.transportFactory({...this.deps.scope,hostId,...(this.deps.credentialGeneration?{credentialGeneration:this.deps.credentialGeneration}:{})});this.transports.set(hostId,t);}return t;}
 private async bounded<T>(operation:Promise<T>,deadline:number,limitMs=this.deps.readDeadlineMs??3000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fleet_read_deadline')),Math.max(1,Math.min(limitMs,deadline-this.now())));})]);}finally{if(timer)clearTimeout(timer);}
 }
 async snapshot(options:{hostId?:string;limit?:number;refresh?:boolean}={}):Promise<FleetView>{
  const limit=options.limit??12;
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error('Fleet limit must be 1..12');
  if(options.hostId&&!this.deps.hosts.some(h=>h.hostId===options.hostId))throw new Error('Unknown fleet host');
  // Sharing only within this immutable profile/user scope. Each request applies its own output window.
  let all:FleetView;
  if(this.pending)all=await this.pending;
  else if(!options.refresh&&this.lastReadAt!==null&&this.now()-this.lastReadAt<(this.deps.ttlMs??15000)&&[...this.cache.values()].every(r=>!['ready','metadata_only'].includes(r.host.state)||(r.host.expiresAt??0)>this.now())){
   const entries=this.deps.hosts.map(h=>this.cache.get(h.hostId)!);all={hosts:entries.map(r=>r.host),sessions:entries.flatMap(r=>r.sessions),complete:entries.every(r=>r.complete),limited:entries.some(r=>r.limited)};
  }else{this.pending=this.refresh().finally(()=>{this.pending=undefined;});all=await this.pending;}
  const hosts=all.hosts.filter(h=>!options.hostId||h.hostId===options.hostId);
  const sessions=all.sessions.filter(s=>!options.hostId||s.address.hostId===options.hostId);
  const limited=all.limited||sessions.length>limit;
  return {hosts,sessions:options.hostId?sessions.slice(0,limit):fairWindow(sessions,hosts.map(h=>h.hostId),limit),limited,complete:!limited&&hosts.every(h=>this.cache.get(h.hostId)?.complete===true&&h.state==='ready')};
 }
 private async refresh():Promise<FleetView>{
  const deadline=this.now()+10000;let registry:Record<string,unknown>[]=[];let registryFailed=false;
  try{const r=unwrapResult(await this.bounded(this.transport(this.deps.hosts[0]!.hostId).discover(),deadline));if(!Array.isArray(r.servers)||r.servers.length>256)throw new Error('fleet_registry_invalid');registry=r.servers.filter(v=>v&&typeof v==='object');}catch{registryFailed=true;}
  const results=new Map<string,Cached>();let next=0;
  await Promise.all(Array.from({length:3},async()=>{for(;;){const definition=this.deps.hosts[next++];if(!definition)return;
   const {hostId}=definition;const shell=registry.find(r=>r.server_id===`shell:${hostId}`);
   const peers=registry.filter(r=>r.kind==='child_mcp'&&typeof r.server_id==='string'&&r.server_id.startsWith(`mcp:shell:${hostId}:`));
   const peer=peers.find(r=>/^(AgentHerder|agent-herder)$/i.test(String(r.server_id).split(':').at(-1)!))??peers.find(r=>/HarnessMesh/i.test(String(r.server_id).split(':').at(-1)!));
   const unavailable=(reason:string,state:FleetHost['state']='unavailable'):Cached=>{
    const old=this.cache.get(hostId);
    // Failure/missing peer does not advance freshness or preserve control capability.
    if(old)return {...old,complete:false,host:{...old.host,state:'stale',createHarnesses:[],reason},sessions:old.sessions};
    return {host:{...definition,state,fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[],reason},sessions:[],complete:false,limited:false,target:''};
   };
   if(registryFailed||!peer||peer.status!=='online'){results.set(hostId,unavailable(registryFailed?'registry_read_failed':shell?.status==='offline'?'host_offline':!peer?'local_herder_not_registered':'local_herder_offline',shell?.status==='offline'?'offline':'unavailable'));continue;}
   try{
    const target=String(peer.server_id),transport=this.transport(hostId);
    const schema=unwrapResult(await this.bounded(transport.schema(target),deadline));
    const tools=Array.isArray(schema.tools)?schema.tools as {name:string}[]:[];
    const full=tools.some(t=>t.name==='fleet_node_info');
    let info:Record<string,unknown>={};
    if(full){info=unwrapResult(await this.bounded(transport.call(target,'fleet_node_info',{}),deadline));
     if(info.hostId!==hostId||definition.nativeUser&&info.nativeUser!==definition.nativeUser)throw new Error('native_owner_identity_mismatch');
    }
    if(!tools.some(t=>t.name==='mesh_snapshot'))throw new Error('snapshot_capability_missing');
    const raw=unwrapResult(await this.bounded(transport.call(target,'mesh_snapshot',{limit:12}),deadline));
    if(raw.hostId!==hostId||!Array.isArray(raw.sessions))throw new Error('native_snapshot_identity_mismatch');
    const sessions:FleetSession[]=[];let partial=false;
    for(const row of raw.sessions.slice(0,12)){const s=projectPeerSession(row,hostId);if(s)sessions.push({...s,key:addressKey(s.address)});else partial=true;}
    const limited=raw.sessions.length>12||raw.limited===true;
    const createHarnesses=full&&tools.some(t=>t.name==='create_session')?fleetHarnesses.filter(h=>Array.isArray(info.createHarnesses)&&info.createHarnesses.includes(h)):[];
    const at=this.now();results.set(hostId,{target,sessions,limited,complete:full&&raw.complete===true&&!partial&&!limited,host:{...definition,state:full?'ready':'metadata_only',fetchedAt:at,expiresAt:at+(this.deps.ttlMs??15000),generation:Number.isSafeInteger(info.generation)?info.generation as number:null,createHarnesses,...(!full?{reason:'local_control_not_registered'}:partial?{reason:'invalid_peer_session'}:{})}});
   }catch(e){results.set(hostId,unavailable(e instanceof Error?e.message.slice(0,96):'fleet_read_failed'));}
  }}));
  // Atomic publish; timed-out reads have no callback that can mutate the cache.
  for(const [hostId,result]of results)this.cache.set(hostId,result);
  this.lastReadAt=this.now();
  const ordered=this.deps.hosts.map(h=>results.get(h.hostId)!);
  return {hosts:ordered.map(r=>r.host),sessions:ordered.flatMap(r=>r.sessions),complete:ordered.every(r=>r.complete),limited:ordered.some(r=>r.limited)};
 }
 async create(request:FleetCreateRequest):Promise<FleetCreateReceipt>{
  const reject=(reason:string,retryable=true):FleetCreateReceipt=>({state:'not_attempted',inputId:request.inputId,retryable,reason});
  if(!this.journal)return reject('durable_create_journal_not_configured',false);
  if(!this.deps.hosts.some(h=>h.hostId===request.hostId)||!fleetHarnesses.includes(request.harness)||!validText(request.inputId,256)||!validText(request.name,128)||!validText(request.cwd,4096)||!absolutePath(request.cwd)||request.model!==undefined&&!validText(request.model,128))return reject('invalid_create_request',false);
  return this.journal.once(request,async()=>{
   try{await this.snapshot({hostId:request.hostId,refresh:true});}catch{return reject('native_preflight_read_failed');}
   const node=this.cache.get(request.hostId);
   if(!node||node.host.state!=='ready'||(node.host.expiresAt??0)<=this.now()||!node.host.createHarnesses.includes(request.harness))return reject('native_create_unavailable');
   // One mutation only. A lost response is durable UNKNOWN, even if the native process completes later.
   const raw=unwrapResult(await this.bounded(this.transport(request.hostId).call(node.target,'create_session',{harness:request.harness,name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{})},createHash('sha256').update(JSON.stringify([this.deps.scope.profileId,this.deps.scope.userId,request.hostId,request.inputId])).digest('hex')),this.now()+(this.deps.createDeadlineMs??30000),this.deps.createDeadlineMs??30000));
   if(raw.ok===true&&raw.created===true&&raw.harness===request.harness&&typeof raw.sessionId==='string'&&validText(raw.sessionId,512)&&typeof raw.cwd==='string'&&validText(raw.cwd,4096)&&absolutePath(raw.cwd))return {state:'created',inputId:request.inputId,address:{hostId:request.hostId,harness:request.harness,nativeSessionId:raw.sessionId},launchCwd:raw.cwd,retryable:false};
   return {state:'unknown',inputId:request.inputId,retryable:false,reason:'native_creation_receipt_unverified'};
  });
 }
}
const validText=(s:unknown,n:number):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=n&&!/[\x00-\x1f\x7f]/.test(s);
const absolutePath=(s:string)=>/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s);

function fairWindow(sessions:FleetSession[],hostIds:string[],limit:number):FleetSession[]{
 const groups=hostIds.map(id=>sessions.filter(s=>s.address.hostId===id));const result:FleetSession[]=[];
 for(let index=0;result.length<limit;index++){let added=false;for(const group of groups){const session=group[index];if(session&&result.length<limit){result.push(session);added=true;}}if(!added)break;}return result;
}
