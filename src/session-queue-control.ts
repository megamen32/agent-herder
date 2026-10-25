import {createHash} from 'node:crypto';
import {type HerderJob,type HerderJobRegistry} from './herder-jobs.js';
import type {HumanStopStore} from './human-stop-store.js';
import type {AgentSession} from './types/index.js';
import type {ZcodeQueueProcessingState,ZcodeResumeQueueOptions,ZcodeResumeQueueResult} from './adapters/zcode-v4-queue.js';

export interface SessionQueueControlTarget {hostId:string;harness:string;sessionId:string}
export interface SessionQueueControlInput extends SessionQueueControlTarget,ZcodeResumeQueueOptions {}
export interface SessionQueueControlSnapshot {
  session:Pick<AgentSession,'id'|'harness'|'hostId'|'status'|'needsPermission'>;
  /** Null means the native existing-owner capability is unavailable; never load it. */
  state:ZcodeQueueProcessingState|null;
  /** Current canonical release/business holds. Null means unknown, and is refused. */
  holds:readonly string[]|null;
}
export interface SessionQueueControlDependencies {
  /** Reuse the runtime's sole registry; this module creates no queue or registry. */
  jobs:HerderJobRegistry;
  humanStops:Pick<HumanStopStore,'anyHeld'|'withSourcesUnheld'>;
  /** Fresh, read-only exact owner snapshot. Must not load/resume a native runtime. */
  readTarget(target:SessionQueueControlTarget):Promise<SessionQueueControlSnapshot|null>;
  /** The native CAS primitive only: no sendText, session/resume, fallback or retry. */
  resume(target:SessionQueueControlTarget,options:ZcodeResumeQueueOptions):Promise<ZcodeResumeQueueResult>;
}
export interface SessionQueueControlView {
  target:SessionQueueControlTarget;
  state:ZcodeQueueProcessingState|null;
  canResume:boolean;
  humanStopHeld:boolean;
  error?:string;
}
const key=(input:SessionQueueControlInput)=>`session-queue-resume\0${JSON.stringify([input.hostId,input.harness,input.sessionId,input.inputId])}`;
export const sessionQueueControlJobId=(input:SessionQueueControlInput)=>`job_${createHash('sha256').update(key(input)).digest('hex')}`;
const targetOf=({hostId,harness,sessionId}:SessionQueueControlTarget):SessionQueueControlTarget=>({hostId,harness,sessionId});
function validateTarget(target:SessionQueueControlTarget):void {
  if(![target.hostId,target.sessionId].every(value=>typeof value==='string'&&value.trim().length>0&&value.length<=512)
    ||target.harness!=='zcode')throw Error('Требуется точный host и sessionId существующей ZCode-сессии.');
}
function identityMatches(target:SessionQueueControlTarget,snapshot:SessionQueueControlSnapshot|null):snapshot is SessionQueueControlSnapshot {
  return !!snapshot&&snapshot.session?.id===target.sessionId&&snapshot.session.harness===target.harness&&snapshot.session.hostId===target.hostId;
}
function refusal(target:SessionQueueControlTarget,snapshot:SessionQueueControlSnapshot|null):string|undefined {
  if(!identityMatches(target,snapshot))return 'Точная native сессия или её владелец изменились; очередь не возобновлялась.';
  if(!Array.isArray(snapshot.holds))return 'Состояние ограничений продолжения неизвестно; очередь не возобновлялась.';
  if(snapshot.holds.length)return 'Для сессии действует ограничение продолжения: '+snapshot.holds.join('; ');
  if(snapshot.session.needsPermission!==false||snapshot.session.status==='needs_input')return 'Сессия ожидает разрешения или ответа; сначала требуется решить этот запрос.';
  const state=snapshot.state;
  if(!state||state.loaded!==true||state.capability!=='setAutoDrain')return 'Сессия не загружена или безопасное возобновление native очереди недоступно.';
  if(!['completedSuccess','completedInterrupted','error'].includes(state.nativeState)||snapshot.session.status==='running')return 'Сессия уже выполняет работу; очередь не возобновлялась.';
  if(!Number.isSafeInteger(state.baseRevision)||state.baseRevision<0||!Number.isSafeInteger(state.pendingCount)
    ||state.pendingCount<=0||!state.oldestQueueItemId)return 'Не подтверждена точная непустая native очередь.';
}

/** Explicit user control over an already accepted native queue. The existing
 * durable HerderJob is the only action journal, including after service restart. */
export class SessionQueueControl {
  constructor(private readonly dependencies:SessionQueueControlDependencies){}

  async read(target:SessionQueueControlTarget):Promise<SessionQueueControlView>{
    validateTarget(target);const bound=targetOf(target);
    const snapshot=await this.dependencies.readTarget(bound);
    const error=refusal(bound,snapshot);
    const humanStopHeld=await this.dependencies.humanStops.anyHeld([{harness:bound.harness,sessionId:bound.sessionId}]);
    return {target:bound,state:identityMatches(bound,snapshot)?snapshot.state:null,canResume:!error&&!humanStopHeld,humanStopHeld,
      ...(humanStopHeld?{error:'Сессия явно остановлена человеком; остановка не снималась.'}:error?{error}:{})};
  }

  submit(request:SessionQueueControlInput):HerderJob<ZcodeResumeQueueResult>{
    // Freeze the exact binding before the registry persists it or starts reads.
    const input={...targetOf(request),inputId:request.inputId,expectedRevision:request.expectedRevision};
    validateTarget(input);
    if(typeof input.inputId!=='string'||!input.inputId.trim()||input.inputId.length>512
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('Требуется идентификатор действия и точная V4-ревизия очереди.');
    return this.dependencies.jobs.start({kind:'Возобновление очереди (zcode)',ownerSessionId:input.sessionId,
      idempotencyKey:key(input),requestFingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex'),durableOnce:true,
      run:({signal})=>this.execute(input,signal)});
  }

  private async execute(input:SessionQueueControlInput,signal:AbortSignal):Promise<ZcodeResumeQueueResult>{
    const target=targetOf(input);let attempted=false;
    const refused=(error:string,status:'not-submitted'|'stale-no-write'='not-submitted',state?:ZcodeQueueProcessingState):ZcodeResumeQueueResult=>
      ({ok:false,status,inputId:input.inputId,error,...(state?{state}:{})});
    try{
      const guarded=await this.dependencies.humanStops.withSourcesUnheld([{harness:target.harness,sessionId:target.sessionId}],async()=>{
        if(signal.aborted)return refused('Действие отменено до native команды.');
        const snapshot=await this.dependencies.readTarget(target);
        const error=refusal(target,snapshot);if(error)return refused(error);
        const state=snapshot!.state!;
        if(state.baseRevision!==input.expectedRevision)return refused('Очередь изменилась; обновите её состояние.','stale-no-write',state);
        if(signal.aborted)return refused('Действие отменено до native команды.');
        attempted=true;
        const result=await this.dependencies.resume(target,{inputId:input.inputId,expectedRevision:input.expectedRevision});
        if(result.inputId!==input.inputId)throw Error('Native вернул квитанцию другого действия.');
        return result;
      });
      return guarded.allowed?guarded.value:refused('Сессия явно остановлена человеком; остановка не снималась.');
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      return attempted?{ok:false,status:'unknown',inputId:input.inputId,nonRetryable:true,error:'Результат native команды неизвестен; повтор запрещён. '+message}:refused(message);
    }
  }
}
