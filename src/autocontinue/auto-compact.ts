import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { cacheWindowFor } from "../cache-handoff.js";
import type { UnfinishedSessionNotice } from "../autopilot/unfinished-session-launcher.js";
import type { AgentSession, ControlResult, HarnessAdapter, HarnessEvent } from "../types/index.js";

export interface AutoCompactSettings {
  enabled: boolean;
  harnesses: string[];
  idleSeconds: number;
  maxAgeSeconds: number;
  minContextPercent: number;
  minHumanMessages: number;
  maxPerHour: number;
}
export interface CompactReceipt {
  inputId: string; sourceKey: string; harness: string; sessionId: string;
  userMessageId: string; tokensBefore: number; tokensAfter?: number; durationMs?: number;
  state: "submitting" | "accepted" | "completed" | "failed";
  /** Native turn boundary observed at submit time; a later terminal boundary without a
   * real user prompt is the maintenance turn this operation submitted. */
  turnBoundaryAt?: string;
  createdAt: string; updatedAt: string; error?: string; cause?: string; automatic?: boolean; notifiedAt?: string;
}
interface State { version: 1; settings: AutoCompactSettings; operations: CompactReceipt[] }
const DEFAULTS: AutoCompactSettings = { enabled: false, harnesses: ["zcode"], idleSeconds: 45, maxAgeSeconds: 300, minContextPercent: 35, minHumanMessages: 5, maxPerHour: 6 };

/** Configuration and native admission share one durable, cross-process transaction. */
export class AutoCompactStore {
  constructor(private readonly path: string) {}
  async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as State;
      if (state.version !== 1 || !Array.isArray(state.operations)) throw new Error("Повреждено состояние автокомпакта");
      state.settings = { ...DEFAULTS, ...state.settings };
      delete (state.settings as AutoCompactSettings & { minContextTokens?: number }).minContextTokens;
      validateSettings(state.settings);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, settings: { ...DEFAULTS, harnesses: [...DEFAULTS.harnesses] }, operations: [] };
      throw error;
    }
  }
  async updateSettings(settings: AutoCompactSettings): Promise<AutoCompactSettings> {
    validateSettings(settings);
    return this.mutate((state) => state.settings = { ...settings, harnesses: [...settings.harnesses] });
  }
  async claim(receipt: CompactReceipt, maxPerHour?: number): Promise<CompactReceipt | null> {
    return this.mutate((state) => {
      if (state.operations.length >= 10_000) return null;
      if (state.operations.some((item) => item.inputId === receipt.inputId || item.sourceKey === receipt.sourceKey)) return null;
      if (maxPerHour !== undefined && state.operations.filter((item) => Date.parse(receipt.createdAt) - Date.parse(item.createdAt) < 3_600_000).length >= maxPerHour) return null;
      state.operations.push(receipt);
      return receipt;
    });
  }
  async finish(inputId: string, patch: Partial<CompactReceipt>): Promise<void> {
    await this.mutate((state) => {
      const receipt = state.operations.find((item) => item.inputId === inputId);
      if (receipt) Object.assign(receipt, patch, { inputId: receipt.inputId, sourceKey: receipt.sourceKey });
    });
  }
  private async mutate<T>(action: (state: State) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const target = `${this.path}.lock`;
    await writeFile(target, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(target, { realpath: false, retries: { retries: 80, minTimeout: 20, maxTimeout: 50 }, stale: 30_000 });
    try {
      const state = await this.read();
      const result = action(state);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    } finally { await release(); }
  }
}

