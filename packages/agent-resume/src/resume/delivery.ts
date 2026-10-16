import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  ReceiptLedger,
  receiptFingerprint,
  validateIdempotencyKey,
  type BoundTarget,
  type ResumeReceiptRecord,
} from "./receipts.js";
import { OpenCodeClient } from "../harness/opencode/client.js";
import type { HarnessKind } from "../harness/client.js";

/**
 * Bound delivery: admit one goal into one already-selected native session.
 *
 * This entrypoint never discovers a session and never falls back to a "last"
 * session — the orchestrator that owns correlation selects the target and passes
 * it whole. Every admission produces a durable receipt, and a repeated
 * idempotency key replays that receipt instead of delivering twice.
 */
export interface BoundTargetInput {
  agent?: string;
  harness?: string;
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  threadId?: string;
  cwd?: string;
  marker?: string | null;
  model?: string | null;
  use_last?: boolean;
}

export interface BoundDeliveryRequest {
  target: BoundTargetInput;
  prompt?: string | null;
  goal?: string | null;
  resultRef?: string;
  idempotencyKey?: string;
  execute?: boolean;
  admissionProof?: unknown;
}

export interface BoundDeliveryDeps {
  ledger: ReceiptLedger;
  /** Native in-process delivery; when it returns undefined the CLI is used. */
  nativeClient?: OpenCodeClient;
  logDir?: string;
  /** Injectable launcher for tests; defaults to a detached setsid launch. */
  launch?: (command: string[], options: { cwd: string; logFile: string }) => Promise<{ returncode: number; stdout: string; stderr: string; pid: number | null }>;
}

const run = promisify(execFile);

const supportedAgents = new Set(["codex", "opencode", "claude", "hermes"]);

/** Validate and canonicalise an immutable target without consulting any index. */
export function resolveBoundTarget(input: BoundTargetInput): BoundTarget {
  if (!input || typeof input !== "object") throw new Error("target must be an object");
  const agents: string[] = [];
  for (const alias of ["agent", "harness"] as const) {
    if (!(alias in input)) continue;
    const value = input[alias];
    if (typeof value !== "string" || !value.trim()) throw new Error(`target.${alias} must be a non-empty string when provided`);
    agents.push(value.trim());
  }
  if (agents.length === 0) throw new Error("target.agent is required");
  const firstAgent = agents[0];
  if (!firstAgent) throw new Error("target.agent is required");
  if (agents.some((value) => value !== firstAgent)) throw new Error("target agent aliases must agree");
  const agent: string = firstAgent;
  if (!supportedAgents.has(agent)) throw new Error(`unsupported target agent: ${agent}`);

  if (input.use_last) throw new Error("target.use_last is unsafe and disabled");
  const sessions: string[] = [];
  for (const alias of ["session_id", "sessionId", "thread_id", "threadId"] as const) {
    if (!(alias in input)) continue;
    const value = input[alias];
    if (typeof value !== "string" || !value.trim()) throw new Error(`target.${alias} must be a non-empty string when provided`);
    sessions.push(value.trim());
  }
  if (sessions.length === 0) throw new Error("target.session_id is required");
  const firstSession = sessions[0];
  if (!firstSession) throw new Error("target.session_id is required");
  if (sessions.some((value) => value !== firstSession)) throw new Error("target session aliases must agree");

  if (typeof input.cwd !== "string" || !input.cwd.trim()) throw new Error("target.cwd is required");
  if (!isAbsolute(input.cwd)) throw new Error("target.cwd must be absolute");
  const model = input.model ?? null;
  if (model !== null && (typeof model !== "string" || !model.trim())) throw new Error("target.model must be a non-empty string when provided");
  return {
    agent,
    session_id: firstSession,
    // Canonical path: an alias and its real path must produce one fingerprint.
    cwd: canonicalDirectory(input.cwd),
    marker: input.marker ?? null,
    model: typeof model === "string" ? model.trim() : null,
  };
}

