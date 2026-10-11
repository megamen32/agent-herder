import type {
  HumanRequestRecord,
  ResumeAdmissionReceipt,
  ResumeClaimInput,
  ResumeCompletionInput,
} from "./registry.js";
import type { HermesResumeLocator, ResumeReceipt, ResumeTransportRequest, SelectedResumeTarget } from "../resume-transport.js";

export interface HumanRequestResumeDependencies {
  admitResume(requestId: string, input?: ResumeClaimInput): Promise<ResumeAdmissionReceipt>;
  completeResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord>;
  failResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord>;
}

export interface HumanRequestResumeInput {
  registry: HumanRequestResumeDependencies;
  requestId: string;
  /** Provider-owned opaque result reference of the answer. */
  resultRef: string;
  /** Opaque human-answer reference when the provider supplies a distinct one. */
  resolutionRef?: string;
  /** Invokes the bound native session. Only the admitted caller may call it. */
  resume: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  /** Reads the durable provider receipt for the same idempotency key without launching the session. */
  queryReceipt?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  prompt?: string;
  now?: Date;
}

export type HumanRequestResumeOutcome =
  | { status: "resumed"; record: HumanRequestRecord; idempotencyKey: string; duplicate: boolean }
  | { status: "resume_failed"; record: HumanRequestRecord; idempotencyKey: string; duplicate: boolean; receipt: string }
  | { status: "in_flight"; record: HumanRequestRecord; idempotencyKey: string; duplicate: true }
  | { status: "unsupported_target"; record: HumanRequestRecord; idempotencyKey: string; receipt: string; duplicate: boolean };

/**
 * The one admitted resume of a Human Request.
 *
 * Admission is decided by the durable registry, so concurrent answers, a
 * repeated provider callback and a service restart after a crash all resolve to
 * a single native resume: the admitted caller invokes the transport with the
 * stable idempotency key, and every other caller either reads the durable
 * provider receipt for that key or returns the in-flight state untouched.
 */
export async function resumeHumanRequestOnce(input: HumanRequestResumeInput): Promise<HumanRequestResumeOutcome> {
  const { registry, requestId, resultRef } = input;
  const admission = await registry.admitResume(requestId, {
    resultRef,
    ...(input.resolutionRef ? { resolutionRef: input.resolutionRef } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const record = admission.record;
  if (!admission.admitted) {
    if (record.status === "resumed") {
      return { status: "resumed", record, idempotencyKey: admission.idempotencyKey, duplicate: true };
    }
    if (record.status === "resume_failed") {
      return {
        status: "resume_failed",
        record,
        idempotencyKey: admission.idempotencyKey,
        duplicate: true,
        receipt: record.receipt ?? "resume-failed",
      };
    }
    const recovered = await readAdmittedReceipt(input, record, admission.idempotencyKey);
    return recovered ?? { status: "in_flight", record, idempotencyKey: admission.idempotencyKey, duplicate: true };
  }

  const target = humanRequestResumeTarget(record);
  if (!target) {
    const failed = await registry.failResume(requestId, { attemptId: record.attemptId!, receipt: "resume-target-unsupported" });
    return {
      status: "unsupported_target",
      record: failed,
      idempotencyKey: admission.idempotencyKey,
      receipt: "resume-target-unsupported",
      duplicate: admission.recovered,
    };
  }
  // The admitted answer is canonical. A replay or lease takeover delivers that
  // answer, never the conflicting reference that arrived with the repeat.
  const canonicalResultRef = record.resultRef ?? resultRef;
  const receipt = await input.resume({
    target,
    result_ref: canonicalResultRef,
    prompt: input.prompt ?? `Human Request resolved: ${canonicalResultRef}`,
    idempotency_key: admission.idempotencyKey,
    ...humanRequestedAt(record),
  });
  return receipt.status === "accepted"
    ? {
        status: "resumed",
        record: await registry.completeResume(requestId, { attemptId: record.attemptId!, receipt: receipt.receipt_ref }),
        idempotencyKey: admission.idempotencyKey,
        duplicate: admission.recovered,
      }
    : {
        status: "resume_failed",
        record: await registry.failResume(requestId, { attemptId: record.attemptId!, receipt: `agent-resume:${receipt.reason}` }),
        idempotencyKey: admission.idempotencyKey,
        duplicate: admission.recovered,
        receipt: `agent-resume:${receipt.reason}`,
      };
}

/** The instant of the admitted human answer, used as the explicit-stop fence. */
function humanRequestedAt(record: HumanRequestRecord): { human_requested_at?: number } {
  if (!record.admittedAt) return {};
  const admittedAt = Date.parse(record.admittedAt);
  return Number.isFinite(admittedAt) ? { human_requested_at: admittedAt } : {};
}

/** Select the exact bound native session; Agent Herder never discovers a replacement. */
export function humanRequestResumeTarget(record: HumanRequestRecord): SelectedResumeTarget | undefined {
  const target = record.target;
  const agent = target.agent;
  if (agent === "hermes") {
    if (!target.locator) return undefined;
    return { agent: "hermes", locator: target.locator as unknown as HermesResumeLocator };
  }
  if (!agent || !["codex", "opencode", "claude", "zcode"].includes(agent) || !target.cwd) return undefined;
  return {
    agent: agent as "codex" | "opencode" | "claude" | "zcode",
    session_id: target.sessionId,
    cwd: target.cwd,
    ...(target.marker ? { marker: target.marker } : {}),
  };
}

/** Reconcile an admitted attempt that another owner or a previous process may have completed. */
async function readAdmittedReceipt(
  input: HumanRequestResumeInput,
  record: HumanRequestRecord,
  idempotencyKey: string,
): Promise<HumanRequestResumeOutcome | undefined> {
  if (!input.queryReceipt || record.status !== "resuming" || !record.attemptId) return undefined;
  const target = humanRequestResumeTarget(record);
  if (!target) return undefined;
  let receipt: ResumeReceipt;
  try {
    receipt = await input.queryReceipt({
      target,
      result_ref: record.resultRef ?? input.resultRef,
      idempotency_key: idempotencyKey,
    });
  } catch {
    // The ledger is unreadable; the admitted attempt is still in flight.
    return undefined;
  }
  if (receipt.status !== "accepted") return undefined;
  const completed = await input.registry.completeResume(input.requestId, { attemptId: record.attemptId, receipt: receipt.receipt_ref });
  return { status: "resumed", record: completed, idempotencyKey, duplicate: true };
}