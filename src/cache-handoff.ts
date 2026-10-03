import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "./types/index.js";
import type { LineageStore } from "./lineage-store.js";
import { spawnIsolatedWorkload } from "./workload-launcher.js";

const MAX_SOURCE_CHARS = 120_000;
const MAX_SUMMARY_CHARS = 16_000;
const DEFAULT_MINIMAX_MODEL = "generic.minimax/MiniMax-M3.1-Flash-Preview";

export interface CacheWindow {
  ttlMs?: number;
  source: "openai-30m" | "zai-measured-5m" | "minimax-dynamic-5m" | "configured" | "unknown";
}

export interface CacheHandoffResult {
  kind: "fresh" | "unknown" | "rolled_over";
  session?: AgentSession;
  ageMs: number;
  cache: CacheWindow;
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

export class CacheHandoffService {
  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly summarizer: SessionSummarizer,
    private readonly lineage?: LineageStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async maybeRollover(session: AgentSession, now = new Date()): Promise<CacheHandoffResult> {
    const ageMs = Math.max(0, now.getTime() - Date.parse(session.lastActivity));
    const cache = cacheWindowFor(session, this.env);
    if (!cache.ttlMs) return { kind: "unknown", ageMs, cache };
    if (ageMs < cache.ttlMs) return { kind: "fresh", ageMs, cache };
    const adapter = this.adapters.get(session.harness);
    if (!adapter?.getSessionMessages || !adapter.createSession) throw new Error(`${session.harness} не умеет создать cache handoff`);
    const messages = await adapter.getSessionMessages(session.id, 1_000);
    const source = semanticTranscript(messages || []);
    if (!source) throw new Error("в сессии нет пользовательского контекста для handoff");
    const summary = (await this.summarizer.summarize(source)).trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) throw new Error("MiniMax вернул пустой handoff");
    const continuationModel = continuationModelFor(session);
    const created = await adapter.createSession({
      name: `${session.title.slice(0, 180)} · продолжение`, cwd: session.cwd, model: continuationModel,
    });
    if (continuationModel && (session.harness === "opencode" || created.model !== continuationModel)) {
      if (!adapter.changeModel) throw new Error(`${session.harness} создал handoff без модели продолжения ${continuationModel}`);
      const selected = await adapter.changeModel(created.id, continuationModel);
      if (!selected.ok) throw new Error(selected.error || `не удалось выбрать модель продолжения ${continuationModel}`);
    }
    const sent = await adapter.sendMessage(created.id, { message: handoffPrompt(summary), queue: false });
    if (!sent.ok) throw new Error(sent.error || "новая сессия не приняла handoff");
    await this.lineage?.record({
      sessionKey: `${session.harness}:${created.id}`,
      parentKey: `${session.harness}:${session.id}`,
      role: "cache-handoff",
      task: `Продолжение после истечения кэша (${Math.round(ageMs / 60_000)} мин)`,
      provider: session.harness,
      createdAt: new Date().toISOString(),
      source: "supervisor",
    });
    return { kind: "rolled_over", session: created, ageMs, cache };
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
