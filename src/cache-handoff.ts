import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "./types/index.js";
import type { CacheHandoffAdmissionCheckpoint, LineageRecord, LineageStore } from "./lineage-store.js";
import { spawnIsolatedWorkload } from "./workload-launcher.js";

const MAX_SOURCE_CHARS = 120_000;
const MAX_SUMMARY_CHARS = 16_000;
const DEFAULT_MINIMAX_MODEL = "generic.minimax/MiniMax-M3.1-Flash-Preview";

export interface CacheWindow {
  ttlMs?: number;
  source: "openai-30m" | "zai-measured-5m" | "minimax-dynamic-5m" | "configured" | "unknown";
}

export interface CacheHandoffResult {
  kind: "fresh" | "unknown" | "rolled_over" | "admitted_failed";
  session?: AgentSession;
  deliveryPending?: boolean;
  admittedFailure?: string;
  ageMs: number;
  cache: CacheWindow;
}

type DurableAdmissionRestore =
  | { kind: "result"; result: CacheHandoffResult }
  | { kind: "retry"; record: LineageRecord; admission: CacheHandoffAdmissionCheckpoint };

/** Pin the replacement first, then remove stale pins so a failed pin never loses the old anchor. */
export async function movePinnedContinuation(
  replacementAdapter: HarnessAdapter,
  sources: Array<{ adapter: HarnessAdapter; sessionId: string }>,
  replacementSessionId: string,
): Promise<void> {
  if (!replacementAdapter.setSessionPinned) return;
  const pinned = await replacementAdapter.setSessionPinned(replacementSessionId, true);
  if (!pinned.ok) throw new Error(pinned.error || `не удалось закрепить новую сессию ${replacementSessionId}`);
  const uniqueSources = new Map(sources.map((source) => [`${source.adapter.type}:${source.sessionId}`, source]));
  for (const source of uniqueSources.values()) {
    if (source.adapter.type === replacementAdapter.type && source.sessionId === replacementSessionId) continue;
    if (!source.adapter.setSessionPinned) continue;
    const unpinned = await source.adapter.setSessionPinned(source.sessionId, false);
    if (!unpinned.ok) throw new Error(unpinned.error || `не удалось снять закрепление со старой сессии ${source.sessionId}`);
  }
}

export interface SessionSummarizer {
  summarize(source: string): Promise<string>;
}

/** Migrate only retired Z.AI Coding Plan identities; all other handoffs keep the exact model. */
export function continuationModelFor(session: Pick<AgentSession, "harness" | "model">): string | undefined {
  const model = session.model?.trim();
  if (!model) return undefined;
  if (session.harness === "zcode" && /^account:zai-(?:start-plan|individual-coding-plan)\/GLM-5\.3(?:-Flash)?(?:\$[^/]+)?$/i.test(model)) {
    return "account:zai-individual-coding-plan/GLM-5.3-Flash$high";
  }
  return model;
}

export class AnthropicMiniMaxSummarizer implements SessionSummarizer {
  constructor(
    private readonly token: string,
    private readonly baseUrl = process.env.AGENT_HERDER_HANDOFF_ANTHROPIC_BASE_URL || "https://api.minimax.io/anthropic",
    private readonly model = process.env.AGENT_HERDER_HANDOFF_MODEL?.replace(/^generic\.minimax\//, "") || "MiniMax-M3.1-Flash-Preview",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async summarize(source: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": this.token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.AGENT_HERDER_HANDOFF_TIMEOUT_MS || 180_000)),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2_048,
        system: "Сожми протухшую сессию разработки для новой frontier-модели. Не выполняй задачу и не добавляй факты.",
        messages: [{ role: "user", content: [
          { type: "text", text: "Верни короткий русский handoff: цель, уже сделано, решения, важные файлы и проверки, незавершённое, риски, следующий шаг." },
          { type: "text", text: source },
        ] }],
      }),
    });
    if (!response.ok) throw new Error(`MiniMax handoff rejected with HTTP ${response.status}`);
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } };
    const text = (body.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n").trim();
    if (!text) throw new Error(body.error?.message || "MiniMax вернул пустой handoff");
    return text.slice(0, MAX_SUMMARY_CHARS);
  }
}

