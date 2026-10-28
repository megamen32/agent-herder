import { createHash } from "node:crypto";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../types/index.js";
import { safeVisibleText, withPermissionQuestionCreationLock, type PermissionNoticeObserverDependencies } from "../permission-control/notice-bridge.js";
import { loadAskHumanProducerForTarget } from "./ask-human-producer.js";
import { buildAskHumanRequest, deliverNoticeQuestion } from "./notice-question.js";
import { nativeTarget, type HumanQuestionBinding } from "./question-binding.js";
import { readCanonicalNativeUserAnswer } from "./native-user-input-notice.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

const PREFIX = "agent-herder:async-question:v1:";
export type AsyncUserInputTarget = { hostId: string; harness: string; sessionId: string; turnId: string; itemId: string; questionIndex: number; fingerprint: string };
type Question = { title: string; options: string[] | null };
type AsyncState = { target: { hostId: string; harness: string; sessionId: string }; turnId: string; itemId: string; canRespond: boolean; questions: Question[] };
type InputAdapter = HarnessAdapter & { readAsyncUserInputState?: (id: string) => Promise<AsyncState | null> };
const fingerprint = (questions: Question[]) => createHash("sha256").update(JSON.stringify(questions)).digest("hex");

export function hasAsyncUserInputContextRef(value?: string): boolean { return value?.startsWith(PREFIX) ?? false; }
export function asyncUserInputContextRef(target: AsyncUserInputTarget): string {
  const strings = [target.hostId, target.harness, target.sessionId, target.turnId, target.itemId];
  if (strings.some(value => typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f]/.test(value))
    || !Number.isSafeInteger(target.questionIndex) || target.questionIndex < 0 || !/^[a-f0-9]{64}$/.test(target.fingerprint)) throw new Error("invalid async question target");
  const ref = PREFIX + Buffer.from(JSON.stringify([...strings, target.questionIndex, target.fingerprint])).toString("base64url");
  if (ref.length > 512) throw new Error("async question context is too long");
  return ref;
}
export function parseAsyncUserInputContextRef(value?: string): AsyncUserInputTarget | undefined {
  if (!hasAsyncUserInputContextRef(value)) return undefined;
  try {
    const values = JSON.parse(Buffer.from(value!.slice(PREFIX.length), "base64url").toString());
    if (!Array.isArray(values) || values.length !== 7) return undefined;
    const [hostId, harness, sessionId, turnId, itemId, questionIndex, fingerprint] = values;
    const target = { hostId, harness, sessionId, turnId, itemId, questionIndex, fingerprint };
    return asyncUserInputContextRef(target) === value ? target : undefined;
  } catch { return undefined; }
}

async function freshState(adapter: InputAdapter, target: AsyncUserInputTarget) {
  const [state, session] = await Promise.all([adapter.readAsyncUserInputState?.(target.sessionId), adapter.getSession?.(target.sessionId)]);
  if (!state || !session || !state.canRespond || session.id !== target.sessionId || session.harness !== target.harness
    || session.hostId !== target.hostId || !session.cwd?.startsWith("/") || state.target.hostId !== target.hostId
    || state.target.harness !== target.harness || state.target.sessionId !== target.sessionId
    || state.turnId !== target.turnId || state.itemId !== target.itemId || !Array.isArray(state.questions)
    || fingerprint(state.questions) !== target.fingerprint || !state.questions[target.questionIndex]) throw new Error("async native question changed or exact session unavailable");
  return { state, session };
}
function choices(question: Question) {
  return question.options && question.options.length >= 2 && question.options.length <= 4
    ? question.options.map((label, index) => ({ choice_id: `option_${index}`, label: safeVisibleText(label, 512) })) : undefined;
}

