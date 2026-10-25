import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HerderJobRegistry, type HerderJob } from "./herder-jobs.js";
import type { SessionSupervisor } from "./session-supervisor.js";
import type { HarnessAdapter, SendMessageResult, MessageImage } from "./types/index.js";
import type { ZcodeRetainedInput } from "./adapters/zcode-undelivered.js";
import { MINIMAX_CLI_TIMEOUT_MS } from "./adapters/minimax-code-control.js";
import { MinimaxExecPolicyConflict, MinimaxExecPolicyStore, type MinimaxExecPolicy, type MinimaxExecPolicyMode, type MinimaxExecPolicyTarget } from "./permission-control/minimax-exec-policy.js";
import { captureDeliveryResponseBaseline, type DeliveryResponseBaseline, type DeliveryResponseTarget } from "./session-delivery-response.js";
import { HUMAN_STOP_MESSAGE } from "./human-stop-actions.js";
import { getHumanStopStore } from "./human-stop-store.js";
import { isTrustedMeshIngress, type TrustedMeshIngress } from "./mesh/authenticated-ingress.js";

export type UserMessageActor = { kind: "human" } | { kind: "agent"; principal: "agent-herder-owner-mcp"; senderAssertion: { hostId: string; harness: string; nativeSessionId: string }; senderVerified: false };
export type UserMessageInput = { harness: string; sessionId: string; inputId: string; message: string; mode: "queue" | "steer"; images?: MessageImage[] };
export type UserMessageReceipt = SendMessageResult & { delivery?: "deferred"; job?: HerderJob<SendMessageResult> };
export type UserMessageRoute = { adapter: HarnessAdapter; supervisor: Pick<SessionSupervisor, "sendMessage"> };
export type UserMessageDeliveryResponseHookInput={jobId:string;inputId:string;target:DeliveryResponseTarget;baseline:DeliveryResponseBaseline;actorKind:"human"|"agent";requestFingerprint:string};
export type UserMessageDeliveryResponseHooks={
  afterBaselinePersist?:(input:UserMessageDeliveryResponseHookInput)=>void|Promise<void>;
  afterNativeReceipt?:(input:UserMessageDeliveryResponseHookInput&{receipt:SendMessageResult})=>void|Promise<void>;
};
const messageKey=(harness:string,sessionId:string,inputId:string)=>`${harness}\0${sessionId}\0${inputId}`;
const userMessageJobId=(input:Pick<UserMessageInput,"harness"|"sessionId"|"inputId">)=>`job_${createHash("sha256").update(`user-message\0${messageKey(input.harness,input.sessionId,input.inputId)}`).digest("hex")}`;
const activeMinimaxTargets = new Map<string, number>();
const activeMinimaxJobs = new Map<string, number>();
const minimaxTargetKey = (target: MinimaxExecPolicyTarget) => createHash("sha256").update(`${target.hostId}\0${target.harness}\0${target.sessionId}`).digest("hex");
const minimaxJobKey = (target: MinimaxExecPolicyTarget, jobId: string) => `${minimaxTargetKey(target)}\0${jobId}`;
function addActiveMinimaxSend(target: MinimaxExecPolicyTarget, jobId: string): void {
  const targetKey = minimaxTargetKey(target), jobKey = minimaxJobKey(target, jobId);
  activeMinimaxTargets.set(targetKey, (activeMinimaxTargets.get(targetKey) ?? 0) + 1);
  activeMinimaxJobs.set(jobKey, (activeMinimaxJobs.get(jobKey) ?? 0) + 1);
}
function removeActiveMinimaxSend(target: MinimaxExecPolicyTarget, jobId: string): void {
  const targetKey = minimaxTargetKey(target), jobKey = minimaxJobKey(target, jobId);
  const decrement = (map: Map<string, number>, key: string) => {
    const count = map.get(key) ?? 0;
    if (count <= 1) map.delete(key); else map.set(key, count - 1);
  };
  decrement(activeMinimaxTargets, targetKey);
  decrement(activeMinimaxJobs, jobKey);
}
const messageFingerprint=(input:UserMessageInput, minimaxExecPolicy?: {mode:MinimaxExecPolicyMode;revision:number}, actor:UserMessageActor={kind:"human"},targetHostId?:string)=>{
  const base=createHash('sha256').update(`${input.mode}\0${input.message}\0${JSON.stringify(input.images??[])}`).digest('hex');
  if(actor.kind==="agent")return createHash('sha256').update(JSON.stringify({base,actor,...(minimaxExecPolicy?{minimaxExecPolicy}:{}),...(targetHostId?{targetHostId}:{})})).digest('hex');
  return minimaxExecPolicy ? createHash('sha256').update(JSON.stringify({base,minimaxExecPolicy,...(targetHostId?{targetHostId}:{})})).digest('hex') : base;
};
let durableDeliveryClaimKey=randomBytes(32);
let durableDeliveryClaimCount=0;
type DurableDeliveryClaim=NonNullable<import("./types/index.js").SendMessageOptions["durableUserDelivery"]>;
type DurableDeliveryBinding=Pick<DurableDeliveryClaim,"jobId"|"inputId"|"requestFingerprint"|"harness"|"sessionId"|"targetHostId"|"mode"|"actor"|"nonce"|"minimaxExecPolicy">;
const consumedDurableDeliveryNonces=new Set<string>();
function signDurableDeliveryClaim(binding:DurableDeliveryBinding):DurableDeliveryClaim{
  if(++durableDeliveryClaimCount>4_096){durableDeliveryClaimKey=randomBytes(32);durableDeliveryClaimCount=1;consumedDurableDeliveryNonces.clear();}
  const signature=createHmac("sha256",durableDeliveryClaimKey).update(JSON.stringify(binding)).digest("hex");
  return {...binding,signature};
}
/** The adapter can verify provenance without receiving the process-local signing key. */
export function verifyDurableUserDeliveryClaim(value:unknown,expected:Omit<DurableDeliveryBinding,"nonce"|"actor"> & {actor?:UserMessageActor},message:string,images?:MessageImage[]):value is DurableDeliveryClaim{
  if(!value||typeof value!=="object")return false;
  const claim=value as Partial<DurableDeliveryClaim>;
  const actor=expected.actor??{kind:"human" as const};
  if(claim.jobId!==expected.jobId||claim.inputId!==expected.inputId||claim.requestFingerprint!==expected.requestFingerprint
    ||claim.harness!==expected.harness||claim.sessionId!==expected.sessionId||claim.mode!==expected.mode
    ||JSON.stringify(claim.actor)!==JSON.stringify(actor)
    ||typeof claim.nonce!=="string"||!/^[a-f0-9]{32}$/.test(claim.nonce)||consumedDurableDeliveryNonces.has(claim.nonce)
    ||typeof claim.signature!=="string"||!/^[a-f0-9]{64}$/.test(claim.signature))return false;
  const actualFingerprint=messageFingerprint({harness:expected.harness,sessionId:expected.sessionId,inputId:expected.inputId,message,mode:expected.mode,images},expected.minimaxExecPolicy,actor,expected.targetHostId);
  if(actualFingerprint!==expected.requestFingerprint)return false;
  const binding={jobId:expected.jobId,inputId:expected.inputId,requestFingerprint:expected.requestFingerprint,harness:expected.harness,sessionId:expected.sessionId,
    ...(expected.targetHostId?{targetHostId:expected.targetHostId}:{}),mode:expected.mode,actor,
    ...(expected.minimaxExecPolicy?{minimaxExecPolicy:expected.minimaxExecPolicy}:{}),nonce:claim.nonce};
  const actual=Buffer.from(claim.signature,"hex"),want=Buffer.from(createHmac("sha256",durableDeliveryClaimKey).update(JSON.stringify(binding)).digest("hex"),"hex");
  if(actual.length!==want.length||!timingSafeEqual(actual,want))return false;
  consumedDurableDeliveryNonces.add(claim.nonce);
  return true;
}

