import { processWaitBlocks, type ProcessWaitSource } from "./process-wait-gate.js";
import type { HarnessAdapter, SendMessageResult } from "./types/index.js";
import { CadenceScheduler } from "./cadence-scheduler.js";
interface Supervisor {
  isAutomationHeld(harness:string,id:string):Promise<boolean>;
  sendMessage(harness:string,id:string,options:{message:string;origin:"automation";inputId:string;queue:boolean}):Promise<SendMessageResult & {delivery?:string}>;
}
export function createCadenceRuntime(adapters:Map<string,HarnessAdapter>,supervisor:Supervisor,path:string,processWaits?:ProcessWaitSource):CadenceScheduler {
  return new CadenceScheduler({path,
    inspect:async (id,harness)=>{
      const owner=harness??"codex";
      try {
      if(await supervisor.isAutomationHeld(owner,id))return "held";
      if(await processWaitBlocks(processWaits,owner,id))return "waiting";
      const session=await adapters.get(owner)?.getSession(id);
      if(!session)return "unavailable";
      if(owner==="codex" && (session.meta?.nativeTurnStateUnavailable===true || session.meta?.nativeStateObserved===false))return "unavailable";
      if(await supervisor.isAutomationHeld(owner,id))return "held";
      if(session.status==="running" || session.status==="needs_input" || session.needsPermission || session.meta?.activeTurnId || session.meta?.nativeActiveTurnId)return "busy";
      if(await processWaitBlocks(processWaits,owner,id))return "waiting";
      // CLI index describes quiescent sessions as stopped; explicit stops are
      // independently fenced by isAutomationHeld/adapter native stop evidence.
      return session.status==="idle" || session.status==="stopped"?"idle":"unavailable";
      } catch { return "unavailable"; }
    },
    deliver:async row=>{
      if(await processWaitBlocks(processWaits,row.harness??"codex",row.sessionId))return {status:"deferred",receipt:{reason:"process_wait_active",notSubmitted:true}};
      const result=await supervisor.sendMessage(row.harness??"codex",row.sessionId,{message:row.message,origin:"automation",inputId:row.inputId!,queue:true});
      if(result.notSubmitted && result.error==="process_wait_active")return {status:"deferred",receipt:{...result}};
      if(result.admissionUnknown || result.delivery==="deferred")return {status:"unknown",receipt:{...result}};
      if(result.admitted || result.ok)return {status:"accepted",receipt:{...result}};
      return {status:result.notSubmitted?"rejected":"unknown",receipt:{...result}};
    },
  });
}