function validateSettings(value: AutoCompactSettings): void {
  if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.harnesses)
    || value.harnesses.some((item) => item !== "zcode") || new Set(value.harnesses).size !== value.harnesses.length) throw new Error("Неверные настройки сред автокомпакта");
  for (const [field, minimum, maximum] of [["idleSeconds", 5, 600], ["maxAgeSeconds", 30, 7200], ["minContextPercent", 1, 99], ["minHumanMessages", 1, 100], ["maxPerHour", 1, 24]] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < minimum || value[field] > maximum) throw new Error(`Недопустимое значение настройки ${field}`);
  }
  if (value.maxAgeSeconds <= value.idleSeconds) throw new Error("Окно кэша должно быть больше паузы после ответа");
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
export function compactContext(session: AgentSession) {
  const meta = session.meta || {};
  const usage = object(meta.nativeContextUsage);
  const cache = object(usage.cache);
  const turn = object(meta.nativeLastTurn);
  const prompt = object(meta.latestUserPrompt);
  // The native cancelled_by_user flag also covers a cancelled maintenance turn, so
  // only this service's own human-stop evidence can rule a terminal turn out.
  const humanStopHeld = meta.humanStopHeld === true || session.meta?.humanStopHeld === true;
  return {
    userMessageId: typeof prompt.id === "string" ? prompt.id : undefined,
    tokens: typeof usage.used === "number" && Number.isSafeInteger(usage.used) ? usage.used : 0,
    capacity: typeof usage.size === "number" && Number.isSafeInteger(usage.size) ? usage.size : 0,
    humanMessages: typeof meta.nativeHumanMessageCount === "number" ? meta.nativeHumanMessageCount : 0,
    cacheRead: typeof cache.cacheReadTokens === "number" ? cache.cacheReadTokens : 0,
    cacheInput: typeof cache.inputTokens === "number" ? cache.inputTokens : 0,
    cacheHitRate: typeof cache.latestHitRate === "number" && Number.isFinite(cache.latestHitRate) ? cache.latestHitRate : undefined,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : typeof turn.completedAt === "string" ? Date.parse(turn.completedAt) : NaN,
    complete: turn.status === "completed" && turn.kind !== "compact",
    compactFailed: turn.kind === "compact" && turn.status === "failed",
    /** Terminal native failure of the latest turn, except a human stop this service can prove. */
    turnFailed: ["failed", "error", "cancelled"].includes(String(turn.status))
      && !humanStopHeld && !meta.automationStop,
    /** A maintenance turn is bound to no real user prompt; a task turn always is. */
    turnUserMessageId: typeof turn.userMessageId === "string" ? turn.userMessageId : undefined,
    nativeCause: nativeTurnCause(turn),
    turnBoundary: typeof turn.turnId === "string" ? turn.turnId : String(turn.completedAt || ""),
    quiet: meta.nativeLoaded === true && ["idle", "stopped", "completed"].includes(String(meta.nativeStatus))
      && !meta.nativeActiveTurnId && !meta.nativeActiveTurnKind && !session.needsPermission
      && turn.pendingInput !== true && turn.cancelledByUser !== true
      && !session.meta?.humanStopHeld && !meta.automationStop && !(Array.isArray(meta.pendingRequestIds) && meta.pendingRequestIds.length)
      && meta.sessionKind !== "subagent_child" && !meta.parentSessionId,
  };
}

