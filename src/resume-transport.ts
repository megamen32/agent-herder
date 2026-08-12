import { spawn } from "node:child_process";

export type ResumeAgent = "codex" | "opencode" | "claude" | "hermes";

/** Immutable Gateway address selected by the upstream Hermes/session converter. */
export interface HermesResumeLocator {
  readonly schema: "hermes.locator.v2";
  /** Exact existing Gateway session key; never a discovery hint. */
  readonly session_key: string;
  readonly platform: string;
  readonly chat_id: string;
  readonly chat_type: "dm" | "group" | "channel" | "thread" | "webhook";
  readonly thread_id?: string;
  readonly user_id?: string;
  readonly user_id_alt?: string;
  readonly scope_id?: string;
  readonly prospective_thread_id?: string;
  readonly profile?: string;
}

/** The target has already been selected by Agent Herder; this port never discovers one. */
export interface SelectedLocalResumeTarget {
  readonly agent: Exclude<ResumeAgent, "hermes">;
  readonly session_id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly marker?: string;
}

export interface SelectedHermesResumeTarget {
  readonly agent: "hermes";
  /** Required and forwarded as-is to agent-resume's Hermes adapter. */
  readonly locator: HermesResumeLocator;
}

export type SelectedResumeTarget = SelectedLocalResumeTarget | SelectedHermesResumeTarget;

export interface ResumeTransportRequest {
  readonly target: SelectedResumeTarget;
  /** Provider-owned opaque reference. It is forwarded, never interpreted. */
  readonly result_ref: string;
  /** The saved timeout goal, bound into the provider receipt fingerprint. */
  readonly goal?: string;
  /** The exact prompt sent to the resumed target. */
  readonly prompt?: string;
  /** Stable choice-bound retry key. */
  readonly idempotency_key?: string;
}

export type ResumeReceipt =
  | {
      readonly status: "accepted";
      readonly target: SelectedResumeTarget;
      readonly result_ref: string;
      readonly receipt_ref?: string;
      readonly idempotency_key?: string;
    }
  | {
      readonly status: "failed" | "rejected" | "ambiguous";
      readonly target: SelectedResumeTarget;
      readonly result_ref: string;
      readonly reason: string;
      readonly idempotency_key?: string;
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
  readonly query?: (request: ResumeTransportRequest) => Promise<unknown>;
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
  private readonly queryOverride?: (request: ResumeTransportRequest) => Promise<unknown>;
  private readonly script: string;

  constructor(options: AgentResumeClientOptions = {}) {
    this.command = options.command ?? process.env.AGENT_RESUME_PYTHON ?? "python3";
    this.script = process.env.AGENT_RESUME_SCRIPT ?? "agent_resume.py";
    this.args = options.args ?? [this.script, "resume_bound_target"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.invokeOverride = options.invoke;
    this.queryOverride = options.query;
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

  /** Read the durable receipt for a choice key without launching the target. */
  async queryReceipt(input: ResumeTransportRequest): Promise<ResumeReceipt> {
    const request = freezeRequest(input);
    if (!request.idempotency_key) throw new TypeError("idempotency_key is required for receipt queries");
    const raw = this.queryOverride
      ? await this.queryOverride(request)
      : await runEntrypoint(this.command, [this.script, "query_resume_receipt", "--idempotency-key", request.idempotency_key], request, this.timeoutMs, false);
    if (typeof raw === "object" && raw !== null && "code" in raw && (raw as ProcessResult).code !== 0) {
      throw new Error(`agent-resume receipt query exited with code ${(raw as ProcessResult).code}`);
    }
    const receiptInput = typeof raw === "object" && raw !== null && "stdout" in raw ? (raw as ProcessResult).stdout : raw;
    return parseReceipt(receiptInput, request);
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
  if (!["codex", "opencode", "claude", "hermes"].includes(target.agent)) throw new TypeError("unsupported resume agent");
  if (target.agent === "hermes") {
    validateHermesLocator(target.locator);
  } else {
    for (const field of ["session_id", "cwd"] as const) {
      if (typeof target[field] !== "string" || target[field].trim() === "") throw new TypeError(`target.${field} is required`);
    }
  }
  if (typeof input.result_ref !== "string" || input.result_ref.trim() === "") throw new TypeError("result_ref is required");
  for (const field of ["goal", "prompt", "idempotency_key"] as const) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || input[field].trim() === "")) throw new TypeError(`${field} must be non-empty when provided`);
  }
  const frozenTarget: SelectedResumeTarget = target.agent === "hermes"
    ? { agent: "hermes", locator: freezeHermesLocator(target.locator) }
    : {
        agent: target.agent,
        session_id: target.session_id,
        cwd: target.cwd,
        ...(target.model === undefined ? {} : { model: target.model }),
        ...(target.marker === undefined ? {} : { marker: target.marker }),
      };
  const copy: ResumeTransportRequest = {
    target: frozenTarget,
    result_ref: input.result_ref,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }),
  };
  Object.freeze(copy.target);
  return Object.freeze(copy);
}

