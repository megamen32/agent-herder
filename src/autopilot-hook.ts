#!/usr/bin/env node
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAutopilotCore,
  createNoticePlaceSink,
  createOpenAICompatibleJudge,
  loadReceiptStore,
  persistReceiptStore,
  type ReceiptStore,
  type StopHookInput,
} from "./autopilot/index.js";
import { ChoiceRegistry } from "./autopilot/choice-registry.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./autopilot/policy-store.js";
import { resolveEffectivePolicy } from "./autopilot/policy.js";

const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 25;
const STALE_LOCK_MS = 120_000;

export type LockAcquireOptions = {
  waitMs?: number;
  retryIntervalMs?: number;
  staleMs?: number;
};

export type AutopilotHookDeps = {
  judge: Parameters<typeof createAutopilotCore>[0]["judge"];
  notify: Parameters<typeof createAutopilotCore>[0]["notify"];
  allowSessions: ReadonlySet<string>;
  allowAllSessions?: boolean;
  receiptStore: ReceiptStore;
  maxContinuationsPerSession: number;
  notification?: Parameters<typeof createAutopilotCore>[0]["notification"];
  choiceRegistry?: ChoiceRegistry;
  effectivePolicy?: Parameters<typeof createAutopilotCore>[0]["effectivePolicy"];
};

export async function runAutopilotStopHook(
  input: StopHookInput,
  deps: AutopilotHookDeps,
) {
  const core = createAutopilotCore(deps);
  return core.handleStop(input);
}

/** Load the effective policy from the same configured store path used by the web service. */
export async function loadEffectivePolicyForStopHook(
  stateDir: string,
  legacySessionIds: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const loadedPolicy = await new AutopilotPolicyStore(
    resolveAutopilotPolicyStorePath(stateDir, env),
  ).load();
  return resolveEffectivePolicy({
    env,
    legacySessionIds,
    ...(loadedPolicy.kind === "valid" ? { state: loadedPolicy.state } : {}),
    ...(loadedPolicy.kind === "invalid" ? { stateError: loadedPolicy.error } : {}),
  });
}

async function main(): Promise<void> {
  const stateDir = defaultStateDir();
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    writeHelp();
    return;
  }
  if (args[0] === "--arm-session") {
    const sessionId = args[1]?.trim();
    if (!sessionId || args.length !== 2) {
      throw new Error("Usage: agent-herder-autopilot-hook --arm-session SESSION_ID");
    }
    await armSession(stateDir, sessionId);
    process.stdout.write(`${JSON.stringify({ armed_session_id: sessionId })}\n`);
    return;
  }
  if (args.length > 0) {
    writeResult({});
    return;
  }

  const input = await readJsonFromStdin();
  if (!isStopHookInput(input)) {
    writeResult({});
    return;
  }

  const allowSessions = await loadArmedSessions(stateDir);
  const effectivePolicy = await loadEffectivePolicyForStopHook(stateDir, allowSessions);

  const receiptPath = join(stateDir, "receipts.json");
  // One lock protects the shared receipt file. A per-turn lock would allow
  // concurrent turns to overwrite each other's state during read/modify/write.
  const lockPath = join(stateDir, "state.lock");
  const release = await acquireLock(lockPath);
  if (!release) {
    writeResult({});
    return;
  }

  try {
    const judge = buildJudge();
    const notify = buildNotificationSink();
    const receiptStore = await loadReceiptStore(receiptPath);
    const result = await runAutopilotStopHook(input, {
      judge,
      notify,
      allowSessions,
      allowAllSessions: isAllSessionsOptIn(),
      effectivePolicy,
      receiptStore,
      maxContinuationsPerSession: readPositiveInteger(
        process.env.AGENT_HERDER_AUTOPILOT_MAX_CONTINUATIONS,
        3,
      ),
    notification: {
        project: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT ?? "agent-herder",
        // The sink validates this only if a terminal decision actually emits
        // a notice. `continue` should not require a delivery configuration.
        recipient: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT ?? "",
        kind: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_KIND ?? "notification",
      },
      choiceRegistry: new ChoiceRegistry(join(stateDir, "choices.json")),
    });
    await persistReceiptStore(receiptPath, receiptStore);
    writeResult(result);
  } finally {
    await release();
  }
}

function buildJudge() {
  return createOpenAICompatibleJudge({
    baseUrl: requiredEnv(
      "AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL",
      "Autopilot judge endpoint is not configured",
    ),
    model: requiredEnv(
      "AGENT_HERDER_AUTOPILOT_JUDGE_MODEL",
      "Autopilot judge model is not configured",
    ),
    token:
      process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN ??
      process.env.OPENAI_API_KEY,
  });
}

