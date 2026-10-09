/** Stable native address. Project is observed state, never an address component. */
export interface MeshAddress { hostId: string; harness: string; nativeSessionId: string }
export interface ProjectObservation { launchCwd: string | null; currentCwd: string | null; source: string }
export interface MeshSession { address: MeshAddress; project: ProjectObservation; status: string; title: string; lastActivity: string; model?: string }
export interface NativeReceipt { state: "admitted" | "not_attempted" | "unknown"; inputId: string; turnId?: string; retryable: boolean; reason?:string; retryAfterMs?:number }
type SessionInput = { id: string; harness: string; cwd: string; status: string; title: string; lastActivity: string; model?: string; meta?: Record<string, unknown> };
export function addressKey(address: MeshAddress): string {
  for (const value of [address.hostId,address.harness,address.nativeSessionId]) if (!value || value.length>512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid native mesh address");
  return JSON.stringify([address.hostId,address.harness,address.nativeSessionId]);
}
export function projectObservation(session: {cwd:string;meta?:Record<string,unknown>}): ProjectObservation {
  const meta=session.meta || {};
  const launchCwd=typeof meta.launchCwd==="string" ? meta.launchCwd : session.cwd || null;
  const currentCwd=typeof meta.activeCwd==="string" && typeof meta.projectSource==="string" ? meta.activeCwd : null;
  return {launchCwd,currentCwd,source:currentCwd ? String(meta.projectSource) : "unverified"};
}
export function compactSession(hostId:string,session:SessionInput): MeshSession {
  const address={hostId,harness:session.harness,nativeSessionId:typeof session.meta?.nativeSessionId==="string" ? session.meta.nativeSessionId : session.id};
  addressKey(address);
  return {address,project:projectObservation(session),status:session.status,title:session.title.slice(0,160),lastActivity:session.lastActivity,...(session.model?{model:session.model}:{})};
}
/** Unwrap only documented GPTAdmin and MCP envelopes; never infer success from ACK. */
export function unwrapResult(value:unknown): Record<string,unknown> {
  let result=value;
  for(let depth=0;depth<8;depth++) {
    if(!result || typeof result!=="object") return {};
    const r=result as Record<string,unknown>;
    if(r.isError===true || r.status==="failed") throw new Error("Remote MCP operation failed");
    if(r.structuredContent) {result=r.structuredContent;continue;}
    if(r.result && typeof r.result==="object") {result=r.result;continue;}
    if(r.response && typeof r.response==="object") {result=r.response;continue;}
    if(Array.isArray(r.content)&&r.content.length===1&&r.content[0]?.type==="text") {
      const text=r.content[0].text;
      if(typeof text==="string"&&text.length<=65536&&text.trimStart().startsWith("{")){
        try{result=JSON.parse(text);continue;}catch{/* textual native receipt stays textual */}
      }
    }
    return r;
  }
  throw new Error("Remote MCP envelope exceeds depth limit");
}
export function parseNativeReceipt(value:unknown,inputId:string): NativeReceipt {
  let r=unwrapResult(value);
  if(Array.isArray(r.content)) {
    for(const block of r.content) {
      const text=typeof block?.text==="string" ? block.text : "";
      const match=text.match(/Native admission receipt:\s*(\{[^\n]*\})/);
      if(/^Session '[^\n]+' not found\.$/.test(text))return {state:"not_attempted",inputId,retryable:true,reason:"native_session_not_found"};
      try {if(match){r=JSON.parse(match[1]!);break;} if(text.startsWith("{")) {r=JSON.parse(text);break;}} catch { /* no trustworthy receipt */ }
    }
  }
  if(r.admitted===true && r.inputId===inputId && typeof r.turnId==="string" && r.turnId) return {state:"admitted",inputId,turnId:r.turnId,retryable:false};
  if(r.admissionUnknown===true||r.nonRetryable===true||r.state==="unknown"||r.delivery==="admission_unknown")return {state:"unknown",inputId,retryable:false};
  if(r.admitted===false&&r.inputId===inputId&&r.admissionUnknown!==true&&r.nonRetryable!==true&&r.delivery!=="admission_unknown"&&r.state!=="unknown")return {state:"not_attempted",inputId,retryable:true,reason:"native_admission_rejected"};
  if(r.ok===false&&r.delivery==="rate_limited"&&r.activated===false)return {state:"not_attempted",inputId,retryable:true,reason:"rate_limited",...(typeof r.retryAfterMs==="number"?{retryAfterMs:r.retryAfterMs}:{})};
  if(r.delivery==="not_attempted" || r.delivery==="not_found" || r.delivery==="skipped_inactive") return {state:"not_attempted",inputId,retryable:true};
  return {state:"unknown",inputId,retryable:false};
}