function parseReceipt(raw: unknown, request: ResumeTransportRequest): ResumeReceipt {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return ambiguousReceipt(request, "receipt_malformed");
  const receipt = value as Record<string, unknown>;
  if (receipt.status === "accepted") {
    const mismatch = receiptBindingMismatch(receipt, request);
    if (mismatch) return ambiguousReceipt(request, mismatch);
    const receiptRef = typeof receipt.receipt_ref === "string" ? receipt.receipt_ref : typeof receipt.receipt_id === "string" ? receipt.receipt_id : undefined;
    if (!receiptRef) return ambiguousReceipt(request, "receipt_reference_missing");
    return {
      status: "accepted",
      target: request.target,
      result_ref: request.result_ref,
      receipt_ref: receiptRef,
      ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }),
    };
  }
  if (receipt.status === "failed" || receipt.status === "rejected" || receipt.status === "ambiguous") {
    const mismatch = receiptBindingMismatch(receipt, request);
    if (mismatch) return ambiguousReceipt(request, mismatch);
    return {
      status: receipt.status,
      target: request.target,
      result_ref: request.result_ref,
      reason: typeof receipt.reason === "string" ? receipt.reason : "failed",
      ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }),
    };
  }
  return ambiguousReceipt(request, "receipt_status_unsupported");
}

/** Return the exact immutable binding mismatch without downgrading it to a provider rejection. */
function receiptBindingMismatch(receipt: Record<string, unknown>, request: ResumeTransportRequest): string | undefined {
  if (!sameTarget(receipt.target, request.target)) return "receipt_target_mismatch";
  if (receipt.result_ref !== request.result_ref) return "receipt_result_ref_mismatch";
  if (request.idempotency_key !== undefined && receipt.idempotency_key !== request.idempotency_key) return "receipt_idempotency_key_mismatch";
  return undefined;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function sameTarget(value: unknown, target: SelectedResumeTarget): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.agent !== target.agent) return false;
  if (target.agent === "hermes") {
    return sameLocator(candidate.locator, target.locator);
  }
  return candidate.session_id === target.session_id && candidate.cwd === target.cwd
    && optionalProviderMetadataMatches(candidate.model, target.model)
    && optionalProviderMetadataMatches(candidate.marker, target.marker);
}

/** Permit provider-added normalized metadata only when the caller did not bind that field. */
function optionalProviderMetadataMatches(value: unknown, requested: string | undefined): boolean {
  if (value !== undefined && value !== null && typeof value !== "string") return false;
  return requested === undefined || (value ?? undefined) === requested;
}

function validateHermesLocator(value: unknown): asserts value is HermesResumeLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("target.locator is required for Hermes");
  const locator = value as Record<string, unknown>;
  if (locator.schema !== "hermes.locator.v2") throw new TypeError("target.locator.schema must be hermes.locator.v2");
  for (const field of ["session_key", "platform", "chat_id", "chat_type"] as const) {
    if (typeof locator[field] !== "string" || locator[field].trim() === "") throw new TypeError(`target.locator.${field} is required`);
  }
  if (!["dm", "group", "channel", "thread", "webhook"].includes(locator.chat_type as string)) throw new TypeError("target.locator.chat_type is unsupported");
  for (const field of ["thread_id", "user_id", "user_id_alt", "scope_id", "prospective_thread_id", "profile"] as const) {
    if (locator[field] !== undefined && (typeof locator[field] !== "string" || locator[field].trim() === "")) {
      throw new TypeError(`target.locator.${field} must be a non-empty string when provided`);
    }
  }
}

function freezeHermesLocator(locator: HermesResumeLocator): HermesResumeLocator {
  return Object.freeze({
    schema: "hermes.locator.v2",
    session_key: locator.session_key,
    platform: locator.platform,
    chat_id: locator.chat_id,
    chat_type: locator.chat_type,
    ...(locator.thread_id === undefined ? {} : { thread_id: locator.thread_id }),
    ...(locator.user_id === undefined ? {} : { user_id: locator.user_id }),
    ...(locator.user_id_alt === undefined ? {} : { user_id_alt: locator.user_id_alt }),
    ...(locator.scope_id === undefined ? {} : { scope_id: locator.scope_id }),
    ...(locator.prospective_thread_id === undefined ? {} : { prospective_thread_id: locator.prospective_thread_id }),
    ...(locator.profile === undefined ? {} : { profile: locator.profile }),
  });
}

function sameLocator(value: unknown, target: HermesResumeLocator | undefined): boolean {
  if (target === undefined) return value === undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === target.schema && candidate.session_key === target.session_key
    && candidate.platform === target.platform && candidate.chat_id === target.chat_id && candidate.chat_type === target.chat_type
    && (candidate.thread_id ?? undefined) === target.thread_id
    && (candidate.user_id ?? undefined) === target.user_id
    && (candidate.user_id_alt ?? undefined) === target.user_id_alt
    && (candidate.scope_id ?? undefined) === target.scope_id
    && (candidate.prospective_thread_id ?? undefined) === target.prospective_thread_id
    && (candidate.profile ?? undefined) === target.profile;
}

function failed(request: ResumeTransportRequest, reason: ResumeFailureReason, _detail?: string): ResumeReceipt {
  return { status: "failed", target: request.target, result_ref: request.result_ref, reason, ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }) };
}

/** Preserve a malformed or mismatched provider receipt for human recovery rather than treating it as a rejection. */
function ambiguousReceipt(request: ResumeTransportRequest, reason: string): ResumeReceipt {
  return { status: "ambiguous", target: request.target, result_ref: request.result_ref, reason, ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }) };
}

async function runEntrypoint(command: string, args: readonly string[], request: ResumeTransportRequest, timeoutMs: number, includeRequestArgs = true): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const prompt = request.prompt ?? request.goal ?? `Human Request resolved: ${request.result_ref}`;
    const childArgs = includeRequestArgs
      ? [...args, "--target", JSON.stringify(request.target), "--prompt", prompt, ...(request.goal ? ["--goal", request.goal] : []), "--result-ref", request.result_ref, ...(request.idempotency_key ? ["--idempotency-key", request.idempotency_key] : []), "--execute"]
      : [...args];
    const child = spawn(command, childArgs, { stdio: ["ignore", "pipe", "ignore"] });
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