/** Resolve only documented or explicitly configured cache windows. Unknown is never guessed. */
export function cacheWindowFor(session: Pick<AgentSession, "harness" | "model">, env: NodeJS.ProcessEnv = process.env): CacheWindow {
  const configured = parseOverrides(env.AGENT_HERDER_CACHE_TTL_MINUTES)[`${session.harness}:${session.model || ""}`]
    ?? parseOverrides(env.AGENT_HERDER_CACHE_TTL_MINUTES)[`${session.harness}:*`];
  if (configured !== undefined) return { ttlMs: configured * 60_000, source: "configured" };
  if (session.harness === "codex" && /(?:^|[/.])gpt-(?:5\.(?:6|[7-9])|[6-9])(?:[-.]|$)/i.test(session.model || "")) {
    return { ttlMs: 30 * 60_000, source: "openai-30m" };
  }
  if (/glm-5\.3(?:-flash)?/i.test(session.model || "")) {
    // Z.ai publishes automatic cache telemetry but no fixed TTL. A 2026-10-03
    // three-replica Coding Plan probe found 3/3 hits at 5m and 0/3 by 30m.
    return { ttlMs: 5 * 60_000, source: "zai-measured-5m" };
  }
  if (/minimax[-/.]?m3(?:\.1)?/i.test(session.model || "")) {
    // MiniMax documents load-adjusted passive expiry. Five minutes is the
    // conservative rollover boundary and matches its explicit-cache lifetime.
    return { ttlMs: 5 * 60_000, source: "minimax-dynamic-5m" };
  }
  return { source: "unknown" };
}

/** Poll before cache expiry, while allowing documented long-TTL Codex sessions a wider quiet window. */
export function unfinishedProbeDelayMs(session: Pick<AgentSession, "harness" | "model">, env: NodeJS.ProcessEnv = process.env): number {
  const cache = cacheWindowFor(session, env);
  const unknownDelay = positiveMs(env.AGENT_HERDER_UNFINISHED_UNKNOWN_TTL_CHECK_MS, 240_000);
  if (!cache.ttlMs) return unknownDelay;
  const maxDelay = positiveMs(env.AGENT_HERDER_UNFINISHED_MAX_TTL_CHECK_MS, 600_000);
  const safetyMargin = positiveMs(env.AGENT_HERDER_UNFINISHED_CACHE_MARGIN_MS, 60_000);
  return Math.max(60_000, Math.min(maxDelay, cache.ttlMs - safetyMargin));
}

/** Text sent to MiniMax: user/assistant semantics only, never tools or private reasoning. */
export function semanticTranscript(messages: SessionMessageView[]): string {
  const rows: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => stripReasoning(part.text || ""))
      .filter(Boolean)
      .join("\n") || stripReasoning(message.text || "");
    if (text.trim()) rows.push(`${message.role === "user" ? "ПОЛЬЗОВАТЕЛЬ" : "АГЕНТ"}: ${redactSecrets(text.trim())}`);
  }
  return rows.join("\n\n").slice(-MAX_SOURCE_CHARS);
}

function messageText(message: SessionMessageView): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n") || message.text || "";
}

