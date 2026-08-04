import { spawn } from "node:child_process";

export type ResumeAgent = "codex" | "opencode" | "claude";

/** The target has already been selected by Agent Herder; this port never discovers one. */
export interface SelectedResumeTarget {
  readonly agent: ResumeAgent;
  readonly session_id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly marker?: string;
}

export interface ResumeTransportRequest {
  readonly target: SelectedResumeTarget;
  /** Provider-owned opaque reference. It is forwarded, never interpreted. */
  readonly result_ref: string;
}

export type ResumeReceipt =
  | {
      readonly status: "accepted";
      readonly target: SelectedResumeTarget;
      readonly result_ref: string;
      readonly receipt_ref?: string;
    }
  | {
      readonly status: "failed";
      readonly target: SelectedResumeTarget;
      readonly result_ref: string;
      readonly reason: "unavailable" | "unsupported" | "invalid" | "failed";
    };

type ResumeFailureReason = "unavailable" | "unsupported" | "invalid" | "failed";

export interface ResumeTransport {
  resume(request: ResumeTransportRequest): Promise<ResumeReceipt>;
}

export interface AgentResumeClientOptions {
  /** Override the machine entrypoint for tests or an installed agent-resume package. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly invoke?: (request: ResumeTransportRequest) => Promise<unknown>;
}

type ProcessResult = { stdout: string; code: number | null };

/**
 * Agent Herder's narrow client for agent-resume.
 *
 * The default command is the standalone machine-facing Python entrypoint. The
 * injected invoke hook is deliberately at the process boundary, so tests and
 * callers cannot accidentally route through a HarnessAdapter.
 */
export class AgentResumeClient implements ResumeTransport {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly invokeOverride?: (request: ResumeTransportRequest) => Promise<unknown>;

  constructor(options: AgentResumeClientOptions = {}) {
    this.command = options.command ?? process.env.AGENT_RESUME_PYTHON ?? "python3";
    this.args = options.args ?? [process.env.AGENT_RESUME_SCRIPT ?? "agent_resume.py", "resume_bound_target"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.invokeOverride = options.invoke;
  }

  async resume(input: ResumeTransportRequest): Promise<ResumeReceipt> {
    const request = freezeRequest(input);
    try {
      const raw = this.invokeOverride
        ? await this.invokeOverride(request)
        : await runEntrypoint(this.command, this.args, request, this.timeoutMs);
      if (typeof raw === "object" && raw !== null && "code" in raw && (raw as ProcessResult).code !== 0) {
        throw new Error(`agent-resume exited with code ${(raw as ProcessResult).code}`);
      }
      const receiptInput = typeof raw === "object" && raw !== null && "stdout" in raw ? (raw as ProcessResult).stdout : raw;
      return parseReceipt(receiptInput, request);
    } catch (error) {
      return failed(request, "unavailable", error instanceof Error ? error.message : "agent-resume unavailable");
    }
  }
}

/** Functional integration hook for the resume state machine. */
export async function resumeBoundTarget(
  request: ResumeTransportRequest,
  transport: ResumeTransport = new AgentResumeClient(),
): Promise<ResumeReceipt> {
  return transport.resume(request);
}

function freezeRequest(input: ResumeTransportRequest): ResumeTransportRequest {
  if (!input || typeof input !== "object") throw new TypeError("resume request is required");
  const target = input.target;
  if (!target || typeof target !== "object") throw new TypeError("resume target is required");
  if (!["codex", "opencode", "claude"].includes(target.agent)) throw new TypeError("unsupported resume agent");
  for (const field of ["session_id", "cwd"] as const) {
    if (typeof target[field] !== "string" || target[field].trim() === "") throw new TypeError(`target.${field} is required`);
  }
  if (typeof input.result_ref !== "string" || input.result_ref.trim() === "") throw new TypeError("result_ref is required");
  const copy: ResumeTransportRequest = {
    target: {
      agent: target.agent,
      session_id: target.session_id,
      cwd: target.cwd,
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.marker === undefined ? {} : { marker: target.marker }),
    },
    result_ref: input.result_ref,
  };
  Object.freeze(copy.target);
  return Object.freeze(copy);
}

function parseReceipt(raw: unknown, request: ResumeTransportRequest): ResumeReceipt {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return failed(request, "unsupported");
  const receipt = value as Record<string, unknown>;
  if (receipt.status === "accepted") {
    if (!sameTarget(receipt.target, request.target) || receipt.result_ref !== request.result_ref) return failed(request, "unsupported");
    const receiptRef = typeof receipt.receipt_ref === "string" ? receipt.receipt_ref : typeof receipt.receipt_id === "string" ? receipt.receipt_id : undefined;
    if (!receiptRef) return failed(request, "unsupported");
    return {
      status: "accepted",
      target: request.target,
      result_ref: request.result_ref,
      receipt_ref: receiptRef,
    };
  }
  if (receipt.status === "failed") {
    if (!sameTarget(receipt.target, request.target) || receipt.result_ref !== request.result_ref) return failed(request, "unsupported");
    const reason = receipt.reason;
    return {
      status: "failed",
      target: request.target,
      result_ref: request.result_ref,
      reason: reason === "unavailable" || reason === "unsupported" || reason === "invalid" || reason === "failed" ? reason : "failed",
    };
  }
  return failed(request, "unsupported");
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function sameTarget(value: unknown, target: SelectedResumeTarget): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.agent === target.agent && candidate.session_id === target.session_id && candidate.cwd === target.cwd
    && (candidate.model ?? undefined) === target.model && (candidate.marker ?? undefined) === target.marker;
}

function failed(request: ResumeTransportRequest, reason: ResumeFailureReason, _detail?: string): ResumeReceipt {
  return { status: "failed", target: request.target, result_ref: request.result_ref, reason };
}

async function runEntrypoint(command: string, args: readonly string[], request: ResumeTransportRequest, timeoutMs: number): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const prompt = `Human Request resolved: ${request.result_ref}`;
    const child = spawn(command, [...args, "--target", JSON.stringify(request.target), "--prompt", prompt, "--result-ref", request.result_ref, "--execute"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("agent-resume entrypoint timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once("close", (code) => { clearTimeout(timer); if (!settled) { settled = true; resolve({ stdout, code }); } });
  });
}
