import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { resolveAutopilotStateDir } from "./autopilot/state-dir.js";
import { readCodexUsage, CODEX_USAGE_FETCH_TIMEOUT_MS } from "./web/quota-lens.js";

export interface CodexQuotaPolicy { enabled: boolean; minRemainingPercent: number; onUnknown: "block" | "allow" }
export const DEFAULT_CODEX_QUOTA_POLICY: Readonly<CodexQuotaPolicy> = Object.freeze({ enabled: true, minRemainingPercent: 20, onUnknown: "block" });
export type QuotaReader = () => Promise<unknown>;
export type QuotaDecision = { allowed: boolean; reason: string; remainingPercent: number | null; windows: Array<{ name: string; remainingPercent: number; resetsAt: number | null }>; checkedAt: string };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function codexQuotaPolicyPath(): string { return join(resolveAutopilotStateDir(), "codex-quota-guard.json"); }
export function validateCodexQuotaPolicy(value: unknown): CodexQuotaPolicy {
  const p=object(value);
  if(Object.keys(p).some(k=>!["enabled","minRemainingPercent","onUnknown"].includes(k)) || typeof p.enabled!=="boolean" || !finite(p.minRemainingPercent) || p.minRemainingPercent<0 || p.minRemainingPercent>100 || !["block","allow"].includes(String(p.onUnknown))) throw new Error("Invalid Codex quota policy: enabled boolean, minRemainingPercent 0..100, onUnknown block|allow required");
  return {enabled:p.enabled,minRemainingPercent:p.minRemainingPercent,onUnknown:p.onUnknown as "block"|"allow"};
}
const revision = (p: CodexQuotaPolicy) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
export async function loadCodexQuotaPolicy(path=codexQuotaPolicyPath()): Promise<{policy:CodexQuotaPolicy;revision:string}> {
  let policy:CodexQuotaPolicy;
  try {
    const info=await lstat(path); if(!info.isFile() || info.isSymbolicLink() || info.size>16384) throw new Error("Invalid quota policy file");
    const data=JSON.parse(await readFile(path,"utf8"));
    if(data.version!==1) throw new Error("Unsupported quota policy version");
    policy=validateCodexQuotaPolicy(data.policy);
  } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; policy={...DEFAULT_CODEX_QUOTA_POLICY}; }
  return {policy,revision:revision(policy)};
}
export async function saveCodexQuotaPolicy(value:unknown,expectedRevision:string,path=codexQuotaPolicyPath()):Promise<{policy:CodexQuotaPolicy;revision:string}> {
  const policy=validateCodexQuotaPolicy(value); await mkdir(dirname(path),{recursive:true,mode:0o700});
  const lock=path+".lock";
  try {await mkdir(lock,{mode:0o700});} catch {throw new Error("quota_policy_conflict: another settings write is active");}
  try {
    const current=await loadCodexQuotaPolicy(path);
    if(!expectedRevision || expectedRevision!==current.revision) throw new Error("quota_policy_conflict: reload settings before saving");
    const temp=path+".tmp-"+randomUUID();
    await writeFile(temp,JSON.stringify({version:1,policy},null,2)+"\n",{mode:0o600,flag:"wx"});
    await rename(temp,path);
    return {policy,revision:revision(policy)};
  } finally {await rmdir(lock);}
}