/** Process-owned human queue. Coordination continues through its native steer path. */
export class UserMessageDelivery {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<AbortController, { harness: string; sessionId: string }>();
  private active = 0;
  private slots = 4;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly editableMessages=new Map<string,{input:UserMessageInput;jobId:string;controller:AbortController;attempted:boolean;actor:UserMessageActor;targetHostId?:string;minimaxExecPolicy?:{mode:MinimaxExecPolicyMode;revision:number}}>();
  private readonly minimaxExecPolicies: MinimaxExecPolicyStore;
  private responseHooks?:UserMessageDeliveryResponseHooks;

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly supervisor: Pick<SessionSupervisor, "sendMessage">,
    private readonly jobs: HerderJobRegistry,
    private readonly options = { pollMs: 2_000, maxWaitMs: 24 * 60 * 60 * 1_000, maxPending: 64 },
    minimaxExecPolicies = new MinimaxExecPolicyStore(),
    responseHooks?:UserMessageDeliveryResponseHooks,
  ) { this.minimaxExecPolicies = minimaxExecPolicies; this.responseHooks=responseHooks; }

  setResponseObserverHooks(hooks:UserMessageDeliveryResponseHooks):void{this.responseHooks=hooks;}

  async readDeliveryResponseBaseline(jobId:string,inputId:string,target:DeliveryResponseTarget):Promise<DeliveryResponseBaseline>{
    if(jobId!==userMessageJobId({harness:target.harness,sessionId:target.sessionId,inputId}))throw new Error("delivery_response_job_target_mismatch");
    const job=this.jobs.get<SendMessageResult>(jobId);
    if(!job||job.ownerSessionId!==target.sessionId)throw new Error("delivery_response_job_unavailable");
    const adapter=this.adapters.get(target.harness);
    const session=await adapter?.getSession?.(target.sessionId).catch(()=>null);
    if(!session||session.id!==target.sessionId||session.harness!==target.harness||session.hostId!==target.hostId)throw new Error("delivery_response_native_target_mismatch");
    return this.jobs.readDeliveryResponseBaseline(jobId,{inputId,target});
  }

  async getMinimaxExecPolicy(target: MinimaxExecPolicyTarget): Promise<MinimaxExecPolicy> {
    return this.minimaxExecPolicies.withSnapshot(target, policy => policy);
  }

  async setMinimaxExecPolicy(target: MinimaxExecPolicyTarget, expectedRevision: number, mode: MinimaxExecPolicyMode): Promise<MinimaxExecPolicy> {
    return this.minimaxExecPolicies.update(
      target,
      expectedRevision,
      mode,
      async (_current, activeJobIds) => this.reconcileMinimaxAdmissions(target, activeJobIds),
      () => {
        if (this.hasActiveMinimaxJob(target)) {
          throw new MinimaxExecPolicyConflict("A MiniMax Herder delivery is already admitted for this session; wait for its terminal receipt before changing policy.");
        }
      },
    );
  }

  async submitMinimaxExecPolicy(input: UserMessageInput, route?: UserMessageRoute): Promise<UserMessageReceipt> {
    return this.submitMinimaxForActor(input,{kind:"human"},route);
  }

  /** Agent-to-agent MiniMax queueing uses the same durable job and native claim as the human queue.
   * The asserted sender is bound for attribution/idempotency and never changes human-stop or consent rules. */
  async submitMinimaxAgent(input: UserMessageInput, senderAssertion: { hostId: string; harness: string; nativeSessionId: string }, ingress: TrustedMeshIngress | undefined, route?: UserMessageRoute): Promise<UserMessageReceipt> {
    if (!isTrustedMeshIngress(ingress)) throw new Error("Authenticated Agent Herder MCP ingress is required for MiniMax agent delivery.");
    const actor:UserMessageActor={kind:"agent",principal:ingress.principal,senderAssertion,senderVerified:ingress.senderVerified};
    return this.submitMinimaxForActor(input,actor,route);
  }

  private async submitMinimaxForActor(input: UserMessageInput, actor: UserMessageActor, route?: UserMessageRoute): Promise<UserMessageReceipt> {
    if (input.harness !== "minimax-code") throw new Error("MiniMax execution policy is available only for MiniMax Code sessions.");
    const adapter = route?.adapter ?? this.adapters.get(input.harness);
    if (!adapter?.getSession) throw new Error("The exact MiniMax native session is unavailable.");
    const initial = await adapter.getSession(input.sessionId);
    if (!initial || initial.id !== input.sessionId || initial.harness !== "minimax-code" || !initial.hostId) {
      throw new Error("The exact MiniMax host and session could not be confirmed.");
    }
    const target: MinimaxExecPolicyTarget = { hostId: initial.hostId, harness: "minimax-code", sessionId: initial.id };
    return this.minimaxExecPolicies.withSnapshot(target, async (policy, reserve) => {
      const fresh = await adapter.getSession!(input.sessionId);
      if (!fresh || fresh.id !== target.sessionId || fresh.hostId !== target.hostId || fresh.harness !== target.harness) {
        throw new Error("The MiniMax session identity changed before durable admission.");
      }
      const jobId = userMessageJobId(input);
      const existing = this.jobs.get<SendMessageResult>(jobId);
      if (existing) return this.submitPrepared(input, route, { mode: policy.mode, revision: policy.revision }, undefined, actor, target.hostId);
      await reserve(jobId);
      addActiveMinimaxSend(target, jobId);
      try { return this.submitPrepared(input, route, { mode: policy.mode, revision: policy.revision }, { target, jobId }, actor, target.hostId); }
      catch (error) {
        removeActiveMinimaxSend(target, jobId);
        await this.minimaxExecPolicies.releaseAdmission(target, jobId).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Explicit maintenance capture, never a planner or an automatic restart job. */
  checkpointZcodeInput(sessionId: string, inputId: string, cwd: string): { jobId: string; fingerprint: string } {
    const adapter = this.retainedZcodeAdapter();
    if (!adapter.captureRetainedInput) throw new Error("Адаптер не поддерживает точное сохранение принятого ввода");
    return this.jobs.retainZcodeInput(adapter.captureRetainedInput(sessionId, inputId, cwd));
  }

  /** One logical retry, after native definitively discarded the original.
   * Origin/context handling deliberately stays out of the human composer and
   * supervisor injection/deferred fallback. Adapter keeps native/Stop fences. */
  async retryZcodeInput(jobId: string): Promise<SendMessageResult> {
    const stored = this.jobs.readZcodeInput(jobId), adapter = this.retainedZcodeAdapter();
    if (stored.attempt) return this.reconcileZcodeInput(jobId);
    if (!adapter.canRetryRetainedInput?.(stored.capture)) return { ok: false, nonRetryable: true, notSubmitted: true,
      inputId: stored.capture.logicalInputId, error: "Отсутствие исполнения исходного ввода не доказано; повтор запрещён" };
    if (!adapter.retryRetainedInput) throw new Error("Восстановление сохранённого ввода недоступно");
    // Synchronous strict reservation precedes every await/native dispatch.
    const attemptId = this.jobs.reserveZcodeInputAttempt(jobId);
    let result: SendMessageResult;
    try { result = await adapter.retryRetainedInput(stored.capture, attemptId); }
    catch { result = { ok: false, admissionUnknown: true, nonRetryable: true, inputId: attemptId, error: "Квитанция попытки недоступна; повторная отправка запрещена" }; }
    this.jobs.recordZcodeInputAttempt(jobId, attemptId, result);
    return { ...result, inputId: stored.capture.logicalInputId };
  }

  async reconcileZcodeInput(jobId: string): Promise<SendMessageResult> {
    const stored = this.jobs.readZcodeInput(jobId);
    if (!stored.attempt) return { ok: false, notSubmitted: true, inputId: stored.capture.logicalInputId, error: "Попытка ещё не зарезервирована" };
    const adapter = this.retainedZcodeAdapter();
    const receipt = adapter.getRetainedInputAttempt?.(stored.capture, stored.attempt.inputId) ?? { state: "unknown" as const };
    const result: SendMessageResult = receipt.state === "admitted"
      ? { ok: true, admitted: true, pending: receipt.pending === true, inputId: stored.attempt.inputId }
      : { ok: false, nonRetryable: true, ...(receipt.state === "unknown" ? { admissionUnknown: true } : { admitted: true }),
        inputId: stored.attempt.inputId, error: receipt.state === "failed" ? "Попытка завершена нативным отказом; новая отправка запрещена" : "Квитанция попытки не установлена; повтор запрещён" };
    this.jobs.recordZcodeInputAttempt(jobId, stored.attempt.inputId, result);
    return { ...result, inputId: stored.capture.logicalInputId };
  }

  private retainedZcodeAdapter(): HarnessAdapter & {
    captureRetainedInput?(sessionId: string, inputId: string, cwd: string): ZcodeRetainedInput;
    canRetryRetainedInput?(input: ZcodeRetainedInput): boolean;
    retryRetainedInput?(input: ZcodeRetainedInput, attemptId: string): Promise<SendMessageResult>;
    getRetainedInputAttempt?(input: ZcodeRetainedInput, attemptId: string): { state: "admitted" | "failed" | "unknown"; pending?: boolean };
  } {
    const adapter = this.adapters.get("zcode");
    if (!adapter) throw new Error("Native ZCode адаптер недоступен");
    return adapter;
  }

  submit(input: UserMessageInput, route?: UserMessageRoute): UserMessageReceipt {
    return this.submitPrepared(input, route, undefined, undefined, {kind:"human"});
  }

  private submitPrepared(input: UserMessageInput, route?: UserMessageRoute, minimaxExecPolicy?: { mode: MinimaxExecPolicyMode; revision: number }, admissionReservation?: { target: MinimaxExecPolicyTarget; jobId: string }, actor:UserMessageActor={kind:"human"},targetHostId?:string): UserMessageReceipt {
    input={...input,images:input.images?.map(image=>({...image}))};
    if (Buffer.byteLength(input.message, "utf8") > 256 * 1024) throw new Error("Сообщение слишком большое для очереди отправки");
    const targetAdapter = route?.adapter ?? this.adapters.get(input.harness);
    if (input.mode === "steer" && input.harness !== "codex" && targetAdapter?.controlCapabilities?.steer !== true) {
      throw new Error("Вставка в текущий ход для этого агента пока не поддерживается. Выберите «После ответа».");
    }
    if (!targetAdapter) throw new Error("Агент недоступен");
    const key = messageKey(input.harness,input.sessionId,input.inputId);
    const legacyFingerprint = messageFingerprint(input);
    const fingerprint = messageFingerprint(input, minimaxExecPolicy, actor,targetHostId);
    const humanRequestedAt = actor.kind==="human"?Date.now():undefined;
    const jobId = userMessageJobId(input);
    const existing = this.jobs.get<SendMessageResult>(jobId);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint && !(minimaxExecPolicy && existing.requestFingerprint === legacyFingerprint)) throw new Error("Идентификатор сообщения уже использован для другого текста, режима или политики исполнения");
      return this.receipt(existing, input.inputId);
    }
    if (this.active >= this.options.maxPending) throw new Error("Очередь отправки заполнена. Дождитесь доставки текущих сообщений.");
    const lane = `${input.harness}\0${input.sessionId}`;
    const previous = input.mode === "queue" ? this.tails.get(lane) : undefined;
    const controller = new AbortController();
    const editable={input,jobId,controller,attempted:false,actor,targetHostId,minimaxExecPolicy};
    this.editableMessages.set(key,editable);
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { release = resolve; });
    const tail = (previous ?? Promise.resolve()).then(() => admitted);
    // Reserve the lane before the job runner begins; native callers never block on it.
    if (input.mode === "queue") this.tails.set(lane, tail);
    this.active++;
    this.controllers.set(controller, { harness: input.harness, sessionId: input.sessionId });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
      controller.abort();
      this.active--;
      this.controllers.delete(controller);
      this.editableMessages.delete(key);
      if (this.tails.get(lane) === tail) this.tails.delete(lane);
      if (admissionReservation) {
        removeActiveMinimaxSend(admissionReservation.target, admissionReservation.jobId);
        void this.minimaxExecPolicies.releaseAdmission(admissionReservation.target, admissionReservation.jobId).catch(() => undefined);
      }
    };
    let job: HerderJob<SendMessageResult>;
    try {
      job = this.jobs.start({
        kind: input.harness === "minimax-code" ? `Доставка сообщения (minimax-code${actor.kind==="agent"?"/agent":""})` : "Доставка сообщения", ownerSessionId: input.sessionId,
        idempotencyKey: `user-message\0${key}`, requestFingerprint: fingerprint,
        durableOnce: true,
        run: async ({ signal, waiting, progress }) => {
          const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(this.options.maxWaitMs)]);
          let attempted = false;
          let nativeSend: Promise<SendMessageResult> | undefined;
          let responseContext:UserMessageDeliveryResponseHookInput|undefined;
          try {
            waiting(input.mode === "queue" ? "Ожидает окончания ответа" : "Вставляется в текущий ход");
            if (previous) await Promise.race([previous, delay(this.options.maxWaitMs, undefined, { signal: combined })]);
            const adapter = targetAdapter;
            while (true) {
              combined.throwIfAborted();
              const session = await this.withSlot(combined, () => adapter.getSession(input.sessionId));
              if (!session) return { ok: false, nonRetryable: true, inputId: input.inputId, error: "Сессия недоступна" };
              if (input.mode === "queue" && (session.status === "running" || session.status === "needs_input")) {
                await delay(this.options.pollMs, undefined, { signal: combined });
                continue;
              }
              combined.throwIfAborted();
              progress(0.45,"Проверяется история перед отправкой");
              const exactTargetHostId=admissionReservation?.target.hostId??targetHostId??session.hostId;
              const boundTargetHostId=admissionReservation?.target.hostId??targetHostId;
              const currentFingerprint=messageFingerprint(input,minimaxExecPolicy,actor,boundTargetHostId);
              if(exactTargetHostId){
                const target:DeliveryResponseTarget={hostId:exactTargetHostId,harness:input.harness as DeliveryResponseTarget["harness"],sessionId:input.sessionId};
                const baseline=await this.withSlot(combined,()=>captureDeliveryResponseBaseline({jobId,inputId:input.inputId,target,readMessages:async(requested,limit)=>{
                  if(requested.hostId!==target.hostId||requested.harness!==target.harness||requested.sessionId!==target.sessionId||!adapter.getSessionMessages)return {messages:null};
                  const messages=await adapter.getSessionMessages(requested.sessionId,limit);
                  return {messages,complete:false};
                }}));
                this.jobs.recordDeliveryResponseBaseline(jobId,baseline);
                responseContext={jobId,inputId:input.inputId,target,baseline,actorKind:actor.kind,requestFingerprint:currentFingerprint};
                try{void Promise.resolve(this.responseHooks?.afterBaselinePersist?.(responseContext)).catch(()=>undefined);}catch{/* observer setup cannot change native admission */}
              }
              progress(0.5, "Отправляется агенту");
              editable.attempted=true;
              attempted = true;
              const supervisor = route?.supervisor ?? this.supervisor;
              // The MiniMax CLI returns its exact native turn receipt after the
              // model completes. Give that operation its own full CLI deadline
              // plus a small result-delivery grace; the generic 30s bound is
              // still used for metadata reads and the other harnesses.
              const sendObservationTimeoutMs = input.harness === "minimax-code"
                ? MINIMAX_CLI_TIMEOUT_MS + 5_000
                : 30_000;
              const result = await this.withSlot(combined, async () => {
                // Queue/slot/baseline waits can outlive a manual stop. Re-read
                // the exact target and durable stop fence immediately before
                // the one native dispatch; an agent claim never clears it.
                if (actor.kind === "agent") {
                  const dispatchSession = await adapter.getSession(input.sessionId);
                  if (!dispatchSession || dispatchSession.id !== input.sessionId || dispatchSession.harness !== input.harness
                    || (boundTargetHostId && dispatchSession.hostId !== boundTargetHostId)) {
                    return { ok: false, notSubmitted: true, nonRetryable: true, inputId: input.inputId, error: "Точная целевая сессия изменилась перед отправкой" };
                  }
                  const humanStopStore = getHumanStopStore();
                  await humanStopStore.observe(dispatchSession);
                  if (await humanStopStore.isHeld(input.harness, input.sessionId)) {
                    return { ok: false, notSubmitted: true, nonRetryable: true, inputId: input.inputId, error: HUMAN_STOP_MESSAGE };
                  }
                }
                nativeSend = supervisor.sendMessage(input.harness, input.sessionId, {
                  message: input.message, origin: actor.kind==="human"?"human":"automation", inputId: input.inputId, images: input.images,
                  ...(humanRequestedAt!==undefined?{humanRequestedAt}:{}),
                  steer: input.mode === "steer", queue: ["codex", "opencode", "zcode"].includes(input.harness),
                  durableUserDelivery: signDurableDeliveryClaim({ jobId, inputId: input.inputId, requestFingerprint: currentFingerprint,
                    harness: input.harness, sessionId: input.sessionId, ...(boundTargetHostId?{targetHostId:boundTargetHostId}:{}), mode: input.mode,
                    actor,
                    ...(minimaxExecPolicy ? { minimaxExecPolicy } : {}), nonce: randomBytes(16).toString("hex") }),
                });
                return nativeSend;
              }, sendObservationTimeoutMs);
              if(responseContext){try{void Promise.resolve(this.responseHooks?.afterNativeReceipt?.({...responseContext,receipt:result})).catch(()=>undefined);}catch{/* observer notification cannot change a native receipt */}}
              // A writer rejected admission before input submission. Recheck the
              // native turn; uncertain/accepted input is never replayed.
              if (input.mode === "queue" && !result.ok && !result.nonRetryable && !result.admitted && !result.admissionUnknown
                && /already has an active writer|prompt is already running/i.test(result.error ?? "")) {
                waiting("Ожидает окончания ответа");
                attempted = false;
                await delay(this.options.pollMs, undefined, { signal: combined });
                continue;
              }
              if (result.ok && !result.admitted && !result.turnId && adapter.getMessageAdmission) {
                const native = await this.withSlot(combined, () => adapter.getMessageAdmission!(input.sessionId, input.inputId, session.cwd));
                if (native.state === "admitted") return { ...result, inputId: input.inputId, admitted: true };
                if (native.state === "failed") return { ok: false, admitted: true, nonRetryable: true, inputId: input.inputId, error: native.error };
                return { ...result, inputId: input.inputId, pending: true };
              }
              return { ...result, inputId: input.inputId };
            }
          } catch (error) {
            const failure:SendMessageResult={ ok: false, inputId: input.inputId, nonRetryable: true, ...(attempted ? { admissionUnknown: true } : { notSubmitted: true }),
              error: error instanceof Error && error.name === "TimeoutError" ? "Время ожидания доставки истекло" : error instanceof Error ? error.message : String(error) };
            if(attempted&&typeof responseContext!=="undefined"){try{void Promise.resolve(this.responseHooks?.afterNativeReceipt?.({...responseContext,receipt:failure})).catch(()=>undefined);}catch{/* observer notification cannot change admission */}}
            return failure;
          } finally {
            if (nativeSend) void nativeSend.then(finish, finish);
            else finish();
          }
        },
      });
    } catch (error) {
      if (input.mode === "queue" && this.tails.get(lane) === tail && previous) this.tails.set(lane, previous);
      finish();
      throw error;
    }
    return this.receipt(job, input.inputId);
  }

  private hasActiveMinimaxJob(target: MinimaxExecPolicyTarget): boolean {
    const activeStates = new Set(["queued", "running", "waiting", "cancelling"]);
    return (activeMinimaxTargets.get(minimaxTargetKey(target)) ?? 0) > 0
      || [...this.controllers.values()].some((entry) => entry.harness === target.harness && entry.sessionId === target.sessionId)
      || this.jobs.list(500).some((job) => job.ownerSessionId === target.sessionId && job.kind === "Доставка сообщения (minimax-code)" && activeStates.has(job.state));
  }

  private async reconcileMinimaxAdmissions(target: MinimaxExecPolicyTarget, jobIds: readonly string[]): Promise<readonly string[]> {
    const activeStates = new Set(["queued", "running", "waiting", "cancelling"]);
    if ((activeMinimaxTargets.get(minimaxTargetKey(target)) ?? 0) > 0
      || jobIds.some((jobId) => (activeMinimaxJobs.get(minimaxJobKey(target, jobId)) ?? 0) > 0)
      || [...this.controllers.values()].some((entry) => entry.harness === target.harness && entry.sessionId === target.sessionId)) {
      throw new MinimaxExecPolicyConflict("A MiniMax native send is still in flight; policy was not changed.");
    }
    for (const jobId of jobIds) {
      const job = this.jobs.get(jobId);
      if (job && activeStates.has(job.state)) {
        throw new MinimaxExecPolicyConflict("A MiniMax Herder job is still active; policy was not changed.");
      }
    }
    const adapter = this.adapters.get("minimax-code") as (HarnessAdapter & {
      getNativeIdleAdmissionProof?(target: MinimaxExecPolicyTarget): Promise<{ hostId: string; harness: string; sessionId: string; idle: boolean; reason?: string }>;
    }) | undefined;
    if (!adapter?.getNativeIdleAdmissionProof) {
      throw new MinimaxExecPolicyConflict("Native MiniMax lease state is unavailable; stale delivery reservation remains locked.");
    }
    let proof: Awaited<ReturnType<NonNullable<typeof adapter.getNativeIdleAdmissionProof>>>;
    try { proof = await adapter.getNativeIdleAdmissionProof(target); }
    catch { throw new MinimaxExecPolicyConflict("Could not read exact MiniMax lease state; stale delivery reservation remains locked."); }
    if (proof.hostId !== target.hostId || proof.harness !== target.harness || proof.sessionId !== target.sessionId || proof.idle !== true) {
      throw new MinimaxExecPolicyConflict(proof.reason || "MiniMax session is active or its exact native idle state is unknown; policy was not changed.");
    }
    return jobIds;
  }

  queuedMessage(harness:string,sessionId:string,inputId:string){
    const queued=this.editableMessages.get(messageKey(harness,sessionId,inputId));
    const job=queued&&this.jobs.get(queued.jobId);
    if(!queued||!job)throw new Error('Сообщение уже передано или очередь недоступна; проверьте доставку');
    return {inputId,message:queued.input.message,jobId:job.id,createdAt:job.createdAt,
      editable:queued.input.mode==='queue'&&!queued.attempted&&!queued.controller.signal.aborted&&['queued','waiting'].includes(job.state)};
  }

  editQueuedMessage(harness:string,sessionId:string,inputId:string,expectedMessage:string,message:string){
    const queued=this.editableMessages.get(messageKey(harness,sessionId,inputId));
    const current=this.queuedMessage(harness,sessionId,inputId);
    if(!queued||!current.editable)throw new Error('Сообщение уже передаётся агенту; изменить его нельзя');
    if(!message.trim()||Buffer.byteLength(message,'utf8')>256*1024)throw new Error('Нужен непустой текст не больше256КиБ');
    if(current.message!==expectedMessage)throw new Error('Текст сообщения уже изменён; обновите очередь');
    this.jobs.replaceWaitingFingerprint(queued.jobId,messageFingerprint(queued.input,queued.minimaxExecPolicy,queued.actor,queued.targetHostId),messageFingerprint({...queued.input,message},queued.minimaxExecPolicy,queued.actor,queued.targetHostId));
    queued.input.message=message;
    return this.queuedMessage(harness,sessionId,inputId);
  }

  private receipt(job: HerderJob<SendMessageResult>, inputId: string): UserMessageReceipt {
    if (["failed", "cancelled", "interrupted"].includes(job.state)) {
      return { ok: false, inputId, nonRetryable: true, admissionUnknown: true,
        error: job.error || "Доставка прервана; проверьте состояние сообщения перед повторной отправкой", job };
    }
    return job.state === "completed" && job.result
      ? { ...job.result, inputId, job }
      : { ok: true, inputId, pending: true, delivery: "deferred", job };
  }

  get(harness: string, sessionId: string, inputId: string): UserMessageReceipt | null {
    const key = `user-message\0${harness}\0${sessionId}\0${inputId}`;
    const job = this.jobs.get<SendMessageResult>(`job_${createHash("sha256").update(key).digest("hex")}`);
    return job ? this.receipt(job, inputId) : null;
  }

  async reconcile(harness: string, sessionId: string, inputId: string, routedAdapter?: HarnessAdapter): Promise<UserMessageReceipt | null> {
    const receipt = this.get(harness, sessionId, inputId);
    const job = receipt?.job;
    if (!job || job.state !== "completed" || !job.result?.pending || job.result.admissionUnknown) return receipt;
    const adapter = routedAdapter ?? this.adapters.get(harness);
    if (adapter?.getMessageAdmission) {
      const native = await this.withSlot(AbortSignal.timeout(30_000), () => adapter.getMessageAdmission!(sessionId, inputId));
      if (native.state === "admitted" || native.state === "failed") {
        this.jobs.updateCompletedResult(job.id, { ...job.result, pending: false, admitted: true,
          ...(native.state === "failed" ? { ok: false, nonRetryable: true, error: native.error } : {}) });
        return this.get(harness, sessionId, inputId);
      }
    }
    if (Date.now() - Date.parse(job.createdAt) >= this.options.maxWaitMs) {
      this.jobs.updateCompletedResult(job.id, { ok: false, inputId, pending: false, admissionUnknown: true, nonRetryable: true,
        error: "Не удалось подтвердить доставку сообщения; проверьте чат перед повторной отправкой" });
      return this.get(harness, sessionId, inputId);
    }
    return receipt;
  }

  private async withSlot<T>(signal: AbortSignal, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    signal.throwIfAborted();
    if (this.slots > 0) this.slots--;
    else await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener("abort", cancel); resolve(); };
      const cancel = () => {
        const index = this.slotWaiters.indexOf(grant);
        if (index !== -1) this.slotWaiters.splice(index, 1);
        reject(signal.reason);
      };
      this.slotWaiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
    const release = () => {
      const next = this.slotWaiters.shift();
      if (next) next(); else this.slots++;
    };
    try { signal.throwIfAborted(); }
    catch (error) { release(); throw error; }
    // A deadline abandons observation, never the native operation. Retain its
    // slot until it settles so unavailable transports cannot spawn more reads
    // or duplicate a possibly admitted prompt after the caller times out.
    const pending = Promise.resolve().then(operation).finally(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Native operation observation timed out");
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, deadline, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    for (const controller of this.controllers.keys()) controller.abort(new Error("Отправка прервана остановкой сервера; состояние сообщения нужно проверить"));
  }

  cancelSession(harness: string, sessionId: string): void {
    for (const [controller, target] of this.controllers) {
      if (target.harness === harness && target.sessionId === sessionId) controller.abort(new Error("Вы остановили чат; ожидавшее сообщение не будет отправлено автоматически"));
    }
  }
}
