import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, MessageAdmissionResult, SendMessageResult } from "./types/index.js";
import { ResumeAfterService, type ResumeAfterWait, type SessionRef } from "./resume-after.js";
import { readExactCodexActiveSession } from "./adapters/codex-active-runtime.js";
import { canonicalMode, createCanonicalAutomationClient } from "./canonical-herder.js";
import { createCanonicalResumeAfterRuntime } from "./resume-after-canonical.js";
import type { ResumeAfterBackend } from "./resume-after.js";

interface Supervisor {
  sendMessage(harness:string,id:string,options:{message:string;origin:"automation";inputId:string;queue:boolean}):Promise<SendMessageResult & {delivery?:string}>;
  isAutomationHeld(harness:string,id:string):Promise<boolean>;
}
export function parseResumeAfterStartupHold(value:string|undefined=process.env.AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD):boolean{
  if(value===undefined)return false;
  if(value==="enabled")return true;
  if(value==="disabled")return false;
  throw new Error("AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD must be exactly 'enabled' or 'disabled'");
}
/** Reuse the existing native adapters and admission. No CLI, model or daemon. */
export function createResumeAfterRuntime(adapters:Map<string,HarnessAdapter>,supervisor:Supervisor,
  held:(harness:string,id:string)=>Promise<boolean>,directory=process.env.AGENT_HERDER_RESUME_AFTER_DIR ?? join(homedir(),".local/state/agent-herder/resume-after"),
  holdExistingWaitingAtStartup=parseResumeAfterStartupHold(),
  onHumanRequestTimeout?:(wait:ResumeAfterWait)=>Promise<"closed"|"already_answered">) {
  if(canonicalMode()!=="legacy")throw new Error("canonical_resume_after_requires_configured_runtime");
  const inputId=(wait:ResumeAfterWait)=>"resume-after:"+wait.id;
  const service=new ResumeAfterService({
    directory,
    holdExistingWaitingAtStartup,
    onHumanRequestTimeout,
    validateRef:async(ref:SessionRef)=>{
      if(!adapters.has(ref.harness) || !await adapters.get(ref.harness)!.getSession(ref.sessionId))
        throw new Error(`Exact session unavailable: ${ref.harness}:${ref.sessionId}`);
    },
    validateDependency:async(ref:SessionRef)=>{
      const adapter=adapters.get(ref.harness);
      if(!adapter?.subscribeEvents)
        throw new Error(`Harness ${ref.harness} does not publish native turn events required for resume_after`);
      if(ref.harness!=='codex' && ref.harness!=='zcode')
        throw new Error(`Harness ${ref.harness} does not expose an exact native turn identity required for resume_after; use Codex or ZCode`);
    },
    isHeld:async ref=>await held(ref.harness,ref.sessionId) || await supervisor.isAutomationHeld(ref.harness,ref.sessionId),
    isBusy:async ref=>{
      try{
        const session=await adapters.get(ref.harness)?.getSession(ref.sessionId);
        return !session || session.status==="running" || session.status==="needs_input" || session.needsPermission;
      }catch{return true;}
    },
    readDependency:async ref=>{
      const adapter=adapters.get(ref.harness);
      let session=await adapter?.getSession(ref.sessionId);
      if(!session)throw new Error("Exact dependency unavailable");
      const lastMeta=session.meta?.nativeLastTurn && typeof session.meta.nativeLastTurn==="object"
        ? session.meta.nativeLastTurn as Record<string,unknown> : undefined;
      const hasTurnIdentity=typeof session.meta?.activeTurnId==="string"
        || typeof session.meta?.nativeActiveTurnId==="string"
        || typeof lastMeta?.turnId==="string";
      // The persisted Codex projection may be an idle archive summary while
      // the connected app-server has an exact active turn. Probe only that
      // narrow case, with HumanStop/automation holds checked on both sides.
      if(ref.harness==="codex" && session.status==="idle" && session.needsPermission!==true
        && session.meta?.humanStopHeld!==true && !hasTurnIdentity
        && session.meta?.nativeTurnStateUnavailable!==true && session.meta?.nativeStateObserved!==false){
        let isHeldNow=true;
        try { isHeldNow=await held(ref.harness,ref.sessionId) || await supervisor.isAutomationHeld(ref.harness,ref.sessionId); }
        catch { isHeldNow=true; }
        if(!isHeldNow){
          const active=await readExactCodexActiveSession(adapter!,ref.sessionId).catch(()=>null);
          let stillHeld=true;
          try { stillHeld=await held(ref.harness,ref.sessionId) || await supervisor.isAutomationHeld(ref.harness,ref.sessionId); }
          catch { stillHeld=true; }
          if(!stillHeld && active) session={...session,status:"running",needsPermission:session.needsPermission,meta:{...session.meta,...active.meta}};
        }
      }
      const string=(value:unknown)=>typeof value==="string" && value.trim()?value:undefined;
      const nativeTimestamp=(value:unknown):string|undefined=>{
        const millis=typeof value==="number"&&Number.isFinite(value)?value
          :typeof value==="string"&&value.trim()?Date.parse(value):Number.NaN;
        if(!Number.isFinite(millis))return undefined;
        try{return new Date(millis).toISOString();}catch{return undefined;}
      };
      const meta=session.meta??{};
      if(ref.harness==="codex" && (meta.nativeTurnStateUnavailable===true || meta.nativeStateObserved===false))
        throw new Error("Codex native turn state is unavailable");
      const active=string(meta.activeTurnId)??string(meta.nativeActiveTurnId);
      const last=meta.nativeLastTurn && typeof meta.nativeLastTurn==="object"?meta.nativeLastTurn as Record<string,unknown>:{};
      const nativeInProgress=["inProgress","running"].includes(String(last.status));
      const busy=Boolean(active || nativeInProgress || session.status==="running" || session.status==="needs_input" || session.needsPermission);
      const turnId=active??(!busy || nativeInProgress?string(last.turnId):undefined);
      const outcome=last.status==="completed"?"turn.completed":["failed","error","cancelled","interrupted"].includes(String(last.status))?"turn.failed":undefined;
      const completedAt=nativeTimestamp(last.completedAt);
      return {busy,turnId,...(!busy && turnId && outcome && completedAt?{completion:{outcome,at:completedAt}}:{})};
    },
    deliver:async wait=>{
      const result=await supervisor.sendMessage(wait.owner.harness,wait.owner.sessionId,
        {message:wait.message,origin:"automation",inputId:inputId(wait),queue:true});
      if(result.admissionUnknown || result.delivery==="deferred")return {status:"ambiguous",reason:result.error??"Native delivery is not confirmed"};
      if(result.admitted || result.ok)return {status:"accepted"};
      // This supervisor refusal is definitively before adapter.sendMessage.
      // Other failures without non-submission proof must never become retryable.
      const rejected=result.notSubmitted===true;
      return {status:rejected?"rejected":"failed",reason:result.error,receipt:{...result}};
    },
    queryReceipt:async wait=>{
      const adapter=adapters.get(wait.owner.harness);
      // Receipt-aware adapters preserve the original native result. A generic
      // failed status or error text alone is not proof of non-submission.
      const result:(MessageAdmissionResult & {receipt?:SendMessageResult})|undefined=
        await adapter?.getMessageAdmission?.(wait.owner.sessionId,inputId(wait));
      const receipt=result?.receipt;
      if(result?.state==="unknown" || receipt?.admissionUnknown)
        return {status:"ambiguous",reason:receipt?.error??result?.error??"Native receipt is unknown; not replaying"};
      if(result?.state==="admitted" || receipt?.admitted || receipt?.ok)return {status:"accepted"};
      if(result?.state==="failed" && receipt?.ok===false && receipt.notSubmitted===true)
        return {status:"rejected",reason:receipt.error??result.error,receipt:{...receipt}};
      return {status:"ambiguous",reason:result?.error??"Native receipt is unknown; not replaying"};
    },
  });
  let timer:NodeJS.Timeout|undefined;
  let subscriptions:Array<()=>void>=[];
  let lastError="";
  const report=(error:unknown)=>{const message=String(error);if(message!==lastError)console.error(`[agent-herder] resume-after: ${message}`);lastError=message;};
  return {service,async start():Promise<()=>void>{
    if(timer)return ()=>{};
    const heldCount=await service.captureStartupHold();
    if(holdExistingWaitingAtStartup)console.warn(`[agent-herder] resume-after startup maintenance hold active for ${heldCount} existing waiting records`);
    subscriptions=[...adapters.values()].flatMap(adapter=>adapter.subscribeEvents?
      [adapter.subscribeEvents(event=>{void service.observe({...event,harness:adapter.type}).catch(report);})]:[]);
    timer=setInterval(()=>{void service.sweep().then(()=>{lastError="";}).catch(report);},5000);
    timer.unref?.();void service.sweep().catch(report);
    return ()=>{if(timer)clearInterval(timer);timer=undefined;for(const stop of subscriptions)stop();subscriptions=[];};
  }};
}

/** Select one backend at startup; a broken canonical binding never falls back. */
export async function createConfiguredResumeAfterRuntime(...args: Parameters<typeof createResumeAfterRuntime>): Promise<{
  service: ResumeAfterBackend; start(): Promise<() => void>;
}> {
  const client = await createCanonicalAutomationClient();
  if (client) return createCanonicalResumeAfterRuntime(client);
  return createResumeAfterRuntime(...args);
}