/** Fresh readings only; never infer reset/recovery from elapsed time or stored rollouts. */
export function evaluateCodexQuota(raw:unknown,policy:CodexQuotaPolicy,now=Date.now()):QuotaDecision {
  const windows:QuotaDecision["windows"]=[];
  const done=(allowed:boolean,reason:string):QuotaDecision=>({allowed,reason,remainingPercent:windows.length?Math.min(...windows.map(w=>w.remainingPercent)):null,windows,checkedAt:new Date(now).toISOString()});
  if(!policy.enabled) return done(true,"disabled_by_operator");
  const data=object(raw); let invalid=false,expired=false,denied=false;
  if(data.error || !Object.keys(data).length) return done(policy.onUnknown==="allow","quota_unknown");
  const add=(name:string,value:unknown)=>{
    if(value===null || value===undefined)return;
    const w=object(value);const used=w.usedPercent??w.used_percent;const reset=w.resetsAt??w.reset_at;
    if(!finite(used)||used<0||used>100){invalid=true;return;}
    if(finite(reset)&&reset>0&&reset*1000<=now)expired=true;
    windows.push({name,remainingPercent:100-used,resetsAt:finite(reset)?reset:null});
  };
  const bucket=(name:string,value:unknown)=>{
    const b=object(value); if(!Object.keys(b).length){invalid=true;return;}
    if(b.allowed===false||b.limit_reached===true||b.rateLimitReachedType!=null||b.spendControlReached===true)denied=true;
    add(name+".primary",b.primary??b.primary_window);add(name+".secondary",b.secondary??b.secondary_window);
    const spend=object(b.spendControlLimit??b.spendControl);
    if(finite(spend.remainingPercent)){if(spend.remainingPercent<0||spend.remainingPercent>100)invalid=true;else windows.push({name:name+".spend",remainingPercent:spend.remainingPercent,resetsAt:finite(spend.resetsAt)?spend.resetsAt:null});}
  };
  if(data.ordinaryUsageAllowed===false||data.allowed===false||data.limit_reached===true)denied=true;
  if("ordinaryUsageAllowed" in data && data.ordinaryUsageAllowed===null)invalid=true;
  const byId=object(data.rateLimitsByLimitId);
  if(Object.keys(byId).length)for(const [id,b] of Object.entries(byId))bucket(id,b);
  else if(data.rateLimits)bucket("codex",data.rateLimits);
  else if(data.rate_limit)bucket("codex",data.rate_limit);
  else {
    if(data.primary_window!=null)add("codex.primary",data.primary_window);
    else if(data.primary_used!==undefined)add("codex.primary",{used_percent:data.primary_used,reset_at:data.primary_reset_at});
    if(data.secondary_window!=null)add("codex.secondary",data.secondary_window);
    else if(data.secondary_used!==undefined)add("codex.secondary",{used_percent:data.secondary_used,reset_at:data.secondary_reset_at});
  }
  if(denied)return done(false,"provider_denied");
  // A proven low window wins even when another window is unavailable.
  if(windows.some(w=>w.remainingPercent<policy.minRemainingPercent))return done(false,"below_reserve");
  if(invalid||expired||!windows.length)return done(policy.onUnknown==="allow",expired?"quota_snapshot_expired":"quota_unknown");
  return done(true,"reserve_available");
}

export class CodexQuotaBlockedError extends Error {
  readonly code="codex_quota_guard";readonly notSubmitted=true;readonly admitted=false;readonly nonRetryable=true;
  constructor(readonly decision:QuotaDecision,readonly operation:string) {
    super("codex_quota_guard: "+decision.reason+"; remaining="+(decision.remainingPercent===null?"unknown":decision.remainingPercent+"%")+"; request was not submitted. Настройка: Автоматизация / Запуск сессий / Защита лимита Codex.");
    this.name="CodexQuotaBlockedError";
  }
}
let lastDenial: {operation:string;decision:QuotaDecision}|undefined;
/** Strictly above the reader's own deadline: a read that lands within it is
 * fresh account evidence, and preempting it here would turn the same outage
 * into quota_unknown on the guard while model_quotas still sees the answer. */
