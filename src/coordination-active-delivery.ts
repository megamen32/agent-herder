import { randomUUID } from 'node:crypto';
import { deferredMessages } from './deferred-messages.js';
import { getHumanStopStore } from './human-stop-store.js';
import type { AgentSession, ControlResult, HarnessAdapter, SendMessageOptions } from './types/index.js';

export function isCoordinationActive(session: AgentSession | null | undefined): boolean {
  return Boolean(session && session.status === 'running' && !session.needsPermission
    && session.meta?.nativeStateObserved !== false && session.meta?.nativeLoaded !== false);
}

/** Recheck after provenance/context/budget awaits; the adapter must still enforce
 * native active-only admission at dispatch. A cached status cannot provide it. */
export async function sendCurrentTurnOnly(adapter: HarnessAdapter, id: string, options: SendMessageOptions): Promise<ControlResult> {
  let current: AgentSession | null;
  try { current = await adapter.getSession(id); }
  catch { return {ok:false,notSubmitted:true,nonRetryable:true,error:'Текущая native-активность не установлена; сообщение не отправлено.'}; }
  if (!current || current.meta?.nativeStateObserved === false || current.meta?.nativeLoaded === false) return {ok:false,notSubmitted:true,nonRetryable:true,error:'Текущая native-активность не установлена; сообщение не отправлено.'};
  if (!isCoordinationActive(current)) return {ok:false,notSubmitted:true,nonRetryable:true,error:'skipped_inactive: адресат не выполняет активный ход'};
  if (!adapter.sendActiveMessage) return {ok:false,notSubmitted:true,nonRetryable:true,error:'Транспорт не поддерживает доставку строго в текущий ход; сообщение не поставлено в очередь.'};
  return adapter.sendActiveMessage(id, {...options,activeTurnOnly:true,steer:true});
}

export function skippedCoordination(session: AgentSession): string {
  if (session.meta?.nativeStateObserved === false || session.meta?.nativeLoaded === false) return JSON.stringify({ok:false,sessionId:session.id,harness:session.harness,delivery:'not_attempted',activated:false,error:'Текущая native-активность не установлена.'});
  return JSON.stringify({ok:true,sessionId:session.id,harness:session.harness,sessionStatus:session.status,delivery:'skipped_inactive',activated:false,
    nextAction:{activation:'always',instruction:'Re-send with activation=always to wake this inactive target and deliver the message, or activation=defer to park it for the next delivered turn.'}});
}

/** Previously accepted/unknown input identities are receipt-only, even after
 * the target finished or this MCP process restarted. Never infer non-admission. */
export async function previousCoordinationReceipt(adapter: HarnessAdapter, id: string, inputId?: string): Promise<string | undefined> {
  // Codex's lookup reads its durable receipt files. Some legacy transports'
  // reconciliation methods resume a session, so they cannot be used here.
  if (!inputId || !adapter.getCoordinationMessageAdmission) return undefined;
  try {
    const receipt = await adapter.getCoordinationMessageAdmission(id,inputId);
    if (receipt.state === 'admitted') return JSON.stringify({ok:true,sessionId:id,inputId,delivery:'previously_admitted',admitted:true,...(receipt.pending?{pending:true}:{}),activated:false});
    if (receipt.state === 'unknown' && receipt.error) return JSON.stringify({ok:false,sessionId:id,inputId,delivery:'admission_unknown',admissionUnknown:true,nonRetryable:true,activated:false,error:receipt.error});
  } catch { return JSON.stringify({ok:false,sessionId:id,inputId,delivery:'admission_unknown',admissionUnknown:true,nonRetryable:true,activated:false,error:'Квитанция прежней доставки недоступна; повтор не выполнен.'}); }
  return undefined;
}

/** Supported hook transport: reservation is not model-observed delivery. */
export async function reserveCurrentTurnContext(adapter:HarnessAdapter,id:string,options:SendMessageOptions):Promise<ControlResult>{
 const inputId=options.inputId||randomUUID();
 try{
  const prior=await deferredMessages.activeReceipt(adapter.type,id,inputId);
  if(prior)return prior.activeTurn?.state==='expired'?{ok:false,inputId,notSubmitted:true,nonRetryable:true,error:'Текущий ход уже завершён; прежнее сообщение не переносится.'}:{ok:true,admitted:true,pending:true,admissionKind:'current_turn_context',inputId};
  const identity=await adapter.getCoordinationActiveTurnId?.(id);
  if(!identity)return {ok:false,notSubmitted:true,nonRetryable:true,inputId,error:'skipped_inactive: точный активный native ход не установлен'};
  if(await getHumanStopStore().isHeld(adapter.type,id))return {ok:false,notSubmitted:true,nonRetryable:true,inputId,error:'Чат явно остановлен.'};
  const row=await deferredMessages.addActive(adapter.type,id,identity,inputId,options.message,options.retainedInboxIds);
  return row.activeTurn?.state==='expired'?{ok:false,inputId,notSubmitted:true,nonRetryable:true,error:'skipped_inactive: исходный ход завершён'}:{ok:true,admitted:true,pending:true,admissionKind:'current_turn_context',inputId,...(adapter.type==='zcode'?{turnId:identity}:{})};
 }catch{return {ok:false,inputId,admissionKind:'current_turn_context',admissionUnknown:true,nonRetryable:true,error:'Квитанция текущего хода недоступна; повтор запрещён.'};}
}
export async function currentTurnContextReceipt(adapter:HarnessAdapter,id:string,inputId:string){
 const row=await deferredMessages.activeReceipt(adapter.type,id,inputId);
 return row?{state:'admitted' as const,pending:true}:{state:'not_found' as const};
}
