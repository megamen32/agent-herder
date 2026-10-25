import { Buffer } from "node:buffer";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { HumanRequestRecord } from "../human-request/registry.js";
import { loadAskHumanProducer } from "../human-request/ask-human-producer.js";
import type { AgentSession, HarnessAdapter, HarnessPermissionState, SessionMessageView } from "../types/index.js";

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
  message: string;
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

function safeVisibleText(value: string, limit: number): string {
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
): Promise<CanonicalNoticeAnswer> {
  const target = parsePermissionReplyContextRef(request.contextRef);
  if (!target || request.kind !== "user") throw new Error("request is not a typed native permission reply");
  const agent = request.target.agent ?? request.target.harness;
  if (agent !== target.harness || request.target.sessionId !== target.sessionId) throw new Error("permission reply target mismatch");
  const producer = await loadAskHumanProducer();
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