function buildNotificationSink() {
  return {
    async send(payload: Parameters<ReturnType<typeof createNoticePlaceSink>["send"]>[0]) {
      // Keep the exact recipient an explicit live gate. An empty/default
      // recipient must never become an outbound NoticePlace request.
      requiredEnv(
        "AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT",
        "Notification recipient is not configured",
      );
      return createNoticePlaceSink({
        eventUrl: requiredEnv(
          "NOTIFY_CENTER_EVENT_URL",
          "Notify event endpoint is not configured",
        ),
        token: requiredEnv("NOTIFY_CENTER_TOKEN", "Notify token is not configured"),
      }).send(payload);
    },
  };
}

function defaultStateDir(): string {
  return (
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR ??
    join(homedir(), ".local", "state", "agent-herder", "autopilot")
  );
}

export function isAllSessionsOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_HERDER_AUTOPILOT_ALL_SESSIONS === "1";
}

async function loadArmedSessions(stateDir: string): Promise<Set<string>> {
  const inline = process.env.AGENT_HERDER_AUTOPILOT_SESSION_ID;
  if (inline) {
    return new Set(inline.split(",").map((value) => value.trim()).filter(Boolean));
  }

  const armFile =
    process.env.AGENT_HERDER_AUTOPILOT_ARM_FILE ??
    join(stateDir, "armed-sessions.json");
  return readArmFile(armFile);
}

async function readArmFile(armFile: string): Promise<Set<string>> {
  try {
    const raw = (await readFile(armFile, "utf8")).trim();
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((value): value is string => typeof value === "string"));
      }
    } catch {
      // A newline-separated arm file is intentionally supported for simple
      // local operation and does not require a mutable JSON writer.
    }
    return new Set(raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function armSession(stateDir: string, sessionId: string): Promise<void> {
  const armFile =
    process.env.AGENT_HERDER_AUTOPILOT_ARM_FILE ??
    join(stateDir, "armed-sessions.json");
  const release = await acquireLock(join(stateDir, "arm.lock"));
  if (!release) throw new Error("Another Agent Herder arm operation is in progress");
  try {
    const existing = await readArmFile(armFile);
    if (existing.size > 0 && !(existing.size === 1 && existing.has(sessionId))) {
      throw new Error("Another Agent Herder autopilot session is already armed");
    }

    await mkdir(dirname(armFile), { recursive: true });
    const temporaryPath = `${armFile}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify([sessionId], null, 2), "utf8");
    await rename(temporaryPath, armFile);
  } finally {
    await release();
  }
}

function writeHelp(): void {
  process.stdout.write(
    [
      "Agent Herder Codex Stop-hook",
      "",
      "Hook mode: read one Codex Stop JSON object from stdin and emit Codex JSON on stdout.",
      "Arm exactly one session: agent-herder-autopilot-hook --arm-session SESSION_ID",
      "",
      "Environment:",
      "  AGENT_HERDER_AUTOPILOT_STATE_DIR       receipt/arm state directory",
      "  AGENT_HERDER_AUTOPILOT_SESSION_ID       inline session arm",
      "  AGENT_HERDER_AUTOPILOT_ARM_FILE         newline/JSON-array arm file",
      "  AGENT_HERDER_AUTOPILOT_ALL_SESSIONS     process every session only when set to 1",
      "  AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL   OpenAI-compatible /chat/completions base",
      "  AGENT_HERDER_AUTOPILOT_JUDGE_MODEL      structured judge model",
      "  NOTIFY_CENTER_EVENT_URL / TOKEN         NoticePlace producer credentials",
      "  AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT  exact Notify recipient",
      "",
      "No hook is installed or trusted by this command.",
      "",
    ].join("\n"),
  );
}

function isStopHookInput(value: unknown): value is StopHookInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<StopHookInput>;
  return (
    input.hook_event_name === "Stop" &&
    typeof input.session_id === "string" &&
    typeof input.cwd === "string" &&
    typeof input.turn_id === "string" &&
    (typeof input.last_assistant_message === "string" ||
      input.last_assistant_message === null) &&
    (typeof input.transcript_path === "string" || input.transcript_path === null) &&
    typeof input.stop_hook_active === "boolean"
  );
}

function requiredEnv(name: string, message: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function acquireLock(
  path: string,
  options: LockAcquireOptions = {},
): Promise<(() => Promise<void>) | null> {
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  const retryIntervalMs = Math.max(
    1,
    options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS,
  );
  const staleMs = Math.max(0, options.staleMs ?? STALE_LOCK_MS);
  const deadline = Date.now() + waitMs;

  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await stat(path).catch(() => null);
      if (existing && Date.now() - existing.mtimeMs > staleMs) {
        try {
          await unlink(path);
        } catch {
          // The owner may have released the stale lock between stat/unlink.
        }
      }

      if (Date.now() >= deadline) return null;
      const delayMs = Math.min(retryIntervalMs, deadline - Date.now());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(1, delayMs));
      });
    }
  }

  return async () => {
    await unlink(path).catch(() => undefined);
  };
}

async function readJsonFromStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Autopilot hook failed";
    process.stderr.write(`${message}\n`);
    // A hook configuration error must not turn an unrelated Codex stop into
    // a forced continuation. The next invocation can retry after repair.
    writeResult({});
  });
}