export class CacheHandoffService {
  private readonly admittedResults = new Map<string, CacheHandoffResult>();

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly summarizer: SessionSummarizer,
    private readonly lineage?: LineageStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async maybeRollover(session: AgentSession, now = new Date(), options: { movePinned?: boolean } = {}): Promise<CacheHandoffResult> {
    const sourceKey = `${session.harness}:${session.id}`;
    const admitted = this.admittedResults.get(sourceKey);
    if (admitted) return admitted;
    const ageMs = Math.max(0, now.getTime() - Date.parse(session.lastActivity));
    const cache = cacheWindowFor(session, this.env);
    if (!cache.ttlMs) return { kind: "unknown", ageMs, cache };
    if (ageMs < cache.ttlMs) return { kind: "fresh", ageMs, cache };
    const adapter = this.adapters.get(session.harness);
    if (!adapter?.getSessionMessages || !adapter.createSession) throw new Error(`${session.harness} не умеет создать cache handoff`);
    const durableAdmission = await this.restoreDurableAdmission(sourceKey, ageMs, cache, adapter);
    if (durableAdmission?.kind === "result") {
      this.admittedResults.set(sourceKey, durableAdmission.result);
      return durableAdmission.result;
    }
    let created: AgentSession;
    let prompt: string;
    let operationId: string;
    let admissionRecord: LineageRecord;
    if (durableAdmission?.kind === "retry") {
      created = durableAdmission.admission.session;
      prompt = durableAdmission.admission.prompt;
      operationId = durableAdmission.admission.operationId;
      admissionRecord = durableAdmission.record;
    } else {
      const messages = await adapter.getSessionMessages(session.id, 1_000);
      const source = semanticTranscript(messages || []);
      if (!source) throw new Error("в сессии нет пользовательского контекста для handoff");
      const summary = (await this.summarizer.summarize(source)).trim().slice(0, MAX_SUMMARY_CHARS);
      if (!summary) throw new Error("MiniMax вернул пустой handoff");
      const continuationModel = continuationModelFor(session);
      created = await adapter.createSession({
        name: `${session.title.slice(0, 180)} · продолжение`, cwd: session.cwd, model: continuationModel,
        ...(session.harness === "zcode" ? { mode: "yolo" } : {}),
      });
      if (continuationModel && (session.harness === "opencode" || created.model !== continuationModel)) {
        if (!adapter.changeModel) throw new Error(`${session.harness} создал handoff без модели продолжения ${continuationModel}`);
        const selected = await adapter.changeModel(created.id, continuationModel);
        if (!selected.ok) throw new Error(selected.error || `не удалось выбрать модель продолжения ${continuationModel}`);
      }
      prompt = handoffPrompt(summary);
      operationId = randomUUID();
      admissionRecord = {
        sessionKey: `${session.harness}:${created.id}`,
        parentKey: sourceKey,
        role: "cache-handoff",
        task: `Продолжение после истечения кэша (${Math.round(ageMs / 60_000)} мин)`,
        provider: session.harness,
        createdAt: new Date().toISOString(),
        source: "supervisor",
        nativeSessionId: created.id,
        cacheHandoffAdmission: { state: "prepared", session: created, operationId, prompt },
      };
      // Persist the exact operation and payload before send. On restart we
      // reconcile this identity; an actually unsent operation is retried in
      // the same replacement, while an admitted one is never duplicated.
      await this.lineage?.record(admissionRecord);
    }
    const sent = await adapter.sendMessage(created.id, { message: prompt, queue: false, inputId: operationId });
    if (!sent.ok && !(sent.admitted && sent.nonRetryable)) throw new Error(sent.error || "новая сессия не приняла handoff");
    const result: CacheHandoffResult = sent.admitted && sent.nonRetryable
      ? {
          kind: "admitted_failed",
          session: created,
          admittedFailure: sent.error || "Native handoff turn failed after admission",
          ageMs,
          cache,
        }
      : { kind: "rolled_over", session: created, ...(sent.pending ? { deliveryPending: true } : {}), ageMs, cache };
    // Admission is the idempotency boundary. Remember the replacement before
    // pin/lineage side effects so their failure cannot create or send another handoff.
    if (sent.admitted || sent.pending) this.admittedResults.set(sourceKey, result);
    await this.lineage?.record({
      ...admissionRecord,
      ...(sent.admitted && sent.nonRetryable ? { lastError: result.admittedFailure } : {}),
      cacheHandoffAdmission: sent.admitted && sent.nonRetryable
        ? { state: "failed", session: created, operationId, prompt, error: result.admittedFailure }
        : sent.pending
          ? { state: "pending", session: created, operationId, prompt }
          : { state: "confirmed", session: created, operationId, prompt },
      updatedAt: new Date().toISOString(),
    });
    if (options.movePinned) await movePinnedContinuation(adapter, [{ adapter, sessionId: session.id }], created.id);
    return result;
  }

  private async restoreDurableAdmission(
    sourceKey: string,
    ageMs: number,
    cache: CacheWindow,
    adapter: HarnessAdapter,
  ): Promise<DurableAdmissionRestore | undefined> {
    if (!this.lineage) return undefined;
    const records = (await this.lineage.children(sourceKey))
      .filter((record) => record.role === "cache-handoff" && record.cacheHandoffAdmission)
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt));
    const record = records[0];
    const admission = record?.cacheHandoffAdmission;
    if (!admission) return undefined;
    if (admission.state === "prepared") {
      const reconciled = await this.reconcilePreparedAdmission(adapter, admission);
      if (reconciled.state === "not_found") return { kind: "retry", record: record!, admission };
      if (reconciled.state === "unknown") {
        throw new Error(`Cache handoff admission cannot be reconciled safely yet: ${reconciled.error || "native state unavailable"}`);
      }
      const failed = reconciled.state === "failed";
      const updatedAdmission: CacheHandoffAdmissionCheckpoint = {
        ...admission,
        state: failed ? "failed" : "pending",
        ...(reconciled.error ? { error: reconciled.error } : {}),
      };
      await this.lineage!.record({
        ...record!,
        ...(failed ? { lastError: reconciled.error || "Native handoff turn failed after admission" } : {}),
        cacheHandoffAdmission: updatedAdmission,
        updatedAt: new Date().toISOString(),
      });
      admission.state = updatedAdmission.state;
      admission.error = updatedAdmission.error;
    }
    if (admission.state === "failed") {
      return { kind: "result", result: {
        kind: "admitted_failed",
        session: admission.session,
        admittedFailure: admission.error || "Native handoff turn failed after admission",
        ageMs,
        cache,
      } };
    }
    return { kind: "result", result: {
      kind: "rolled_over",
      session: admission.session,
      ...(admission.state === "pending" ? { deliveryPending: true } : {}),
      ageMs,
      cache,
    } };
  }

  private async reconcilePreparedAdmission(
    adapter: HarnessAdapter,
    admission: CacheHandoffAdmissionCheckpoint,
  ): Promise<import("./types/index.js").MessageAdmissionResult> {
    if (adapter.getMessageAdmission) {
      const native = await adapter.getMessageAdmission(admission.session.id, admission.operationId, admission.session.cwd);
      if (native.state !== "unknown") return native;
    }
    const messages = await adapter.getSessionMessages?.(admission.session.id, 100);
    if (messages === null || messages === undefined) return { state: "unknown", error: "replacement transcript unavailable" };
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.some((message) => messageText(message) === admission.prompt)) return { state: "admitted" };
    if (userMessages.length === 0) return { state: "not_found" };
    return { state: "unknown", error: "replacement contains different user input" };
  }
}