/** Persisted typed native questions are reconciled even when the session is idle. */
export function createAsyncUserInputNoticeObserver(registry: HumanRequestRegistry, dependencies: PermissionNoticeObserverDependencies = {}) {
  const observations = new WeakMap<HarnessAdapter, {
    inFlight: Map<string, Promise<boolean>>;
    snapshots: Map<string, { signature: string; at: number }>;
  }>();
  const deliverSession = async (adapter: InputAdapter, session: AgentSession): Promise<boolean> => {
    if (!adapter.readAsyncUserInputState) return true;
    const state = await adapter.readAsyncUserInputState(session.id);
    if (!state) return true;
    if (state.target.hostId !== session.hostId || state.target.harness !== session.harness || state.target.sessionId !== session.id) return false;
    if (!state.canRespond) return true;
    for (let questionIndex = 0; questionIndex < state.questions.length; questionIndex++) {
      const target: AsyncUserInputTarget = { ...state.target, turnId: state.turnId, itemId: state.itemId, questionIndex, fingerprint: fingerprint(state.questions) };
      const contextRef = asyncUserInputContextRef(target);
      const producer = await (dependencies.loadProducerForTarget ? dependencies.loadProducerForTarget(target) : dependencies.loadProducer ? dependencies.loadProducer() : loadAskHumanProducerForTarget(target));
      if (!producer) return false;
      const bound = await withPermissionQuestionCreationLock(async () => {
        const current = await freshState(adapter, target);
        if (current.session.cwd !== session.cwd) throw new Error("async question cwd changed");
        let record = (await registry.list()).find(record => record.contextRef === contextRef);
        if (record && record.status !== "pending") return undefined;
        record ??= await registry.create({ kind: "user", answerSource: "notice_question", noticeDeliveryMode: "automatic", contextRef,
          target: { harness: target.harness, sessionId: target.sessionId, cwd: current.session.cwd },
          notify: { project: producer.project, recipient: producer.recipient, kind: "human_request", severity: "important", title: "Агент ждёт вашего ответа" } });
        const source = current.state.questions[questionIndex]!;
        const offered = choices(source);
        const message = ["Агент ждёт вашего ответа.", `Сессия: ${safeVisibleText(current.session.title || current.session.id, 400)}`,
          safeVisibleText(source.title, 2400), ...(!offered ? (source.options ?? []).map(option => safeVisibleText(option, 350)) : [])].join("\n");
        const binding: HumanQuestionBinding = { request_id: record.requestId, native_target: nativeTarget(record), dedup_key: record.notify!.dedupKey, context_ref: contextRef, kind: "user", record,
          question: { message, ...(offered ? { choices: offered } : {}) }, answer: { mcp_tool: "human_request_resolve", completion_path: "/internal/human-requests/ask-user-completion" } };
        return { record, binding };
      });
      if (!bound) continue;
      const config = { project: producer.project, recipient: producer.recipient, allowedActors: producer.allowedActors };
      const payloadFingerprint = createHash("sha256").update(JSON.stringify(buildAskHumanRequest(bound.binding, config))).digest("hex");
      const claim = await registry.claimNoticeDelivery(bound.record.requestId, payloadFingerprint);
      if (!claim.admitted || !claim.claimId) continue;
      try {
        const latest = await freshState(adapter, target);
        if (latest.session.cwd !== bound.record.target.cwd) throw new Error("async question cwd changed before delivery");
        const receipt = await deliverNoticeQuestion(bound.binding, { ...config, endpoint: producer.endpoint, token: producer.token, fetchImpl: dependencies.fetchImpl, requireExactTelegramReceipt: true });
        await registry.completeNoticeDelivery(bound.record.requestId, claim.claimId, { state: "accepted", httpStatus: receipt.httpStatus, noticeRequestId: receipt.requestId, deliveryStatus: receipt.deliveryStatus });
      } catch {
        await registry.completeNoticeDelivery(bound.record.requestId, claim.claimId, { state: "unknown" });
      }
    }
    return true;
  };
  const observeSession = (adapter: HarnessAdapter, session: AgentSession, force = false): Promise<boolean> => {
    let state = observations.get(adapter);
    if (!state) {
      state = { inFlight: new Map(), snapshots: new Map() };
      observations.set(adapter, state);
    }
    const key = JSON.stringify([session.hostId, session.harness, session.id]);
    const existing = state.inFlight.get(key);
    if (existing) return existing;
    const signature = JSON.stringify([session.lastActivity, session.status, session.cwd,
      session.messageCount, session.lastMessage, session.needsPermission]);
    const cached = state.snapshots.get(key);
    const startedAt = Date.now();
    if (!force && cached?.signature === signature && startedAt - cached.at >= 0 && startedAt - cached.at < 60_000) return Promise.resolve(true);
    // Snapshot/event paths share one read. A null read is only cached briefly:
    // native transport failure must never become a permanent negative result.
    const owned = state;
    const work = Promise.resolve().then(async () => {
      try {
        const complete = await deliverSession(adapter as InputAdapter, session);
        if (complete) owned.snapshots.set(key, { signature, at: startedAt });
        else owned.snapshots.delete(key);
        return complete;
      } catch {
        owned.snapshots.delete(key);
        return false;
      }
    }).finally(() => { owned.inFlight.delete(key); });
    owned.inFlight.set(key, work);
    return work;
  };
  return {
    async onEvent(adapter: HarnessAdapter, event: HarnessEvent) {
      if (!event.sessionId || (event.nativeType !== "agentMessage/questions" && event.nativeType !== "turn/completed")) return;
      const session = await adapter.getSession?.(event.sessionId);
      if (session) await observeSession(adapter, session, true);
    },
    async reconcileInitialSnapshot(adapter: HarnessAdapter, sessions: AgentSession[]) {
      let complete = true;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
        while (next < sessions.length) {
          const session = sessions[next++]!;
          if (!await observeSession(adapter, session)) complete = false;
        }
      }));
      return complete;
    },
  };
}

