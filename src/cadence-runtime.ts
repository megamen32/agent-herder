import type { HarnessAdapter, SendMessageResult } from "./types/index.js";
import { CadenceScheduler } from "./cadence-scheduler.js";
interface Supervisor {
  isAutomationHeld(harness:string,id:string):Promise<boolean>;
  sendMessage(harness:string,id:string,options:{message:string;origin:"automation";inputId:string;queue:boolean}):Promise<SendMessageResult & {delivery?:string}>;
}
export function createCadenceRuntime(adapters:Map<string,HarnessAdapter>,supervisor:Supervisor,path:string):CadenceScheduler {
  return new CadenceScheduler({path,
    inspect:async id=>{
      try {
      if(await supervisor.isAutomationHeld("codex",id))return "held";
      const session=await adapters.get("codex")?.getSession(id);
      if(!session || session.meta?.nativeTurnStateUnavailable===true || session.meta?.nativeStateObserved===false)return "unavailable";
      if(await supervisor.isAutomationHeld("codex",id))return "held";
      if(session.status==="running" || session.status==="needs_input" || session.needsPermission || session.meta?.activeTurnId || session.meta?.nativeActiveTurnId)return "busy";
      // CLI index describes quiescent sessions as stopped; explicit stops are
      // independently fenced by isAutomationHeld/adapter native stop evidence.
      return session.status==="idle" || session.status==="stopped"?"idle":"unavailable";
      } catch { return "unavailable"; }
    },
    deliver:async row=>{
      const result=await supervisor.sendMessage("codex",row.sessionId,{message:row.message,origin:"automation",inputId:row.inputId!,queue:true});
      if(result.admissionUnknown || result.delivery==="deferred")return {status:"unknown",receipt:{...result}};
      if(result.admitted || result.ok)return {status:"accepted",receipt:{...result}};
      return {status:result.notSubmitted?"rejected":"unknown",receipt:{...result}};
    },
  });
}