export class FastAgentMiniMaxSummarizer implements SessionSummarizer {
  constructor(
    private readonly bin = process.env.FAST_AGENT_BIN || join(homedir(), ".local/bin/fast-agent"),
    private readonly home = process.env.FAST_AGENT_HOME || join(homedir(), ".fast-agent"),
    private readonly model = process.env.AGENT_HERDER_HANDOFF_MODEL || DEFAULT_MINIMAX_MODEL,
    private readonly timeoutMs = Number(process.env.AGENT_HERDER_HANDOFF_TIMEOUT_MS || 180_000),
  ) {}

  async summarize(source: string): Promise<string> {
    const root = join(tmpdir(), `agent-herder-handoff-${randomUUID()}`);
    const results = join(root, "result.json");
    const promptPath = join(root, "prompt.txt");
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const prompt = [
        "Ты сжимаешь протухшую сессию разработки для новой frontier-модели.",
        "Верни только короткий русский handoff: цель, уже сделано, решения, важные файлы/команды, проверки, незавершённое, риски, следующий шаг.",
        "Не пересказывай ход рассуждений. Не добавляй факты. Не выполняй задачу. Tool calls уже удалены.",
        "\nСЕССИЯ:\n", source,
      ].join("\n");
      await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
      await runProcess(this.bin, [
        "go", "--name", "agent-herder-cache-handoff", "--home", this.home,
        "--workspace", root, "--model", this.model, "--no-shell", "--no-subagents",
        "--quiet", "--results", results, "--prompt-file", promptPath,
      ], root, this.timeoutMs);
      return extractLastAssistant(JSON.parse(await readFile(results, "utf8")) as unknown).slice(0, MAX_SUMMARY_CHARS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function handoffPrompt(summary: string): string {
  return [
    "Это новая сессия, созданная после истечения провайдерского prompt cache старой сессии.",
    "Ниже — семантический handoff, подготовленный MiniMax без tool calls и скрытых рассуждений.",
    "Проверь текущее состояние файлов и продолжи незавершённую работу; не повторяй уже подтверждённое.",
    "\n--- HANDOFF ---\n", summary,
  ].join("\n");
}

function stripReasoning(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
}

function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[СЕКРЕТ УДАЛЁН]")
    .replace(/\b(?:Bearer\s+)?(?:sk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gi, "[СЕКРЕТ УДАЛЁН]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]{8,})/gi, "$1=[СЕКРЕТ УДАЛЁН]");
}

function parseOverrides(value: string | undefined): Record<string, number> {
  if (!value) return {};
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).flatMap(([key, minutes]) =>
      typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? [[key, minutes]] : []));
  } catch {
    return {};
  }
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function extractLastAssistant(value: unknown): string {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (object.role === "assistant") {
      if (typeof object.content === "string") found.push(stripReasoning(object.content));
      if (Array.isArray(object.content)) for (const part of object.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string") {
          found.push(stripReasoning((part as Record<string, unknown>).text as string));
        }
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return found.filter(Boolean).at(-1) || "";
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    const child = spawnIsolatedWorkload("/usr/bin/timeout", ["--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`, command, ...args], {
      label: "cache-handoff", cwd, stdio: ["ignore", "ignore", "pipe"], env: process.env,
      resourceProperties: ["MemoryMax=1G", "MemorySwapMax=256M", "CPUQuota=200%", "TasksMax=128"],
    });
    let stderr = "";
    let forcedTimeout = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    const timer = setTimeout(() => {
      forcedTimeout = true;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 5_000);
    }, timeoutMs + 10_000);
    child.once("error", (error) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forcedTimeout || code === 124 || code === 137) reject(new Error("MiniMax handoff превысил лимит времени"));
      else code === 0 ? resolve() : reject(new Error(stderr.trim() || `fast-agent завершился с кодом ${code}`));
    });
  });
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}
