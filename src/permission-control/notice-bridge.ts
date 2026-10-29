import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import { buildAskHumanRequest, deliverNoticeQuestion, NoticeQuestionDeliveryError, type DeliverableHumanQuestion } from "../human-request/notice-question.js";
import { nativeTarget, type HumanQuestionBinding } from "../human-request/question-binding.js";
import { loadAskHumanProducerForTarget, type AskHumanProducer, type NoticeProducerTarget } from "../human-request/ask-human-producer.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "../human-request/registry.js";
import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessPermissionState, SessionMessageView } from "../types/index.js";

const PREFIX = "agent-herder:permission-reply:v1:";

export interface PermissionReplyTarget {
  hostId: string;
  harness: string;
  sessionId: string;
  permissionRequestId: string;
}

export interface CanonicalNoticeAnswer {
  requestId: string;
  resultRef: string;
  answer: "allow" | "deny";
}

export interface PreparedPermissionQuestion {
  target: PermissionReplyTarget;
  sessionCwd?: string;
  message: string;
}

export interface PermissionNoticeObserver {
  onEvent(adapter: HarnessAdapter, event: HarnessEvent): Promise<void>;
  reconcileInitialSnapshot(adapter: HarnessAdapter, sessions: AgentSession[]): Promise<boolean>;
  /** Typed persisted input can be checked independently of global inventory coverage. */
  reconcileSessionSnapshot?(adapter: HarnessAdapter, sessions: AgentSession[]): Promise<boolean>;
}

export interface PermissionNoticeObserverDependencies {
  loadProducer?: () => Promise<AskHumanProducer | undefined>;
  loadProducerForTarget?: (target: NoticeProducerTarget) => Promise<AskHumanProducer | undefined>;
  fetchImpl?: typeof fetch;
}

export interface CreatedPermissionQuestion {
  record: HumanRequestRecord;
  binding: HumanQuestionBinding;
  producer: AskHumanProducer;
  created: boolean;
}

/** Create or reuse the existing typed question after an exact fresh native read. */
export async function createPermissionHumanQuestion(
  adapter: HarnessAdapter,
  registry: HumanRequestRegistry,
  harness: string,
  sessionId: string,
  permissionRequestId: string,
  dependencies: PermissionNoticeObserverDependencies = {},
  expectedRouting?: { project: string; recipient: string },
  noticeDeliveryMode: "manual" | "automatic" = "manual",
  requestedSession?: { cwd?: string; marker?: string },
): Promise<CreatedPermissionQuestion> {
  const prepared = await preparePermissionNoticeQuestion(adapter, harness, sessionId, permissionRequestId, "Нужно ли разрешить выполнение этого нативного запроса?");
  if (!prepared.sessionCwd || !isAbsolute(prepared.sessionCwd)
    || (requestedSession?.cwd !== undefined && requestedSession.cwd !== prepared.sessionCwd)) {
    throw new Error("native permission session identity is incomplete or changed");
  }
  const producer = dependencies.loadProducerForTarget
    ? await dependencies.loadProducerForTarget(prepared.target)
    : await (dependencies.loadProducer ?? (() => loadAskHumanProducerForTarget(prepared.target)))();
  if (!producer) throw new Error("Notice question producer is not configured");
  if (expectedRouting && (producer.project !== expectedRouting.project || producer.recipient !== expectedRouting.recipient)) {
    throw new Error("Notice routing does not match the configured recipient policy");
  }
  const contextRef = permissionReplyContextRef(prepared.target);
  let cardQuestionMessage = prepared.message;
  const admitted = await withPermissionQuestionCreationLock(async () => {
    const current = await preparePermissionNoticeQuestion(adapter, harness, sessionId, permissionRequestId, "Нужно ли разрешить выполнение этого нативного запроса?");
    if (current.target.hostId !== prepared.target.hostId || current.target.harness !== prepared.target.harness
      || current.target.sessionId !== prepared.target.sessionId || current.target.permissionRequestId !== prepared.target.permissionRequestId
      || current.sessionCwd !== prepared.sessionCwd || (requestedSession?.cwd !== undefined && current.sessionCwd !== requestedSession.cwd)) {
      throw new Error("native permission target changed before Notice request creation");
    }
    cardQuestionMessage = current.message;
    const prior = (await registry.list()).find((entry) => entry.contextRef === contextRef);
    if (prior) {
      if (prior.status !== "pending") throw new Error("this native permission request already has a terminal Notice answer");
      if (noticeDeliveryMode === "manual" && prior.noticeDeliveryMode === "automatic") {
        throw new Error("this native permission request is already owned by automatic Notice delivery");
      }
      return { record: prior, created: false };
    }
    const record = await registry.create({
      kind: "user", answerSource: "notice_question",
      noticeDeliveryMode,
      target: { harness, sessionId, cwd: current.sessionCwd, ...(requestedSession?.marker ? { marker: requestedSession.marker } : {}) }, contextRef,
      notify: { project: producer.project, recipient: producer.recipient, kind: "human_request", severity: "important", title: "Требуется решение по разрешению агента" },
    });
    return { record, created: true };
  });
  const { record } = admitted;
  const binding: HumanQuestionBinding = {
    request_id: record.requestId, native_target: nativeTarget(record),
    dedup_key: record.notify!.dedupKey, context_ref: record.contextRef, kind: "user",
    question: { message: cardQuestionMessage, choices: [
      { choice_id: "allow", label: "Разрешить" }, { choice_id: "deny", label: "Запретить" },
    ] },
    answer: { mcp_tool: "human_request_resolve", completion_path: "/internal/human-requests/ask-user-completion" },
    record,
  };
  return { record, binding, producer, created: admitted.created };
}

