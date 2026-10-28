import { createHash } from "node:crypto";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../types/index.js";
import { safeVisibleText, withPermissionQuestionCreationLock, type PermissionNoticeObserverDependencies } from "../permission-control/notice-bridge.js";
import { loadAskHumanProducerForTarget, type AskHumanProducer } from "./ask-human-producer.js";
import { buildAskHumanRequest, deliverNoticeQuestion } from "./notice-question.js";
import { nativeTarget, type HumanQuestionBinding } from "./question-binding.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

const PREFIX = "agent-herder:native-input:v1:";
export type NativeUserInputTarget = { hostId: string; harness: string; sessionId: string; nativeRequestId: string; questionId: string };
type Question = { id: string; header?: string; question: string; options?: null | Array<{ label: string; description?: string }>; isSecret?: boolean; isOther?: boolean };
type PendingInput = { id: string; requestId?: string; turnId: string; itemId: string; canRespond: boolean; questions: Question[] };
type InputAdapter = HarnessAdapter & { readNativeUserInputState?: (id: string) => Promise<{ target: { hostId: string; harness: string; sessionId: string }; pendingRequests: PendingInput[] } | null> };

export function hasNativeUserInputContextRef(value?: string): boolean { return value?.startsWith(PREFIX) ?? false; }
export function nativeUserInputContextRef(target: NativeUserInputTarget): string {
  if (Object.values(target).some(value => !value || value.length > 512 || /[\u0000-\u001f]/.test(value))) throw new Error("invalid native user-input target");
  const ref = PREFIX + Buffer.from(JSON.stringify(target)).toString("base64url");
  if (ref.length > 512) throw new Error("native user-input context is too long");
  return ref;
}
export function parseNativeUserInputContextRef(value?: string): NativeUserInputTarget | undefined {
  if (!hasNativeUserInputContextRef(value)) return undefined;
  try {
    const target = JSON.parse(Buffer.from(value!.slice(PREFIX.length), "base64url").toString()) as NativeUserInputTarget;
    if (Object.keys(target).length !== 5 || ["hostId", "harness", "sessionId", "nativeRequestId", "questionId"].some(key => typeof target[key as keyof NativeUserInputTarget] !== "string")) return undefined;
    return nativeUserInputContextRef(target) === value ? target : undefined;
  } catch { return undefined; }
}

async function freshRequest(adapter: InputAdapter, target: Pick<NativeUserInputTarget, "hostId" | "harness" | "sessionId" | "nativeRequestId">) {
  const [state, session] = await Promise.all([adapter.readNativeUserInputState?.(target.sessionId), adapter.getSession?.(target.sessionId)]);
  if (!state || !session || session.id !== target.sessionId || session.harness !== target.harness || session.hostId !== target.hostId
    || state.target.hostId !== target.hostId || state.target.harness !== target.harness || state.target.sessionId !== target.sessionId || !session.cwd?.startsWith("/")) throw new Error("exact native user-input session unavailable");
  const pending = state.pendingRequests.find(request => request.id === target.nativeRequestId && request.canRespond);
  if (!pending) throw new Error("exact native user-input request is not actionable; cold restore is not implied");
  return { pending, session };
}

function questionChoices(question: Question) {
  return !question.isOther && question.options && question.options.length >= 2 && question.options.length <= 4
    ? question.options.map((option, index) => ({ choice_id: `option_${index}`, label: safeVisibleText(option.label, 512) })) : undefined;
}