/** Maintenance only: no task prompt, new session, TTL keepalive or LLM completion judge. */
export class AutoCompactService {
  private running: Promise<void> | undefined;
  private timer?: NodeJS.Timeout;
  private cursor = 0;
  constructor(private readonly options: {
    adapters: Map<string, HarnessAdapter>; store: AutoCompactStore;
    held: (harness: string, id: string) => Promise<boolean>;
    worthResuming: (session: AgentSession) => Promise<boolean>;
    now?: () => number;
    notify?: (notice: UnfinishedSessionNotice) => Promise<void>;
  }) {}
  supportedHarnesses(): string[] { return [...this.options.adapters].filter(([, adapter]) => Boolean(adapter.compactSession)).map(([harness]) => harness); }
  /** Native maintenance outcome: one failed compact turn settles its own operation. */
  observe(event: HarnessEvent): Promise<void> {
    if (event.kind !== "turn.failed" || !event.sessionId || event.data?.maintenance !== "compact") return Promise.resolve();
    return this.settleNativeFailure(event.harness, event.sessionId, nativeFailureCause(event.data), event.data?.inputId);
  }
  private async settleNativeFailure(harness: string, sessionId: string, cause: string, inputId?: unknown): Promise<void> {
    const state = await this.options.store.read();
    const claimed = typeof inputId === "string" ? inputId : undefined;
    const operation = [...state.operations].reverse().find((item) => (item.state === "accepted" || item.state === "submitting")
      && item.harness === harness && item.sessionId === sessionId && (!claimed || item.inputId === claimed));
    if (!operation) return;
    const now = this.options.now?.() ?? Date.now();
    await this.options.store.finish(operation.inputId, { state: "failed", cause, error: `Нативное сжатие завершилось ошибкой: ${cause}`, durationMs: Math.max(0, now - Date.parse(operation.createdAt)), updatedAt: new Date(now).toISOString() });
  }
  start(): () => void {
    this.timer = setInterval(() => { void this.tick().catch((error) => console.error("[agent-herder] автокомпакт:", (error as Error).message)); }, 15_000);
    this.timer.unref();
    return () => { if (this.timer) clearInterval(this.timer); this.timer = undefined; };
  }
  tick(): Promise<void> {
    return this.running ??= this.runCycle().finally(() => { this.running = undefined; });
  }
  private async runCycle(): Promise<void> {
    const state = await this.options.store.read();
    const now = this.options.now?.() ?? Date.now();
    for (const operation of state.operations.filter((item) => item.state === "accepted" || item.state === "submitting").slice(-4)) {
      const adapter = this.options.adapters.get(operation.harness);
      if (adapter?.isReady && !adapter.isReady()) continue;
      const session = await adapter?.getSession(operation.sessionId);
      if (!session) {
        if (now - Date.parse(operation.createdAt) > 15 * 60_000) await this.options.store.finish(operation.inputId, { state: "failed", error: "Нативная сессия недоступна; результат компакта неизвестен, повтор запрещён.", updatedAt: new Date(now).toISOString() });
        continue;
      }
      const context = compactContext(session);
      if (context.quiet && context.userMessageId === operation.userMessageId && context.tokens > 0 && context.tokens < operation.tokensBefore) {
        await this.options.store.finish(operation.inputId, { state: "completed", tokensAfter: context.tokens, durationMs: now - Date.parse(operation.createdAt), updatedAt: new Date(now).toISOString() });
      } else if (context.compactFailed) {
        const cause = context.nativeCause ?? "Нативная среда сообщила об ошибке сжатия без подробностей.";
        await this.options.store.finish(operation.inputId, { state: "failed", cause, error: `Нативное сжатие завершилось ошибкой: ${cause}`, durationMs: now - Date.parse(operation.createdAt), updatedAt: new Date(now).toISOString() });
      } else if (context.turnFailed && !context.turnUserMessageId && context.turnBoundary !== operation.turnBoundaryAt) {
        // The durable native receipt carries no compact kind, so a terminal turn that
        // appeared after submit time and owns no real user prompt is the compact itself.
        const cause = context.nativeCause ?? "Нативная среда сообщила об ошибке сжатия без подробностей.";
        await this.options.store.finish(operation.inputId, { state: "failed", cause, error: `Нативное сжатие завершилось ошибкой: ${cause}`, durationMs: now - Date.parse(operation.createdAt), updatedAt: new Date(now).toISOString() });
      } else if (now - Date.parse(operation.createdAt) > 15 * 60_000) {
        await this.options.store.finish(operation.inputId, { state: "failed", error: "Результат компакта не подтверждён; автоматический повтор запрещён.", updatedAt: new Date(now).toISOString() });
      }
    }
    for (const operation of (await this.options.store.read()).operations.filter((item) => item.automatic && item.state === "failed" && !item.notifiedAt).slice(-4)) {
      if (!this.options.notify) break;
      const cause = operation.cause ? ` Причина: ${operation.cause.replace(/[.\s]+$/, "")}.` : " Причина нативной средой не сообщена.";
      await this.options.notify({ severity: "critical", title: "Agent Herder: не удалось сжать контекст", body: `Сжатие контекста сессии ${operation.harness} не выполнено.${cause} В контексте осталось ${operation.tokensBefore} токенов, поэтому возобновление сессии потребует больше токенов. История сессии сохранена, автоматический повтор не выполняется.`, dedupKey: `agent-herder:autocompact:${operation.sourceKey}`, correlationId: operation.inputId, sourceId: `agent-herder:autocompact:${operation.sourceKey}`, signalType: "autocompact-failed" });
      await this.options.store.finish(operation.inputId, { notifiedAt: new Date(now).toISOString() });
    }
    if (!state.settings.enabled) return;
    for (const harness of state.settings.harnesses) {
      const adapter = this.options.adapters.get(harness);
      if (!adapter?.compactSession || (adapter.isReady && !adapter.isReady())) continue;
      const recent = (await adapter.listSessions()).filter((session) => now - Date.parse(session.lastActivity) <= (cacheWindowFor(session).ttlMs ?? state.settings.maxAgeSeconds * 1000));
      if (!recent.length) continue;
      const candidates = Array.from({ length: Math.min(4, recent.length) }, (_, offset) => recent[(this.cursor + offset) % recent.length]!);
      this.cursor = (this.cursor + 4) % recent.length;
      for (const candidate of candidates) {
        const result = await this.compact(harness, candidate.id, undefined, false);
        if (result.admitted) return; // one native maintenance request per lifecycle tick
      }
    }
  }
  async compact(harness: string, id: string, requestedInputId?: string, manual = true): Promise<ControlResult> {
    const adapter = this.options.adapters.get(harness);
    if (!adapter?.compactSession) return { ok: false, error: "Нативный компакт этой среды пока не поддерживается." };
    const state = await this.options.store.read();
    if (requestedInputId) {
      const prior = state.operations.find((item) => item.inputId === requestedInputId);
      if (prior) return prior.harness === harness && prior.sessionId === id ? receiptResult(prior) : { ok: false, nonRetryable: true, error: "Этот inputId уже относится к другой сессии." };
    }
    if (adapter.isReady && !adapter.isReady()) return { ok: false, error: "Среда ещё не подключена; холодная загрузка для компакта запрещена." };
    if (await this.options.held(harness, id)) return { ok: false, error: "Сессия явно остановлена; компакт запрещён." };
    const session = await adapter.getSession(id);
    if (!session) return { ok: false, error: "Сессия недоступна." };
    const context = compactContext(session);
    if (!context.quiet || !context.userMessageId) return { ok: false, error: "Сессия работает, ждёт человека или её контекст неизвестен." };
    const now = this.options.now?.() ?? Date.now();
    const age = now - context.completedAt;
    const windowMs = cacheWindowFor(session).ttlMs ?? state.settings.maxAgeSeconds * 1000;
    // Reserve measured completion time, a 30s finish margin and one poll. This
    // is a target for unknown provider retention, never an exact TTL promise.
    const measured = state.operations.filter((item) => item.harness === harness && item.state === "completed" && item.durationMs).slice(-20).map((item) => item.durationMs!);
    const durationMs = Math.max(60_000, ...measured);
    const startAt = Math.max(state.settings.idleSeconds * 1000, windowMs - durationMs - 45_000);
    if (!manual && (!state.settings.enabled || !state.settings.harnesses.includes(harness)
      || !context.complete || !Number.isFinite(age) || age < startAt || age + durationMs > windowMs - 30_000
      || context.capacity <= 0 || context.tokens / context.capacity * 100 < state.settings.minContextPercent
      || context.humanMessages < state.settings.minHumanMessages
      || !await this.options.worthResuming(session))) return { ok: false, error: "Сессия не требует возобновления, контекст мал или время компакта ещё не пришло." };
    const sourceKey = createHash("sha256").update(`${harness}:${id}:${session.cwd}:${context.userMessageId}:${context.turnBoundary}`).digest("hex");
    const existing = state.operations.find((item) => item.sourceKey === sourceKey);
    if (existing) return receiptResult(existing);
    const inputId = requestedInputId || `autocompact:${sourceKey}`;
    const stamp = new Date(now).toISOString();
    const claimed = await this.options.store.claim({ inputId, sourceKey, harness, sessionId: id, userMessageId: context.userMessageId, tokensBefore: context.tokens, turnBoundaryAt: context.turnBoundary, state: "submitting", automatic: !manual, createdAt: stamp, updatedAt: stamp }, manual ? undefined : state.settings.maxPerHour);
    if (!claimed) return { ok: false, error: "Компакт уже зарегистрирован или исчерпан лимит сжатий за час." };
    if (await this.options.held(harness, id)) { await this.options.store.finish(inputId, { state: "failed", error: "Сессия остановлена перед отправкой." }); return { ok: false, error: "Сессия явно остановлена." }; }
    let result: ControlResult;
    try { result = await adapter.compactSession(id, { inputId, expectedUserMessageId: context.userMessageId }); }
    catch (error) { result = { ok: false, admissionUnknown: true, nonRetryable: true, inputId, error: (error as Error).message }; }
    await this.options.store.finish(inputId, { state: result.ok ? "accepted" : "failed", error: result.error?.slice(0, 500), updatedAt: stamp });
    return result;
  }
}