/** Existing observer join: exact event IDs, plus a one-time authoritative pending-state reconciliation. */
export function createPermissionNoticeObserver(
  registry: HumanRequestRegistry,
  dependencies: PermissionNoticeObserverDependencies = {},
): PermissionNoticeObserver {
  const reported = new Set<string>();
  const reportOnce = (harness: string, reason: string) => {
    const key = `${harness}:${reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    console.warn(`[agent-herder] permission Notice unavailable: ${reason} (${harness})`);
  };
  const deliverExact = async (adapter: HarnessAdapter, harness: string, sessionId: string, permissionRequestId: string): Promise<boolean> => {
    try {
      const { record, binding, producer } = await createPermissionHumanQuestion(adapter, registry, harness, sessionId, permissionRequestId, dependencies, undefined, "automatic");
      const config = { project: producer.project, recipient: producer.recipient, allowedActors: producer.allowedActors };
      const payloadFingerprint = createHash("sha256").update(JSON.stringify(buildAskHumanRequest(binding as DeliverableHumanQuestion, config))).digest("hex");
      const claim = await registry.claimNoticeDelivery(record.requestId, payloadFingerprint);
      if (!claim.admitted || !claim.claimId) return true;
      try {
        const receipt = await deliverNoticeQuestion(binding as DeliverableHumanQuestion, {
          ...config, endpoint: producer.endpoint, token: producer.token, fetchImpl: dependencies.fetchImpl,
          requireExactTelegramReceipt: true,
        });
        if (!receipt) throw new Error("missing exact Notice receipt");
        await registry.completeNoticeDelivery(record.requestId, claim.claimId, {
          state: "accepted", httpStatus: receipt.httpStatus, noticeRequestId: receipt.requestId, deliveryStatus: receipt.deliveryStatus,
        });
        return true;
      } catch (error) {
        // A POST may already have reached Notice. Even if recording UNKNOWN
        // fails, this observer must never reissue the same external action.
        try { await registry.completeNoticeDelivery(record.requestId, claim.claimId, { state: "unknown",
          ...(error instanceof NoticeQuestionDeliveryError ? { httpStatus: error.httpStatus } : {}) }); }
        catch { reportOnce(harness, "delivery_unknown_receipt_unavailable_no_replay"); }
        reportOnce(harness, "delivery_unknown_no_replay");
        return true;
      }
    } catch (error) {
      const reason = error instanceof Error && error.message === "Notice question producer is not configured"
        ? "producer_not_configured"
        : error instanceof Error && error.message.includes("exact native permission request")
          ? "exact_request_not_pending_or_actionable"
          : "exact_native_binding_unavailable";
      reportOnce(harness, reason);
      return false;
    }
  };
  return {
    async onEvent(adapter, event) {
      if (event.kind !== "permission.requested") return;
      if (!event.sessionId) { reportOnce(event.harness, "event_missing_session_id"); return; }
      if (!event.permissionId) { reportOnce(event.harness, "event_missing_exact_permission_id"); return; }
      await deliverExact(adapter, event.harness, event.sessionId, event.permissionId);
    },
    async reconcileInitialSnapshot(adapter, sessions) {
      if (!adapter.getPermissionState) return true;
      let complete = true;
      for (const session of sessions) {
        if (session.needsPermission !== true && session.status !== "needs_input") continue;
        let state: HarnessPermissionState | null;
        try { state = await adapter.getPermissionState(session.id); } catch {
          complete = false;
          reportOnce(session.harness, "initial_permission_snapshot_unavailable");
          continue;
        }
        if (!state || state.target.hostId !== session.hostId || state.target.harness !== session.harness || state.target.sessionId !== session.id) {
          complete = false;
          reportOnce(session.harness, "initial_permission_snapshot_target_mismatch"); continue;
        }
        // The adapter's fresh state explicitly enumerates each ID; no event is mapped to an arbitrary pending request.
        for (const request of state.pendingRequests) {
          if (request.canRespond !== true) continue;
          if (await deliverExact(adapter, session.harness, session.id, request.id) === false) complete = false;
        }
      }
      return complete;
    },
  };
}

/** Verify one fresh native request and build a redacted, visible-only card body. */
export async function preparePermissionNoticeQuestion(
  adapter: HarnessAdapter,
  harness: string,
  sessionId: string,
  permissionRequestId: string,
  humanQuestion: string,
): Promise<PreparedPermissionQuestion> {
  if (!adapter.getPermissionState || !adapter.getSession) throw new Error("native permission state is unavailable");
  const [state, session] = await Promise.all([adapter.getPermissionState(sessionId), adapter.getSession(sessionId)]);
  if (!state || !session || !sameNativeTarget(state, session, harness, sessionId)
    || !state.pendingRequests.some((request) => request.id === permissionRequestId && request.canRespond === true)) {
    throw new Error("exact native permission request is not currently pending");
  }
  const messages = adapter.getSessionMessages ? await adapter.getSessionMessages(sessionId, 30) : null;
  return {
    target: { hostId: state.target.hostId, harness, sessionId, permissionRequestId },
    ...(session.cwd ? { sessionCwd: session.cwd } : {}),
    message: formatPermissionNoticeQuestion(session, state, messages ?? [], permissionRequestId, humanQuestion),
  };
}

function sameNativeTarget(state: HarnessPermissionState, session: AgentSession, harness: string, sessionId: string): boolean {
  return state.target.hostId === session.hostId && state.target.harness === harness && state.target.sessionId === sessionId
    && session.id === sessionId && session.harness === harness;
}

export function formatPermissionNoticeQuestion(
  session: AgentSession,
  state: HarnessPermissionState,
  messages: SessionMessageView[],
  permissionRequestId: string,
  humanQuestion: string,
): string {
  const pending = state.pendingRequests.find((request) => request.id === permissionRequestId);
  if (!pending) throw new Error("permission request is no longer pending");
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  const user = [...messages].reverse().find((message) => message.role === "user");
  const command = safeVisibleText(pending.command || pending.reason || session.permissionDetails?.details || session.permissionDetails?.description || pending.toolName || "Команда не сообщена", 1200);
  const previousAssistant = assistant ? safeVisibleText(visibleMessageText(assistant), 1200) : "";
  const lastUser = user ? safeVisibleText(visibleMessageText(user), 1200) : "";
  const link = `https://agent.bezrabotnyi.com/#/session/${encodeURIComponent(`${session.harness}:${session.id}`)}`;
  return [
    safeVisibleText(humanQuestion || "Разрешить выполнение этого запроса?", 1200),
    `Сессия: ${link}`,
    `Команда: ${command}`,
    ...(previousAssistant ? [`Последний видимый ответ агента: ${previousAssistant}`] : []),
    ...(lastUser ? [`Последнее сообщение пользователя: ${lastUser}`] : []),
    "Ответьте кнопкой «Разрешить» или «Запретить».",
  ].join("\n").slice(0, 4096);
}

function visibleMessageText(message: SessionMessageView): string {
  const visible = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!).join("\n");
  if (visible) return visible;
  return message.parts.some((part) => part.type === "thinking") ? "" : message.text ?? "";
}