/** Native source questions only; secrets never enter ordinary Notice text. */
export function createNativeUserInputNoticeObserver(registry: HumanRequestRegistry, dependencies: PermissionNoticeObserverDependencies = {}) {
  const deliverSession = async (adapter: InputAdapter, session: AgentSession): Promise<boolean> => {
    if (!adapter.readNativeUserInputState) return true;
    const state = await adapter.readNativeUserInputState(session.id);
    if (!state || state.target.hostId !== session.hostId || state.target.harness !== session.harness || state.target.sessionId !== session.id) return false;
    for (const pending of state.pendingRequests) {
      if (!pending.canRespond) continue;
      for (const question of pending.questions) {
        if (question.isSecret) continue;
        const target: NativeUserInputTarget = { hostId: session.hostId, harness: session.harness, sessionId: session.id, nativeRequestId: pending.id, questionId: question.id };
        const producer = await (dependencies.loadProducerForTarget ? dependencies.loadProducerForTarget(target) : dependencies.loadProducer ? dependencies.loadProducer() : loadAskHumanProducerForTarget(target));
        if (!producer) return false;
        const contextRef = nativeUserInputContextRef(target);
        const bound = await withPermissionQuestionCreationLock(async () => {
          const current = await freshRequest(adapter, target);
          const source = current.pending.questions.find(q => q.id === question.id);
          if (!source || source.isSecret || current.session.cwd !== session.cwd) throw new Error("native question changed before delivery");
          let record = (await registry.list()).find(r => r.contextRef === contextRef);
          if (record && record.status !== "pending") return undefined;
          record ??= await registry.create({ kind: "user", answerSource: "notice_question", noticeDeliveryMode: "automatic", contextRef,
            target: { harness: target.harness, sessionId: target.sessionId, cwd: current.session.cwd },
            notify: { project: producer.project, recipient: producer.recipient, kind: "human_request", severity: "important", title: "Агент ждёт вашего ответа" } });
          const choices = questionChoices(source);
          const message = ["Агент ждёт вашего ответа.", `Сессия: ${safeVisibleText(current.session.title || current.session.id, 400)}`,
            source.header ? safeVisibleText(source.header, 300) : "", safeVisibleText(source.question, 2400),
            ...(!choices ? (source.options ?? []).map(option => safeVisibleText([option.label, option.description].filter(Boolean).join(": "), 350)) : []),
            ...(source.isOther ? ["Можно выбрать вариант выше или ответить своим текстом."] : [])].filter(Boolean).join("\n");
          const binding: HumanQuestionBinding = { request_id: record.requestId, native_target: nativeTarget(record), dedup_key: record.notify!.dedupKey, context_ref: contextRef, kind: "user", record,
            question: { message, ...(choices ? { choices } : {}) }, answer: { mcp_tool: "human_request_resolve", completion_path: "/internal/human-requests/ask-user-completion" } };
          return { record, binding };
        });
        if (!bound) continue;
        const config = { project: producer.project, recipient: producer.recipient, allowedActors: producer.allowedActors };
        const fingerprint = createHash("sha256").update(JSON.stringify(buildAskHumanRequest(bound.binding, config))).digest("hex");
        const claim = await registry.claimNoticeDelivery(bound.record.requestId, fingerprint);
        if (!claim.admitted || !claim.claimId) continue;
        try {
          const receipt = await deliverNoticeQuestion(bound.binding, { ...config, endpoint: producer.endpoint, token: producer.token, fetchImpl: dependencies.fetchImpl, requireExactTelegramReceipt: true });
          await registry.completeNoticeDelivery(bound.record.requestId, claim.claimId, { state: "accepted", httpStatus: receipt.httpStatus, noticeRequestId: receipt.requestId, deliveryStatus: receipt.deliveryStatus });
        } catch {
          // Ambiguous POST admission is durable and is never sent again after boot.
          await registry.completeNoticeDelivery(bound.record.requestId, claim.claimId, { state: "unknown" });
        }
      }
    }
    return true;
  };
  return {
    async onEvent(adapter: HarnessAdapter, event: HarnessEvent) {
      if (event.nativeType !== "item/tool/requestUserInput" || !event.sessionId) return;
      const session = await adapter.getSession?.(event.sessionId);
      if (session) await deliverSession(adapter as InputAdapter, session);
    },
    async reconcileInitialSnapshot(adapter: HarnessAdapter, sessions: AgentSession[]) {
      let complete = true;
      for (const session of sessions) {
        if (session.status !== "needs_input" && session.needsPermission !== true) continue;
        try { if (!await deliverSession(adapter as InputAdapter, session)) complete = false; } catch { complete = false; }
      }
      return complete;
    },
  };
}

export async function readCanonicalNativeUserAnswer(record: HumanRequestRecord, target: Pick<NativeUserInputTarget, "hostId" | "harness" | "sessionId">, producer: AskHumanProducer, fetchImpl: typeof fetch) {
  if (record.notify?.project !== producer.project || record.notify.recipient !== producer.recipient || record.kind !== "user"
    || (record.target.agent ?? record.target.harness) !== target.harness || record.target.sessionId !== target.sessionId) throw new Error("native input Notice routing mismatch");
  const url = new URL(producer.endpoint);
  if (!url.pathname.replace(/\/$/, "").endsWith("/v1/human-requests")) throw new Error("canonical answer endpoint unavailable");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(record.requestId)}/result`; url.search = ""; url.hash = "";
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${producer.token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 409) return null;
  if (!response.ok) throw new Error("canonical native question answer unavailable");
  const value = await response.json() as Record<string, any>;
  if (value.schema !== "ask_human.result.v1" || value.request_id !== record.requestId || value.state !== "resolved" || value.kind !== "user"
    || typeof value.result_ref !== "string" || !value.result_ref || typeof value.answer !== "string" || !value.answer.trim()
    || value.native?.harness !== target.harness || value.native?.session_id !== target.sessionId || value.native?.cwd !== record.target.cwd) throw new Error("canonical native question answer mismatch");
  return { answer: value.answer as string, resultRef: value.result_ref as string };
}

/** Collect all canonical sibling answers; never admit a native response itself. */
export async function collectCanonicalNativeUserInputAnswers(registry: HumanRequestRegistry, record: HumanRequestRecord, adapter: HarnessAdapter, dependencies: PermissionNoticeObserverDependencies = {}) {
  const target = parseNativeUserInputContextRef(record.contextRef);
  if (!target) throw new Error("invalid native user-input context");
  const current = await freshRequest(adapter as InputAdapter, target);
  if (current.session.cwd !== record.target.cwd) throw new Error("native question cwd changed");
  const producer = await (dependencies.loadProducerForTarget ? dependencies.loadProducerForTarget(target) : dependencies.loadProducer ? dependencies.loadProducer() : loadAskHumanProducerForTarget(target));
  if (!producer) throw new Error("native question producer unavailable");
  const records = await registry.list();
  const siblings: Array<{ record: HumanRequestRecord; resultRef: string }> = [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of [...current.pending.questions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (question.isSecret) throw new Error("secret native question requires its protected answer channel");
    const context = nativeUserInputContextRef({ ...target, questionId: question.id });
    const sibling = records.find(r => r.contextRef === context);
    if (!sibling) return null;
    const resolved = await readCanonicalNativeUserAnswer(sibling, target, producer, dependencies.fetchImpl ?? fetch);
    if (!resolved) return null;
    const choices = questionChoices(question);
    const optionIndex = choices?.findIndex(choice => choice.choice_id === resolved.answer);
    if (choices && (optionIndex === undefined || optionIndex < 0)) throw new Error("canonical native choice is not an offered option");
    answers[question.id] = { answers: [choices ? question.options![optionIndex!]!.label : resolved.answer] };
    siblings.push({ record: sibling, resultRef: resolved.resultRef });
  }
  if (!siblings.length) throw new Error("native request has no answerable questions");
  return { target, answers, siblings, carrier: siblings[0]!.record };
}