/** Read all canonical Notice results without invoking a native continuation. */
export async function collectCanonicalAsyncUserInputAnswers(registry: HumanRequestRegistry, record: HumanRequestRecord, adapter: HarnessAdapter, dependencies: PermissionNoticeObserverDependencies = {}) {
  const target = parseAsyncUserInputContextRef(record.contextRef);
  if (!target) throw new Error("invalid async question context");
  const current = await freshState(adapter as InputAdapter, target);
  if (current.session.cwd !== record.target.cwd) throw new Error("async question cwd changed");
  const producer = await (dependencies.loadProducerForTarget ? dependencies.loadProducerForTarget(target) : dependencies.loadProducer ? dependencies.loadProducer() : loadAskHumanProducerForTarget(target));
  if (!producer) throw new Error("async question producer unavailable");
  const records = await registry.list();
  const siblings: Array<{ record: HumanRequestRecord; resultRef: string }> = [];
  const answers: Array<{ question: string; answer: string }> = [];
  for (let questionIndex = 0; questionIndex < current.state.questions.length; questionIndex++) {
    const source = current.state.questions[questionIndex]!;
    const context = asyncUserInputContextRef({ ...target, questionIndex });
    const sibling = records.find(candidate => candidate.contextRef === context);
    if (!sibling) return null;
    if (sibling.target.cwd !== current.session.cwd) throw new Error("async sibling cwd changed");
    const resolved = await readCanonicalNativeUserAnswer(sibling, target, producer, dependencies.fetchImpl ?? fetch);
    if (!resolved) return null;
    const offered = choices(source);
    const optionIndex = offered?.findIndex(choice => choice.choice_id === resolved.answer);
    if (offered && (optionIndex === undefined || optionIndex < 0)) throw new Error("canonical async choice is not an offered option");
    answers.push({ question: source.title, answer: offered ? source.options![optionIndex!]! : resolved.answer });
    siblings.push({ record: sibling, resultRef: resolved.resultRef });
  }
  const final = await freshState(adapter as InputAdapter, target);
  if (final.session.cwd !== current.session.cwd) throw new Error("async question cwd changed during canonical reads");
  if (!siblings.length) throw new Error("async request has no answerable questions");
  return { target, answers, siblings, carrier: siblings[0]!.record };
}