export function safeVisibleText(value: string, limit: number): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[скрытый ключ]")
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+)[^\s,;]+/gi, "$1[скрыто]")
    .replace(/\b(?:sk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gi, "[скрытый ключ]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[скрыто]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Store only exact routing identity in Human Request context; never prompt text. */
export function permissionReplyContextRef(target: PermissionReplyTarget): string {
  for (const value of Object.values(target)) {
    if (!value || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error("permission reply target is invalid");
  }
  const encoded = PREFIX + Buffer.from(JSON.stringify(target)).toString("base64url");
  if (encoded.length > 512) throw new Error("permission reply target exceeds the Human Request context reference limit");
  return encoded;
}

export async function withPermissionQuestionCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  const path = process.env.AGENT_HERDER_PERMISSION_REPLY_LEDGER
    || join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || join(homedir(), ".local", "state", "agent-herder"), "permission-replies.json");
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  await handle.close();
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
  try { return await operation(); } finally { await release(); }
}

export function parsePermissionReplyContextRef(value: string | undefined): PermissionReplyTarget | undefined {
  if (!value?.startsWith(PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const target = parsed as Record<string, unknown>;
    if (["hostId", "harness", "sessionId", "permissionRequestId"].some((key) => typeof target[key] !== "string" || !(target[key] as string).trim())) return undefined;
    if (Object.keys(target).length !== 4) return undefined;
    return target as unknown as PermissionReplyTarget;
  } catch { return undefined; }
}

export function hasPermissionReplyContextRef(value: string | undefined): boolean {
  return value?.startsWith(PREFIX) ?? false;
}

/** Read the answer from Notice's authorized canonical store, never from callback text. */
export async function readCanonicalNoticePermissionAnswer(
  request: HumanRequestRecord,
  fetchImpl: typeof fetch = fetch,
  loadProducerForTarget: (target: NoticeProducerTarget) => Promise<AskHumanProducer | undefined> = loadAskHumanProducerForTarget,
): Promise<CanonicalNoticeAnswer> {
  const target = parsePermissionReplyContextRef(request.contextRef);
  if (!target || request.kind !== "user") throw new Error("request is not a typed native permission reply");
  const agent = request.target.agent ?? request.target.harness;
  if (agent !== target.harness || request.target.sessionId !== target.sessionId) throw new Error("permission reply target mismatch");
  const producer = await loadProducerForTarget(target);
  if (!producer || (request.notify && (producer.project !== request.notify.project || producer.recipient !== request.notify.recipient))) {
    throw new Error("authorized Notice project credentials are unavailable for this recipient");
  }
  const endpoint = new URL(producer.endpoint);
  const collection = "/v1/human-requests";
  if (!endpoint.pathname.replace(/\/$/, "").endsWith(collection)) throw new Error("configured Notice endpoint does not expose the canonical answer API");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(request.requestId)}/result`;
  endpoint.search = "";
  endpoint.hash = "";
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${producer.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`canonical Notice answer read failed with HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("canonical Notice answer is malformed");
  const value = raw as Record<string, unknown>;
  const native = value.native as Record<string, unknown> | undefined;
  if (value.schema !== "ask_human.result.v1" || value.request_id !== request.requestId || value.state !== "resolved"
    || value.kind !== "user" || typeof value.result_ref !== "string" || !value.result_ref
    || !native || native.harness !== target.harness || native.session_id !== target.sessionId
    || (request.target.cwd !== undefined && native.cwd !== request.target.cwd)
    || (value.answer !== "allow" && value.answer !== "deny")) {
    throw new Error("canonical Notice answer does not match the bound permission request");
  }
  return { requestId: request.requestId, resultRef: value.result_ref, answer: value.answer };
}
