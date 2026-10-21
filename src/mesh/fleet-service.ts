import {createHash} from 'node:crypto';
import {addressKey,unwrapResult} from './protocol.js';
import {projectPeerSession,type GptAdminTransport} from './gptadmin.js';
import {fleetHarnesses,type FleetHostDefinition,type FleetHost,type FleetScope,type FleetView,type FleetSession,type FleetCreateRequest,type FleetCreateReceipt} from './fleet-contract.js';
import {FleetCreateJournal} from './fleet-create-journal.js';
import type {SessionInventoryPage,InventorySession} from './session-page.js';
import type {RustCoreHostSelector} from './rust-core-client.js';
import {fleetSessionControlSchema,type FleetSessionControl,type FleetSessionResponse} from './fleet-session-control.js';
type Context=FleetScope&{hostId:string;credentialGeneration?:string};
type Cached={revision:number;host:FleetHost;sessions:FleetSession[];complete:boolean;limited:boolean;target:string;inventorySupported?:boolean};
export interface FleetDependencies {hosts:readonly FleetHostDefinition[];scope:FleetScope;transportFactory:(context:Context)=>GptAdminTransport;rustCore?:RustCoreHostSelector;now?:()=>number;ttlMs?:number;readDeadlineMs?:number;discoveryDeadlineMs?:number;createDeadlineMs?:number;journalPath?:string;credentialGeneration?:string}
/** Service scope is supplied by authenticated server code, never by request bodies. */
export class FleetCabinetService {
 private readonly transports=new Map<string,GptAdminTransport>();
 private readonly cache=new Map<string,Cached>();
 private readonly inventoryCache=new Map<string,{expiresAt:number;bytes:number;page:SessionInventoryPage}>();
 private readonly inventoryPending=new Map<string,Promise<SessionInventoryPage>>();
 private inventoryResult(page:SessionInventoryPage):SessionInventoryPage{
  const result=structuredClone(page);
  if(result.warming||result.observedAt===null||this.now()-Date.parse(result.observedAt)>60000)result.partial=true;
  return result;
 }
 private async inventoryPage(key:string,host:Cached,read:()=>Promise<SessionInventoryPage>):Promise<SessionInventoryPage>{
  const now=this.now();for(const[k,v]of this.inventoryCache)if(v.expiresAt<=now)this.inventoryCache.delete(k);
  const cached=this.inventoryCache.get(key);if(cached)return this.inventoryResult(cached.page);
  const pending=this.inventoryPending.get(key);if(pending)return this.inventoryResult(await pending);
  if(this.inventoryPending.size>=6)throw new Error('inventory_reads_busy');
  const operation=read().then(page=>{
   if(this.cache.get(host.host.hostId)?.revision!==host.revision)throw new Error('inventory_owner_observation_changed');
   const bytes=Buffer.byteLength(JSON.stringify(page));if(bytes<=524288){this.inventoryCache.set(key,{page:structuredClone(page),bytes,expiresAt:this.now()+30000});
    let total=[...this.inventoryCache.values()].reduce((n,p)=>n+p.bytes,0);for(const[k,p]of this.inventoryCache){if(total<=2097152&&this.inventoryCache.size<=32)break;total-=p.bytes;this.inventoryCache.delete(k);}}
   return page;
  }).finally(()=>{this.inventoryPending.delete(key);});this.inventoryPending.set(key,operation);return this.inventoryResult(await operation);
 }
 private pending?:Promise<FleetView>;
 private sessionReads=0;
 private lastReadAt:number|null=null;
 private readRevision=0;
 private readonly journal?:FleetCreateJournal;
 constructor(private readonly deps:FleetDependencies){
  this.deps={...deps,scope:Object.freeze({...deps.scope}),hosts:deps.hosts.map(h=>Object.freeze({...h}))};
  if(!deps.hosts.length||deps.hosts.length>5||new Set(deps.hosts.map(h=>h.hostId)).size!==deps.hosts.length)throw new Error('Expected 1..5 unique fleet hosts');
  if(deps.journalPath)this.journal=new FleetCreateJournal(this.deps.journalPath!,this.deps.scope);
 }
 get canReadSession(){return typeof this.transport(this.deps.hosts[0]!.hostId).readSession==='function';}
 async requestSession(address:{hostId:string;harness:string;nativeSessionId:string},control:FleetSessionControl):Promise<FleetSessionResponse>{
  if(!this.deps.hosts.some(h=>h.hostId===address.hostId)||!fleetHarnesses.includes(address.harness as any)||!validText(address.nativeSessionId,512))throw new Error('fleet_session_invalid');
  const captured=Object.freeze({...address}),request=fleetSessionControlSchema.parse(control);
  await this.selectedHost(captured.hostId);
  const transport=this.transport(captured.hostId);if(!transport.requestSession)throw new Error('fleet_session_control_unavailable');
  const response=await transport.requestSession(`mcp:shell:${captured.hostId}:AgentHerder`,captured.harness,captured.nativeSessionId,request);
  if(response.hostId!==captured.hostId)throw new Error('fleet_session_response_identity_mismatch');
  return response;
 }
 async readSession(address:{hostId:string;harness:string;nativeSessionId:string}):Promise<unknown>{
  if(!this.deps.hosts.some(h=>h.hostId===address.hostId)||!fleetHarnesses.includes(address.harness as any)||!validText(address.nativeSessionId,512))throw new Error('fleet_session_invalid');
  await this.selectedHost(address.hostId);
  const transport=this.transport(address.hostId);if(!transport.readSession||this.sessionReads>=3)throw new Error('fleet_session_read_unavailable');
  this.sessionReads++;
  try{return await transport.readSession(`mcp:shell:${address.hostId}:AgentHerder`,address.harness,address.nativeSessionId);}finally{this.sessionReads--;}
 }
 get browserScopeKey(){return createHash('sha256').update(JSON.stringify([this.deps.scope.profileId,this.deps.scope.userId])).digest('hex');}
 /** Browser directory pages are independent of the compact agent-discovery window. */
 async inventory(options:{hostId?:string;cursors?:Record<string,string>;limit?:number}={}):Promise<{hosts:FleetHost[];pages:Array<SessionInventoryPage&{reason?:string}>;scopeKey:string}>{
  const limit=options.limit??100;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('inventory_page_limit');
  if(options.hostId&&!this.deps.hosts.some(h=>h.hostId===options.hostId))throw new Error('inventory_host_invalid');
  for(const [host,cursor]of Object.entries(options.cursors??{}))if(!this.deps.hosts.some(h=>h.hostId===host)||typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error('inventory_cursor_invalid');
  if(options.hostId)await this.selectedHost(options.hostId);
  const view=await this.snapshot();const selected=view.hosts.filter(h=>(!options.hostId||h.hostId===options.hostId)&&(!options.cursors||Object.prototype.hasOwnProperty.call(options.cursors,h.hostId)));
  const pages=new Map<string,SessionInventoryPage&{reason?:string}>();let next=0;
  await Promise.all(Array.from({length:3},async()=>{for(;;){const host=selected[next++];if(!host)return;
   const empty=(reason:string):SessionInventoryPage&{reason:string}=>({hostId:host.hostId,sessions:[],nextCursor:null,observedAt:null,warming:false,partial:true,total:0,reason});
   const cached=this.cache.get(host.hostId),transport=this.transport(host.hostId),readSessionPage=transport.readSessionPage?.bind(transport);
   if(!cached?.inventorySupported||!readSessionPage||!['ready','metadata_only'].includes(host.state)){pages.set(host.hostId,empty(host.reason??'inventory_page_not_registered'));continue;}
   try{
    const cursor=options.cursors?.[host.hostId];
    const overlay=cursor?[]:cached.sessions.slice(0,Math.max(0,limit-1));
    const nativeLimit=limit-overlay.length;
    const key=JSON.stringify([host.hostId,cached.revision,cursor??'',limit]);
    const page=await this.inventoryPage(key,cached,async()=>{
    const raw=unwrapResult(await this.bounded(readSessionPage(cached.target,cursor,nativeLimit),this.now()+(this.deps.readDeadlineMs??10000)));
    if(raw.hostId!==host.hostId||!Array.isArray(raw.sessions)||raw.sessions.length>nativeLimit||raw.nextCursor!==null&&(typeof raw.nextCursor!=='string'||raw.nextCursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(raw.nextCursor))||raw.observedAt!==null&&(typeof raw.observedAt!=='string'||raw.observedAt.length>64||!Number.isFinite(Date.parse(raw.observedAt))))throw new Error('inventory_page_invalid');
    const sessions=new Map<string,InventorySession>();let partial=raw.partial!==false||raw.warming!==false;
    for(const row of raw.sessions){const s=projectPeerSession(row,host.hostId);if(!s){partial=true;continue;}
     let parentAddress:InventorySession['parentAddress'];
     if(row.parentAddress){try{if(row.parentAddress.hostId!==host.hostId||typeof row.parentAddress.harness!=='string'||typeof row.parentAddress.nativeSessionId!=='string')throw new Error();addressKey(row.parentAddress);parentAddress={hostId:host.hostId,harness:row.parentAddress.harness,nativeSessionId:row.parentAddress.nativeSessionId};}catch{partial=true;}}
     sessions.set(addressKey(s.address),{...s,...(parentAddress?{parentAddress}:{})});
    }
    // Include fresh compact IDs absent from the full persisted catalog (allocated empty threads).
    for(const s of overlay)if(!sessions.has(addressKey(s.address)))sessions.set(addressKey(s.address),s);
    if(!cursor&&cached.sessions.length>overlay.length)partial=true;
    return {hostId:host.hostId,sessions:[...sessions.values()],nextCursor:raw.nextCursor as string|null,observedAt:raw.observedAt as string|null,warming:raw.warming===true,partial,total:Number.isSafeInteger(raw.total)&&Number(raw.total)>=0?Number(raw.total):raw.sessions.length};
    });pages.set(host.hostId,page);
   }catch(e){pages.set(host.hostId,empty(e instanceof Error?e.message.slice(0,96):'inventory_read_failed'));}
  }}));
  return {hosts:selected,pages:selected.map(h=>pages.get(h.hostId)!),scopeKey:this.browserScopeKey};
 }
 private now(){return (this.deps.now??Date.now)();}
 private async selectedHost(hostId:string,requestId?:string):Promise<void>{
  if(!this.deps.rustCore)return; // Existing configured-source behavior is unchanged until explicit wiring.
  const selected=await this.deps.rustCore.resolveHost(hostId,this.deps.hosts.map(h=>h.hostId),requestId);
  if(selected!==hostId)throw new Error('rust_core_route_unverified'); // Never retarget an accepted intent.
 }
 private transport(hostId:string){let t=this.transports.get(hostId);if(!t){t=this.deps.transportFactory({...this.deps.scope,hostId,...(this.deps.credentialGeneration?{credentialGeneration:this.deps.credentialGeneration}:{})});this.transports.set(hostId,t);}return t;}
 private async bounded<T>(operation:Promise<T>,deadline:number,limitMs=this.deps.readDeadlineMs??10000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fleet_read_deadline')),Math.max(1,Math.min(limitMs,deadline-this.now())));})]);}finally{if(timer)clearTimeout(timer);}
 }
 async snapshot(options:{hostId?:string;limit?:number;refresh?:boolean}={}):Promise<FleetView>{
  const limit=options.limit??12;
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error('Fleet limit must be 1..12');
  if(options.hostId&&!this.deps.hosts.some(h=>h.hostId===options.hostId))throw new Error('Unknown fleet host');
  if(options.hostId)await this.selectedHost(options.hostId);
  // Sharing only within this immutable profile/user scope. Each request applies its own output window.
  let all:FleetView;
  if(options.refresh&&options.hostId)all=await this.refresh(options.hostId);
  else if(this.pending)all=await this.pending;
  else if(!options.refresh&&this.lastReadAt!==null&&this.now()-this.lastReadAt<(this.deps.ttlMs??60000)&&[...this.cache.values()].every(r=>!['ready','metadata_only'].includes(r.host.state)||(r.host.expiresAt??0)>this.now())){
   const entries=this.deps.hosts.map(h=>this.cache.get(h.hostId)!);all={hosts:entries.map(r=>r.host),sessions:entries.flatMap(r=>r.sessions),complete:entries.every(r=>r.complete),limited:entries.some(r=>r.limited)};
  }else{this.pending=this.refresh().finally(()=>{this.pending=undefined;});all=await this.pending;}
  const hosts=all.hosts.filter(h=>!options.hostId||h.hostId===options.hostId);
  const sessions=all.sessions.filter(s=>!options.hostId||s.address.hostId===options.hostId);
  const limited=all.limited||sessions.length>limit;
  return {hosts,sessions:options.hostId?sessions.slice(0,limit):fairWindow(sessions,hosts.map(h=>h.hostId),limit),limited,complete:!limited&&hosts.every(h=>this.cache.get(h.hostId)?.complete===true&&h.state==='ready')};
 }
 private async refresh(selectedHostId?:string):Promise<FleetView>{
  const revision=++this.readRevision;
  const deadline=this.now()+(this.deps.discoveryDeadlineMs??45000);let registry:Record<string,unknown>[]=[];let registryFailed=false;
  try{const r=unwrapResult(await this.bounded(this.transport(this.deps.hosts[0]!.hostId).discover(),deadline));if(!Array.isArray(r.servers)||r.servers.length>256)throw new Error('fleet_registry_invalid');registry=r.servers.filter(v=>v&&typeof v==='object');}catch{registryFailed=true;}
  const results=new Map<string,Cached>();let next=0;
  const queried=this.deps.hosts.filter(h=>!selectedHostId||h.hostId===selectedHostId);
  await Promise.all(Array.from({length:3},async()=>{for(;;){const definition=queried[next++];if(!definition)return;
   const {hostId}=definition;const shell=registry.find(r=>r.server_id===`shell:${hostId}`);
   const peers=registry.filter(r=>r.kind==='child_mcp'&&typeof r.server_id==='string'&&r.server_id.startsWith(`mcp:shell:${hostId}:`));
   const peer=peers.find(r=>/^(AgentHerder|agent-herder)$/i.test(String(r.server_id).split(':').at(-1)!))??peers.find(r=>/HarnessMesh/i.test(String(r.server_id).split(':').at(-1)!));
   const unavailable=(reason:string,state:FleetHost['state']='unavailable'):Cached=>{
    const old=this.cache.get(hostId);
    // Failure/missing peer does not advance freshness or preserve control capability.
    if(old)return {...old,revision,complete:false,host:{...old.host,state:'stale',createHarnesses:[],reason},sessions:old.sessions};
    return {revision,host:{...definition,state,fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[],reason},sessions:[],complete:false,limited:false,target:''};
   };
   // Published child health can lag its online parent by a full heartbeat interval.
   // Probe only a registered failed/offline child under a proven online parent;
   // readiness and control still require the bounded native identity/snapshot below.
   const configuredDirectProbe=shell?.status==='configured'&&peer?.status==='configured';
   const staleChildProbe=shell?.status==='online'&&['failed','offline'].includes(String(peer?.status));
   const parentUnavailable=!!shell&&shell.status!=='online'&&!configuredDirectProbe;
   if(registryFailed||!peer||parentUnavailable||peer.status!=='online'&&!staleChildProbe&&!configuredDirectProbe){results.set(hostId,unavailable(registryFailed?'registry_read_failed':shell?.status==='offline'?'host_offline':parentUnavailable?'host_unavailable':!peer?'local_herder_not_registered':'local_herder_offline',shell?.status==='offline'?'offline':'unavailable'));continue;}
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
    const at=this.now();results.set(hostId,{revision,target,sessions,limited,inventorySupported:tools.some(t=>t.name==='fleet_session_page'),complete:full&&raw.complete===true&&!partial&&!limited,host:{...definition,state:full?'ready':'metadata_only',fetchedAt:at,expiresAt:at+(this.deps.ttlMs??60000),generation:Number.isSafeInteger(info.generation)?info.generation as number:null,createHarnesses,...(!full?{reason:'local_control_not_registered'}:partial?{reason:'invalid_peer_session'}:{})}});
   }catch(e){results.set(hostId,unavailable(e instanceof Error?e.message.slice(0,96):'fleet_read_failed'));}
  }}));
  // Atomic publish; timed-out reads have no callback that can mutate the cache.
  const expire=(r:Cached):Cached=>['ready','metadata_only'].includes(r.host.state)&&(r.host.expiresAt??0)<=this.now()?{...r,complete:false,host:{...r.host,state:'stale',createHarnesses:[],reason:'metadata_expired'}}:r;
  for(const [hostId,result]of results){const prior=this.cache.get(hostId);if(!prior||prior.revision<=result.revision)this.cache.set(hostId,expire(result));}
  for(const [hostId,entry]of this.cache)this.cache.set(hostId,expire(entry));
  if(!selectedHostId)this.lastReadAt=this.now();
  const ordered=queried.map(h=>this.cache.get(h.hostId)!);
  return {hosts:ordered.map(r=>r.host),sessions:ordered.flatMap(r=>r.sessions),complete:ordered.every(r=>r.complete),limited:ordered.some(r=>r.limited)};
 }
 async create(request:FleetCreateRequest):Promise<FleetCreateReceipt>{
  const reject=(reason:string,retryable=true):FleetCreateReceipt=>({state:'not_attempted',inputId:request.inputId,retryable,reason});
  if(!this.journal)return reject('durable_create_journal_not_configured',false);
  if(!this.deps.hosts.some(h=>h.hostId===request.hostId)||!fleetHarnesses.includes(request.harness)||!validText(request.inputId,256)||!validText(request.name,128)||!validText(request.cwd,4096)||!absolutePath(request.cwd)||request.model!==undefined&&!validText(request.model,128)||request.project!==undefined&&!validText(request.project,512))return reject('invalid_create_request',false);
  return this.journal.once(request,async()=>{
   try{await this.snapshot({hostId:request.hostId,refresh:true});}catch{return reject('native_preflight_read_failed');}
   const node=this.cache.get(request.hostId);
   if(!node||node.host.state!=='ready'||(node.host.expiresAt??0)<=this.now()||!node.host.createHarnesses.includes(request.harness))return reject('native_create_unavailable');
   // One mutation only. A lost response is durable UNKNOWN, even if the native process completes later.
   const raw=unwrapResult(await this.bounded(this.transport(request.hostId).call(node.target,'create_session',{harness:request.harness,name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{}),...(request.project!==undefined?{project:request.project}:{})},createHash('sha256').update(JSON.stringify([this.deps.scope.profileId,this.deps.scope.userId,request.hostId,request.inputId])).digest('hex')),this.now()+(this.deps.createDeadlineMs??30000),this.deps.createDeadlineMs??30000));
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
