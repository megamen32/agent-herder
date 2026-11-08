export interface NoticePlaceResumePort {
  /** Exact instance mode from protected runtime configuration; never inferred or retried. */
  deliveryMode: 'start' | 'queue';
  call(tool: 'deliver' | 'compat_task', args: Record<string, unknown>, operationKey?: string): Promise<unknown>;
}
const TASK_POLL_INTERVAL_MS=250;
const TASK_POLL_DEADLINE_MS=12_000;

export type NoticePlaceResumeResult =
  | { outcome:'accepted'; core_session_ref:string; inputId:string; native_receipt_id:string; native_receipt:Record<string,unknown> }
  | { outcome:'human_hold'; core_session_ref:string; inputId:string; code:string; effect:'none'; native_receipt:Record<string,unknown> }
  | { outcome:'not_sent'; core_session_ref:string; inputId:string; effect:'none'; code?:string; native_receipt?:Record<string,unknown> }
  | { outcome:'admission_unknown'; core_session_ref:string; inputId:string; code:'outcome_unknown'; task_ref?:string; native_receipt?:Record<string,unknown> };

function object(value:unknown):Record<string,unknown>|undefined {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function toolValue(value:unknown):Record<string,unknown> {
  const root=object(value)??{};
  return object(root.structuredContent)??root;
}

/** One exact-session resume. A task reference is only a receipt lookup key, never admission proof. */
export async function resumeNoticePlaceSession(input:{
  port:NoticePlaceResumePort;
  coreSessionRef:string;
  message:string;
  humanRequested:false;
  inputId:string;
  /** Optional deterministic timing controls for receipt tests; production defaults match the Rust runner. */
  pollIntervalMs?:number;
  pollDeadlineMs?:number;
}):Promise<NoticePlaceResumeResult> {
  const base={core_session_ref:input.coreSessionRef,inputId:input.inputId};
  if(input.humanRequested!==false) return {...base,outcome:'not_sent',effect:'none',code:'human_intent_required'};
  const deliveryMode=input.port.deliveryMode;
  if(deliveryMode!=='start'&&deliveryMode!=='queue')return {...base,outcome:'not_sent',effect:'none',code:'unsupported_mode'};
  const pollIntervalMs=input.pollIntervalMs??TASK_POLL_INTERVAL_MS;
  const pollDeadlineMs=input.pollDeadlineMs??TASK_POLL_DEADLINE_MS;
  let taskRef:string|undefined;
  let deliveryReceipt:Record<string,unknown>|undefined;
  try {
    const rawDelivery=await input.port.call('deliver',{
      action:'session',session_ref:input.coreSessionRef,message:input.message,mode:deliveryMode,request_key:input.inputId,
    },input.inputId);
    const delivered=toolValue(rawDelivery);
    const immediateReceipt=object(delivered.structuredContent)??delivered;
    deliveryReceipt=immediateReceipt;
    const immediateCode=immediateReceipt.code;
    if(immediateReceipt.effect==='none'){
      const receiptCode=typeof immediateCode==='string'?immediateCode:'adapter_refused';
      if(receiptCode==='human_stop'||receiptCode==='human_stop_active')
        return {...base,outcome:'human_hold',code:receiptCode,effect:'none',native_receipt:immediateReceipt};
      return {...base,outcome:'not_sent',effect:'none',code:receiptCode,native_receipt:immediateReceipt};
    }
    const candidate=delivered.task_ref??((delivered.native_task===true||delivered.resultType==='task')?delivered.taskId:undefined);
    if(typeof candidate==='string'&&candidate.trim()) taskRef=candidate;
  } catch { /* Once attempted, missing receipt is UNKNOWN and is never resent here. */ }
  if(!taskRef) return {...base,outcome:'admission_unknown',code:'outcome_unknown',...(deliveryReceipt?{native_receipt:deliveryReceipt}:{})};
  let latestTaskReceipt:Record<string,unknown>|undefined;
  try {
    const deadline=Date.now()+pollDeadlineMs;
    let raw:Record<string,unknown>;
    do {
      raw=toolValue(await input.port.call('compat_task',{action:'get',task_ref:taskRef}));
      const result=object(raw.result), receipt=object(result?.structuredContent);
      latestTaskReceipt=receipt??{taskId:raw.taskId,resultType:raw.resultType,status:raw.status};
      if(raw.taskId!==taskRef||raw.resultType!=='complete')
        return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,native_receipt:latestTaskReceipt};
      if(raw.status==='completed')break;
      if(raw.status!=='working'||Date.now()+pollIntervalMs>=deadline)
        return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,native_receipt:latestTaskReceipt};
      await new Promise(resolve=>setTimeout(resolve,pollIntervalMs));
    } while(Date.now()<deadline);
    const completedResult=object(raw.result), completedReceipt=object(completedResult?.structuredContent);
    const nativeReceipt=completedReceipt??latestTaskReceipt??{taskId:raw.taskId,resultType:raw.resultType,status:raw.status};
    if(raw.taskId!==taskRef||raw.resultType!=='complete'||raw.status!=='completed')
      return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,native_receipt:nativeReceipt};
    const result=completedResult, receipt=completedReceipt;
    if(!result||!receipt) return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,native_receipt:nativeReceipt};
    const prompt=object(receipt.prompt);
    const code=receipt.code??prompt?.code;
    if(code==='human_stop'||code==='human_stop_active')
      return {...base,outcome:'human_hold',code:String(code),effect:'none',native_receipt:nativeReceipt};
    if(result.isError===true&&receipt.effect==='none')
      return {...base,outcome:'not_sent',effect:'none',native_receipt:nativeReceipt,...(typeof code==='string'?{code}:{})};
    if(result.isError!==true&&receipt.outcome==='confirmed'&&typeof receipt.native_receipt_id==='string'&&receipt.native_receipt_id.trim())
      return {...base,outcome:'accepted',native_receipt_id:receipt.native_receipt_id,native_receipt:nativeReceipt};
    return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,native_receipt:nativeReceipt};
  } catch {
    return {...base,outcome:'admission_unknown',code:'outcome_unknown',task_ref:taskRef,...(latestTaskReceipt?{native_receipt:latestTaskReceipt}:{})};
  }
}