function canonicalDirectory(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** The CLI a harness uses to resume one bound session. */
export function buildResumeCommand(target: BoundTarget, prompt: string, options: { useLast?: boolean } = {}): string[] {
  if (options.useLast) throw new Error("use_last is unsafe and disabled");
  switch (target.agent as HarnessKind) {
    case "codex": {
      const base = isWorktree(target.cwd) ? ["codex", "exec", "resume"] : ["codex", "exec", "--skip-git-repo-check", "resume"];
      return target.model ? [...base, "--model", target.model, target.session_id, prompt] : [...base, target.session_id, prompt];
    }
    case "opencode":
      return ["opencode", "run", "--session", target.session_id, "--", prompt];
    case "claude":
      return ["claude", "--print", "--resume", target.session_id, prompt];
    default:
      throw new Error(`unsupported target agent: ${target.agent}`);
  }
}

function isWorktree(cwd: string): boolean {
  try {
    return join(cwd, ".git").length > 0 && !join(cwd, ".git").endsWith("missing");
  } catch {
    return false;
  }
}

/**
 * Admit one goal exactly once and return its durable receipt.
 *
 * A rejection is also recorded: the answer for an idempotency key must not
 * change across a restart, or an orchestrator would keep retrying a target that
 * was already refused.
 */
export async function resumeBoundTarget(request: BoundDeliveryRequest, deps: BoundDeliveryDeps): Promise<ResumeReceiptRecord> {
  const receiptId = `resume-${randomUUID().replace(/-/g, "")}`;
  let target: BoundTarget | null = null;
  let prompt: string;
  let fingerprint: string;
  const resultRef = request.resultRef;
  try {
    target = resolveBoundTarget(request.target);
    const goal = request.goal ?? null;
    const explicit = request.prompt ?? null;
    prompt = explicit ?? goal ?? "";
    if (!prompt.trim()) throw new Error("prompt must be a non-empty string");
    if (typeof resultRef !== "string" || !resultRef.trim()) throw new Error("result_ref must be a non-empty opaque reference");
    const key = validateIdempotencyKey(request.idempotencyKey, { required: true });
    fingerprint = receiptFingerprint({ target, prompt, goal, idempotencyKey: key, resultRef });
  } catch (error) {
    return {
      receipt_id: receiptId,
      receipt_ref: receiptId,
      status: "rejected",
      reason: "invalid_request",
      target,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const key = validateIdempotencyKey(request.idempotencyKey, { required: true });
  return deps.ledger.admit({
    idempotencyKey: key,
    fingerprint,
    target,
    resultRef,
    execute: async () => {
      if (request.execute === false) {
        return { receipt_id: receiptId, receipt_ref: receiptId, result_ref: resultRef, status: "accepted", reason: "prepared", target, executed: false };
      }
      return deliver(target, prompt, { receiptId, resultRef, deps });
    },
  });
}

async function deliver(
  target: BoundTarget,
  prompt: string,
  context: { receiptId: string; resultRef: string; deps: BoundDeliveryDeps },
): Promise<ResumeReceiptRecord> {
  const base = {
    receipt_id: context.receiptId,
    receipt_ref: context.receiptId,
    result_ref: context.resultRef,
    target,
  };
  try {
    // A harness Herder can drive natively never needs a CLI process.
    if (target.agent === "opencode" && context.deps.nativeClient) {
      const native = await context.deps.nativeClient.send(target.session_id, { message: prompt, delivery: "queue" });
      if (!native.ok) {
        // The standalone CLI cannot address an OpenCode 2 session, so a refused
        // native admission is terminal here rather than a second, blind attempt.
        return { ...base, status: "failed", reason: "native_admission_refused", executed: true, ...(native.error ? { error: native.error } : {}) };
      }
      return { ...base, status: "accepted", reason: "prepared", executed: true, command: [], log_file: "" };
    }
    const command = buildResumeCommand(target, prompt);
    const logDir = context.deps.logDir ?? join(process.cwd(), "runs");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, "")}-${target.agent}.log`);
    const launch = context.deps.launch ?? detachedLaunch;
    const result = await launch(command, { cwd: target.cwd, logFile });
    if (result.returncode !== 0) {
      return { ...base, status: "failed", reason: "launch_failed", executed: true, command, log_file: logFile, pid: result.pid, error: result.stderr || result.stdout || "resume launch failed" };
    }
    return { ...base, status: "accepted", reason: "prepared", executed: true, command, log_file: logFile, pid: result.pid };
  } catch (error) {
    return { ...base, status: "failed", reason: "resume_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Detached launch that survives the orchestrator process. */
async function detachedLaunch(
  command: string[],
  options: { cwd: string; logFile: string },
): Promise<{ returncode: number; stdout: string; stderr: string; pid: number | null }> {
  const shell = `setsid ${command.map(quote).join(" ")} > ${quote(options.logFile)} 2>&1 < /dev/null & echo $!`;
  const result = await run("/bin/bash", ["-lc", shell], { cwd: options.cwd, timeout: 10_000 });
  const pid = Number(result.stdout.trim().split("\n").pop());
  return {
    returncode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    pid: Number.isFinite(pid) ? pid : null,
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}