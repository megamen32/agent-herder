import {createHash} from "node:crypto";
import {CoordinationDeliveryBudget} from "../coordination-delivery-budget.js";
import {addressKey,unwrapResult,type MeshAddress,type MeshSession,type NativeReceipt} from "./protocol.js";
import {inventoryHarnesses} from "./inventory.js";

/** Supplied by the authenticated consumer; mesh does not mint tokens or bypass profiles. */
export interface GptAdminTransport {
  discover():Promise<unknown>;
  schema(target:string):Promise<unknown>;
  call(target:string,tool:string,args:Record<string,unknown>,idempotencyKey?:string):Promise<unknown>;
}
export interface MeshDelivery {target:MeshAddress;sender:MeshAddress;inputId:string;message:string}
export interface MeshHostReceipt {hostId:string;target?:string;state:"available"|"unavailable";reason?:string;complete?:boolean;harnesses?:unknown[]}
export interface MeshDiscovery {sessions:MeshSession[];hosts:MeshHostReceipt[];complete:boolean;limited:boolean}
type DeliveryReceipt=NativeReceipt & {reason?:string};
type Route={target:string;nativeIds:Set<string>};
const shortReason=(value:string)=>value.slice(0,192).replace(/[\x00-\x1f\x7f]/g,"").slice(0,96);
const display=(value:unknown,limit:number,fallback="")=>typeof value==="string"?value.slice(0,limit*2).replace(/[\x00-\x1f\x7f]/g,"").slice(0,limit):fallback;
export function projectPeerSession(raw:unknown,hostId:string):MeshSession|null{
  if(!raw||typeof raw!=="object")return null;
  const s=raw as Record<string,unknown>,a=s.address as Record<string,unknown>|undefined,p=s.project as Record<string,unknown>|undefined;
  if(!a||!p||a.hostId!==hostId||typeof a.harness!=="string"||a.harness.length>64||!inventoryHarnesses.includes(a.harness)||typeof a.nativeSessionId!=="string")return null;
  const address={hostId,harness:a.harness,nativeSessionId:a.nativeSessionId};
  try{addressKey(address);}catch{return null;}
  // Paths and identity are evidence, not display text: reject, never truncate.
  for(const cwd of [p.launchCwd,p.currentCwd])if(cwd!==null&&(typeof cwd!=="string"||!cwd||cwd.length>4096||/[\x00-\x1f\x7f]/.test(cwd)||!(/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd))))return null;
  const model=display(s.model,128);
  return {address,project:{launchCwd:p.launchCwd as string|null,currentCwd:p.currentCwd as string|null,source:display(p.source,64,"unverified")||"unverified"},status:display(s.status,32,"unknown")||"unknown",title:display(s.title,160),lastActivity:display(s.lastActivity,64),...(model?{model}:{})};
}
function compactHarnesses(rows:unknown[]):{rows:unknown[];partial:boolean}{
  const result:unknown[]=[];const seen=new Set<string>();let partial=rows.length>32;
  for(const row of rows.slice(0,32)){
    if(!row||typeof row!=="object"){partial=true;continue;}
    const h=row as Record<string,unknown>;
    if(typeof h.harness!=="string"||!inventoryHarnesses.includes(h.harness)||seen.has(h.harness)){partial=true;continue;}
    seen.add(h.harness);
    const discovery=typeof h.discovery==="string"&&["available","unavailable","not_observed"].includes(h.discovery)?h.discovery:"not_observed";
    const delivery=typeof h.delivery==="string"&&["available","unsupported","unverified"].includes(h.delivery)?h.delivery:"unverified";
    if(discovery!==h.discovery||delivery!==h.delivery)partial=true;
    result.push({harness:h.harness,discovery,delivery,...(typeof h.reason==="string"?{reason:shortReason(h.reason)}:{})});
  }
  return {rows:result,partial};
}