/** Durable native turn failure detail, bounded and single-line so a notice never carries a payload. */
function nativeTurnCause(turn: Record<string, unknown>): string | undefined {
  const text = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const code = text(turn.errorCode).slice(0, 96);
  const type = text(turn.errorType).slice(0, 96);
  const message = text(turn.errorMessage).slice(0, 200);
  // An aggregate turn code is often a placeholder, so the per-request reason wins.
  const requestType = text(turn.modelErrorType).slice(0, 96);
  if (message) return requestType ? `Сбой запроса к модели (${requestType}): ${message}` : `Сбой запроса к модели: ${message}`;
  if (code && type && code !== type) return `[${code}] ${type}`;
  return code || type || undefined;
}

/** Native failure detail, bounded and single-line so a notice never carries a payload. */
function nativeFailureCause(data: Record<string, unknown> | undefined): string {
  const text = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const code = text(data?.nativeErrorCode).slice(0, 96);
  const message = text(data?.nativeErrorMessage).slice(0, 200);
  if (code && message) return `[${code}] ${message}`;
  return message || code || "Нативная среда сообщила об ошибке сжатия без подробностей.";
}

function receiptResult(receipt: CompactReceipt): ControlResult {
  if (receipt.state === "submitting") return { ok: false, admissionUnknown: true, nonRetryable: true, inputId: receipt.inputId, error: "Приём компакта не подтверждён; повтор запрещён." };
  return { ok: receipt.state !== "failed", admitted: receipt.state === "accepted" || receipt.state === "completed", pending: receipt.state === "accepted", nonRetryable: receipt.state === "failed", inputId: receipt.inputId, sessionId: receipt.sessionId, error: receipt.error };
}
