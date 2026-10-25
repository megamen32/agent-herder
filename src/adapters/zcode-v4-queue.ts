import type { ZcodeClientLike } from './zcode-protocol.js';
import { crc32 } from 'node:zlib';

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
  const assemblies=new Map<string,{parts:Map<number,Buffer>;count:number;bytes:number;checksum:string;received:number}>();
  let waiting: {resolve:(snapshot:Snapshot)=>void;reject:(error:Error)=>void} | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = (raw: unknown) => {
    if (closed) return;
    if (!subscriptionId) { if (early.length < 64) early.push(raw); return; }
    const wire=record(raw);
    if (!waiting || wire.subscriptionId !== subscriptionId || wire.topic !== `conversation/${sessionId}`) return;
    let frame=wire;
    try {
      // Official onDynamicConversationFrame emits TopicWire v3, not the
      // logical ConversationTopicFrame. Large snapshots are CRC32 fragments.
      if(wire.kind==='complete'||wire.kind==='fragment'){
        if(wire.wireVersion!==3||typeof wire.logicalFrameId!=='string'||!wire.logicalFrameId
          ||!Number.isSafeInteger(wire.logicalFrameOrdinal)||wire.logicalFrameOrdinal<1)throw Error('Invalid V4 wire identity');
        if(wire.kind==='complete')frame=record(wire.frame);
        else {
          if(!Number.isInteger(wire.fragmentCount)||wire.fragmentCount<1||wire.fragmentCount>1024
            ||!Number.isInteger(wire.fragmentIndex)||wire.fragmentIndex<0||wire.fragmentIndex>=wire.fragmentCount
            ||!Number.isInteger(wire.logicalBytes)||wire.logicalBytes<1||wire.logicalBytes>16*1024*1024
            ||wire.checksum?.algorithm!=='crc32'||!/^[0-9a-f]{8}$/.test(wire.checksum.value)
            ||typeof wire.dataBase64!=='string'||!wire.dataBase64.length)throw Error('Invalid V4 snapshot fragment');
          const key=JSON.stringify([wire.logicalFrameId,wire.logicalFrameOrdinal]);
          let assembly=assemblies.get(key);
          if(!assembly){if(assemblies.size>=4)throw Error('Too many V4 frame assemblies');assembly={parts:new Map(),count:wire.fragmentCount,bytes:wire.logicalBytes,checksum:wire.checksum.value,received:0};assemblies.set(key,assembly);}
          if(assembly.count!==wire.fragmentCount||assembly.bytes!==wire.logicalBytes||assembly.checksum!==wire.checksum.value)throw Error('Contradictory V4 snapshot fragments');
          const part=Buffer.from(wire.dataBase64,'base64');
          if(part.toString('base64')!==wire.dataBase64)throw Error('Invalid V4 snapshot base64');
          const previous=assembly.parts.get(wire.fragmentIndex);
          if(previous&&!previous.equals(part))throw Error('Contradictory V4 duplicate fragment');
          if(!previous){assembly.parts.set(wire.fragmentIndex,part);assembly.received+=part.length;}
          if(assembly.received>assembly.bytes)throw Error('V4 snapshot exceeds declared size');
          if(assembly.parts.size!==assembly.count)return;
          const bytes=Buffer.concat(Array.from({length:assembly.count},(_,index)=>assembly!.parts.get(index)!));assemblies.delete(key);
          if(bytes.length!==assembly.bytes||crc32(bytes).toString(16).padStart(8,'0')!==assembly.checksum)throw Error('V4 snapshot checksum mismatch');
          frame=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
        }
        if(frame.topic!==wire.topic||frame.subscriptionId!==wire.subscriptionId)throw Error('V4 wire/logical ownership mismatch');
      }
    } catch(error) { const receiver=waiting;waiting=undefined;clearTimeout(timer);receiver?.reject(error instanceof Error?error:Error(String(error)));return; }
    const payload = record(frame.payload), snapshot = record(payload.snapshot);
    if(payload.kind !== 'snapshot')return;
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
    assemblies.clear();
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