export class GptAdminMesh {
  private routes=new Map<string,Route>();
  private readonly budget=new CoordinationDeliveryBudget();
  private readonly inputs=new Map<string,{digest:string;result:Promise<DeliveryReceipt>}>();
  constructor(private readonly hub:GptAdminTransport,private readonly deadlineMs=5000){}
  private async bounded<T>(read:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("mesh_read_deadline")),this.deadlineMs);})]);}
    finally {if(timer)clearTimeout(timer);}
  }
  async discover(limit=12):Promise<MeshDiscovery>{
    if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Mesh discovery limit must be 1..12");
    const discovery=unwrapResult(await this.bounded(this.hub.discover()));
    if(!Array.isArray(discovery.servers))throw new Error("GPTAdmin discovery has no target list");
    const servers=discovery.servers as Array<{server_id:string;kind:string;name?:string;status:string}>;
    const shells=servers.filter(s=>s.kind==="virtual_shell"&&s.server_id.startsWith("shell:"));
    const candidates=servers.filter(s=>s.kind==="child_mcp"&&/^mcp:shell:/.test(s.server_id)&&/herder|harness.?mesh/i.test(`${s.name||""} ${s.server_id}`));
    const selected=new Map<string,typeof candidates[number]>();
    for(const s of candidates){const host=s.server_id.slice(10,s.server_id.lastIndexOf(":"));const prior=selected.get(host);if(!prior||/mesh/i.test(s.server_id))selected.set(host,s);}
    const hosts:MeshHostReceipt[]=shells.map(s=>({hostId:s.server_id.slice(6),state:"unavailable",reason:s.status!=="online"?"host_offline":"mesh_child_not_registered"}));
    const sessions:MeshSession[]=[];let peerLimited=false;
    const freshRoutes=new Map<string,Route>();
    const peers=[...selected.entries()].slice(0,12);
    // Bounded fan-out: three schema/snapshot reads at a time; no LLM or transcripts.
    for(let offset=0;offset<peers.length;offset+=3)await Promise.all(peers.slice(offset,offset+3).map(async([hostId,peer])=>{
      let receipt:MeshHostReceipt={hostId,target:peer.server_id,state:"unavailable",reason:"child_offline"};
      try{
        if(peer.status!=="online")throw new Error("child_offline");
        const schema=unwrapResult(await this.bounded(this.hub.schema(peer.server_id)));
        const tools=Array.isArray(schema.tools)?schema.tools as Array<{name:string}>:[];
        if(!tools.some(t=>t.name==="mesh_snapshot"))throw new Error("mesh_snapshot_capability_missing");
        const snapshot=unwrapResult(await this.bounded(this.hub.call(peer.server_id,"mesh_snapshot",{limit})));
        if(snapshot.hostId!==hostId)throw new Error("native_host_identity_mismatch");
        if(!Array.isArray(snapshot.sessions)||!Array.isArray(snapshot.harnesses))throw new Error("invalid_mesh_snapshot");
        const truncated=snapshot.sessions.length>limit||snapshot.limited===true;
        if(truncated)peerLimited=true;
        const nativeIds=new Set<string>();
        const projected:MeshSession[]=[];let invalidSession=false;
        for(const raw of snapshot.sessions.slice(0,limit)){
          const s=projectPeerSession(raw,hostId);
          if(!s){invalidSession=true;continue;}
          nativeIds.add(addressKey(s.address));projected.push(s);
        }
        sessions.push(...projected);
        if(tools.some(t=>t.name==="mesh_deliver"))freshRoutes.set(hostId,{target:peer.server_id,nativeIds});
        const capabilities=compactHarnesses(snapshot.harnesses);
        receipt={hostId,target:peer.server_id,state:"available",complete:snapshot.complete===true&&!invalidSession&&!capabilities.partial&&!truncated,harnesses:capabilities.rows,...(invalidSession?{reason:"invalid_peer_session"}:capabilities.partial?{reason:"peer_capabilities_incomplete"}:{})};
      }catch(error){receipt.reason=error instanceof Error?shortReason(error.message):"mesh_read_failed";}
      const idx=hosts.findIndex(h=>h.hostId===hostId);if(idx>=0)hosts[idx]=receipt;else hosts.push(receipt);
    }));
    this.routes=freshRoutes;
    const limited=selected.size>12;
    const outputLimited=limited||peerLimited||sessions.length>limit;
    return {sessions:sessions.sort((a,b)=>addressKey(a.address).localeCompare(addressKey(b.address))).slice(0,limit),hosts:hosts.sort((a,b)=>a.hostId.localeCompare(b.hostId)),complete:!outputLimited&&hosts.every(h=>h.state==="available"&&h.complete),limited:outputLimited};
  }
  async deliver(request:MeshDelivery):Promise<DeliveryReceipt>{
    const key=addressKey(request.target)+":"+request.inputId;
    addressKey(request.sender);
    if(!request.inputId||request.inputId.length>256||!request.message.trim()||request.message.length>4000)throw new Error("Stable inputId and a 1..4000 character delta are required");
    const digest=createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const previous=this.inputs.get(key);
    if(previous)return previous.digest===digest?previous.result:{state:"not_attempted",inputId:request.inputId,retryable:false,reason:"input_id_conflict"};
    if(this.inputs.size>=4096)return {state:"not_attempted",inputId:request.inputId,retryable:true,reason:"mesh_input_capacity"};
    const route=this.routes.get(request.target.hostId);
    if(!route)return {state:"not_attempted",inputId:request.inputId,retryable:true,reason:"mesh_route_unavailable"};
    const result=this.budget.run({target:addressKey(request.target),sender:addressKey(request.sender),inputId:request.inputId,message:request.message},async()=>{
      try{
        // One call only: a timeout or lost admission response is UNKNOWN, never replayed.
        const reply=unwrapResult(await this.bounded(this.hub.call(route.target,"mesh_deliver",{...request},createHash("sha256").update(key).digest("hex"))));
        if(reply.inputId!==request.inputId||!["admitted","not_attempted","unknown"].includes(String(reply.state)))return JSON.stringify({state:"unknown",inputId:request.inputId,retryable:false});
        if(reply.state==="admitted"&&typeof reply.turnId!=="string")return JSON.stringify({state:"unknown",inputId:request.inputId,retryable:false});
        return JSON.stringify({state:reply.state,...(reply.state==="not_attempted"&&reply.retryable===true?{delivery:"not_attempted"}:{}),inputId:request.inputId,...(typeof reply.turnId==="string"?{turnId:reply.turnId}:{}),retryable:reply.state==="not_attempted"&&reply.retryable===true,...(typeof reply.reason==="string"?{reason:reply.reason}:{}),...(typeof reply.retryAfterMs==="number"?{retryAfterMs:reply.retryAfterMs}:{})});
      }catch{return JSON.stringify({state:"unknown",inputId:request.inputId,retryable:false});}
    }).then(text=>{const r=JSON.parse(text);return r.state?r:{state:"not_attempted",inputId:request.inputId,retryable:true,reason:r.delivery};});
    this.inputs.set(key,{digest,result});
    const receipt=await result;
    if(receipt.state==="not_attempted"&&receipt.retryable)this.inputs.delete(key);
    return receipt;
  }
}
