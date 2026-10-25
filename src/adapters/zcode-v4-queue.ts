import type { ZcodeClientLike } from './zcode-protocol.js';

export interface ZcodeQueueProcessingState {
  autoDrain: boolean;
  baseRevision: number;
  pendingCount: number;
  oldestQueueItemId: string | null;
  nativeState: string;
  loaded: true;
  capability: 'setAutoDrain';
}
export interface ZcodeResumeQueueOptions { inputId: string; expectedRevision: number }
export interface ZcodeResumeQueueResult {
  ok: boolean;
  status: 'accepted' | 'stale-no-write' | 'unknown' | 'not-submitted';
  inputId: string;
  state?: ZcodeQueueProcessingState;
  error?: string;
  nonRetryable?: boolean;
}
type Snapshot = { sessionId: string; revision: number; logEpoch: string; seq: number;
  control: { phase: string }; queue: { autoDrain: boolean; items: Array<{queueItemId: string}> } };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};

export function queueProcessingState(snapshot: Snapshot): ZcodeQueueProcessingState {
  return {autoDrain:snapshot.queue.autoDrain,baseRevision:snapshot.revision,pendingCount:snapshot.queue.items.length,
    oldestQueueItemId:snapshot.queue.items[0]?.queueItemId ?? null,nativeState:snapshot.control.phase,loaded:true,capability:'setAutoDrain'};
}

/** One owned official subscription. A legacy runtime.stateRevision is never a V4 revision.
 * Callers must first prove that this exact session is already loaded. */
export async function openZcodeQueueSnapshot(client: ZcodeClientLike, workspace: Record<string, unknown>, sessionId: string, timeoutMs = 5000) {
  if (!client.callIfReady || !client.listen) throw new Error('Existing V4 transport is unavailable');
  const call = (method: string, extra: Record<string, unknown> = {}) => client.callIfReady!('zcode-agent',method,[{...workspace,sessionId,runtimePolicy:'existing-only',...extra}]);
  let subscriptionId: string | undefined, closed = false;
  const early: unknown[] = [];
  let waiting: {resolve:(snapshot:Snapshot)=>void;reject:(error:Error)=>void} | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = (raw: unknown) => {
    if (closed) return;
    if (!subscriptionId) { if (early.length < 64) early.push(raw); return; }
    const frame = record(raw), payload = record(frame.payload), snapshot = record(payload.snapshot);
    if (!waiting || frame.subscriptionId !== subscriptionId || frame.topic !== `conversation/${sessionId}` || payload.kind !== 'snapshot') return;
    if (snapshot.sessionId !== sessionId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || typeof snapshot.logEpoch !== 'string' || !snapshot.logEpoch || snapshot.seq !== frame.toSeq
      || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || frame.fromSeq !== 0
      || typeof snapshot.queue?.autoDrain !== 'boolean' || !Array.isArray(snapshot.queue.items)
      || snapshot.queue.items.some((item: any) => typeof item?.queueItemId !== 'string' || !item.queueItemId)
      || typeof snapshot.control?.phase !== 'string') {
      waiting.reject(new Error('Invalid exact V4 queue snapshot')); return;
    }
    const receiver=waiting; waiting=undefined; clearTimeout(timer); receiver.resolve(snapshot as Snapshot);
  };
  const next = () => new Promise<Snapshot>((resolve,reject) => {
    waiting={resolve,reject}; timer=setTimeout(()=>{waiting=undefined;reject(new Error('V4 queue snapshot timed out'));},timeoutMs);
  });
  const unlisten = client.listen('zcode-agent','onDynamicConversationFrame',workspace,accept);
  const close = async () => {
    closed=true; clearTimeout(timer); unlisten();
    if (subscriptionId) await call('unsubscribeConversationV4',{subscriptionId}).catch(()=>undefined);
  };
  try {
    const initial=next(); initial.catch(()=>undefined);
    const result=record(await call('subscribeConversationV4',{visibility:'background'}));
    subscriptionId=record(result.ack).subscriptionId;
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw new Error('Missing V4 subscription identity');
    for(const frame of early.splice(0)) accept(frame);
    const snapshot=await initial;
    return {snapshot,call,close,async fresh() {
      const fresh=next(); fresh.catch(()=>undefined);
      await call('resyncConversationV4',{subscriptionId,base:null,forceSnapshot:true});
      return fresh;
    }};
  } catch(error) { await close(); throw error; }
}