export const CODEX_QUOTA_READ_BOUND_MS=CODEX_USAGE_FETCH_TIMEOUT_MS+1_500;
async function boundedRead(reader:QuotaReader):Promise<unknown> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([reader(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("quota_read_timeout")),CODEX_QUOTA_READ_BOUND_MS);timer.unref?.();})]);}
  catch{return {error:"quota_source_unavailable"};} finally {if(timer)clearTimeout(timer);}
}
const QUOTA_HISTORY_MAX_AGE_MS=5*60_000; // quota-lens sampler interval; no additional grace.
const quotaHistoryPath=()=>process.env.QUOTA_LENS_HISTORY?.trim()||join(homedir(),".local","share","quota-lens","history.jsonl");
/** History has no account ID; its local sampler provenance permits same-host fallback only. */
async function recentLocalQuotaSnapshot(now:number):Promise<unknown|undefined>{
  try{
    const path=quotaHistoryPath(),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1_048_576)return;
    const lines=(await readFile(path,"utf8")).split("\n").filter(Boolean).slice(-64);
    for(let i=lines.length-1;i>=0;i--){
      let record:Record<string,unknown>;try{record=object(JSON.parse(lines[i]));}catch{continue;}
      if(!finite(record.ts))continue;
      const ts=record.ts>1e12?record.ts:record.ts*1000;
      if(ts>now||now-ts>QUOTA_HISTORY_MAX_AGE_MS)continue;
      if(typeof record.host==="string"&&record.host!==hostname())continue;
      const q=object(record.quota),primary=q.primary??q.primary_used,secondary=q.secondary??q.secondary_used;
      if(q.allowed!==true||q.limit_reached===true||(q.limit_reached!==undefined&&typeof q.limit_reached!=="boolean"))continue;
      if(!finite(primary)||primary<0||primary>100)continue;
      if(secondary!==undefined&&(!finite(secondary)||secondary<0||secondary>100))continue;
      return {primary_window:{used_percent:primary,reset_at:q.primary_reset_at},...(secondary===undefined?{}:{secondary_window:{used_percent:secondary,reset_at:q.secondary_reset_at}}),allowed:true,limit_reached:false};
    }
  }catch{}
  return undefined;
}
export async function checkCodexQuota(reader:QuotaReader=readCodexUsage,path=codexQuotaPolicyPath(),allowLocalHistory=true) {
  try {
    const loaded=await loadCodexQuotaPolicy(path);
    const raw=loaded.policy.enabled?await boundedRead(reader):{};
    let decision=evaluateCodexQuota(raw,loaded.policy);
    if(loaded.policy.enabled&&decision.reason==="quota_unknown"&&allowLocalHistory){
      const snapshot=await recentLocalQuotaSnapshot(Date.now());
      if(snapshot!==undefined){const fallback=evaluateCodexQuota(snapshot,loaded.policy);if(fallback.allowed)decision=fallback;}
    }
    return {...loaded,decision,lastDenial};
  } catch {
    return {policy:{...DEFAULT_CODEX_QUOTA_POLICY},revision:"",decision:{allowed:false,reason:"quota_policy_unavailable",remainingPercent:null,windows:[],checkedAt:new Date().toISOString()} as QuotaDecision,lastDenial};
  }
}
/** A model route that never draws on the OpenAI Codex account (e.g. OmniRoute zc/glm-*). */
export function codexQuotaExemptModel(model: string | null | undefined): boolean {
  return typeof model === "string" && /^(zc\/|glm[-_.0-9])/i.test(model.trim());
}

export async function assertCodexQuota(operation:string,reader:QuotaReader=readCodexUsage,allowLocalHistory=true):Promise<void> {
  const {decision}=await checkCodexQuota(reader,codexQuotaPolicyPath(),allowLocalHistory);
  if(!decision.allowed){lastDenial={operation,decision};throw new CodexQuotaBlockedError(decision,operation);}
}

/** Caller-side fleet protection uses the recipient's quota, never another host's account. */
export async function assertRemoteCodexAdmission(tool:string,args:Record<string,unknown>,readRemote:QuotaReader):Promise<void> {
  const admission=["create_session","fleet_create_session","new_or_resume","send_message","resume_agent","deliver","mesh_deliver","message","resume"];
  if(!admission.includes(tool))return;
  const harness=args.harness??object(args.target).harness;
  if(harness!==undefined && harness!=="codex")return;
  await assertCodexQuota("remote/"+tool,async()=>{
    let value:unknown=await readRemote();
    for(let i=0;i<8;i++){
      const v=object(value);
      if(Array.isArray(v.providers)){
        const provider=v.providers.map(object).find(x=>x.provider==="codex");
        return provider?.state==="reported"?provider.details:{error:"recipient_codex_quota_unknown"};
      }
      if(v.structuredContent){value=v.structuredContent;continue;}
      if(v.result){value=v.result;continue;}
      if(v.response){value=v.response;continue;}
      const blocks=Array.isArray(v.content)?v.content:[];
      const text=blocks.map(object).find(x=>x.type==="text"&&typeof x.text==="string")?.text;
      if(typeof text==="string"){try{value=JSON.parse(text);continue;}catch{}}
      return {error:"recipient_codex_quota_unknown"};
    }
    return {error:"recipient_codex_quota_unknown"};
  },false);
}
