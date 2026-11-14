import { createHash } from "node:crypto";
import {
  CanonicalHerderError, createCanonicalAutomationClient, requireCanonicalMigrationReady,
  type CanonicalAutomationClient, type CanonicalAutomationOptions, type CanonicalSessionRef,
} from "../canonical-herder.js";
import type { ResumeReceipt, ResumeTransport, ResumeTransportRequest } from "../resume-transport.js";
import { readRetainedResumeReceipts, retainedResumeReceipt } from "./canonical-receipts.js";

export interface CanonicalResumeTransport extends ResumeTransport {
  queryReceipt(request: ResumeTransportRequest): Promise<ResumeReceipt>;
}
export interface CanonicalResumeTransportOptions extends CanonicalAutomationOptions {
  /** A trusted composition/test seam; it does not enable legacy fallback. */
  client?: CanonicalAutomationClient;
}

type ObjectValue = Record<string, unknown>;
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: unknown): ObjectValue | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : undefined;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Canonical keys are scoped by authenticated principal and exact SessionRef. */
export function canonicalResumeKey(key: string): string { return "compat-resume:v1:" + sha(key); }

/** Metadata binds the opaque result and immutable selection into the core payload. */
export function canonicalResumeMessage(request: ResumeTransportRequest): string {
  const selection = request.target.agent === "hermes" ? { agent: "hermes", locator: request.target.locator } : {
    agent: request.target.agent, session_id: request.target.session_id, cwd: request.target.cwd,
    ...(request.target.model === undefined ? {} : { model: request.target.model }),
    ...(request.target.marker === undefined ? {} : { marker: request.target.marker }),
  };
  return (request.prompt ?? request.goal ?? "") + "\n\nHerder delivery context (selection metadata, not a configuration change):\n"
    + JSON.stringify({ version: 1, result_ref: request.result_ref, selection,
      ...(request.goal === undefined ? {} : { goal: request.goal }),
      ...(request.human_requested_at === undefined ? {} : { human_requested_at: request.human_requested_at }),
    });
}

/** Byte-compatible with Rust dispatch_payload_binding; native mode is authority-owned. */
export function canonicalResumePayloadHash(target: CanonicalSessionRef, mode: "queue" | "start", message: string): string {
  return "sha256-dispatch-v1:" + sha(JSON.stringify([1, {
    instance: { node: target.nodeRef, instance_id: target.instanceRef }, native_session_id: target.nativeSessionId,
  }, mode, null, message]));
}

function outcome(request: ResumeTransportRequest, status: "ambiguous" | "rejected", reason: string, detail?: string): ResumeReceipt {
  return { status, target: request.target, result_ref: request.result_ref, reason,
    ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function validateProjection(value: ObjectValue, target: CanonicalSessionRef, key: string, message: string): "queue" | "start" {
  const address = object(value.target);
  if (value.version !== 1 || value.complete !== true || typeof value.found !== "boolean"
    || value.session_ref !== target.sessionRef || value.request_key !== key || !exact(value.task_ref)
    || !address || address.node_ref !== target.nodeRef || address.instance_ref !== target.instanceRef
    || address.native_session_id !== target.nativeSessionId || !["queue", "start"].includes(String(value.delivery_mode))) {
    throw new Error("canonical_receipt_binding_invalid");
  }
  const mode = value.delivery_mode as "queue" | "start";
  const expectedHash = canonicalResumePayloadHash(target, mode, message);
  if (value.found && value.payload_hash !== expectedHash) throw new Error("idempotency_conflict");
  if (value.reserved_payload_hash !== undefined && value.reserved_payload_hash !== null
    && value.reserved_payload_hash !== expectedHash) throw new Error("idempotency_conflict");
  return mode;
}

function fromProjection(value: ObjectValue, request: ResumeTransportRequest, target: CanonicalSessionRef, key: string): ResumeReceipt {
  if (!value.found) return outcome(request, "ambiguous", "receipt_not_found");
  if (value.state === "confirmed") {
    const receipt = object(value.native_receipt);
    const native = object(receipt?.target);
    const instance = object(native?.instance);
    if (!receipt || !exact(receipt.native_id) || !native || !instance
      || instance.node !== target.nodeRef || instance.instance_id !== target.instanceRef
      || native.native_session_id !== target.nativeSessionId) return outcome(request, "ambiguous", "canonical_native_receipt_invalid");
    let messageId: string | null = null;
    if (receipt.native_id.startsWith("ahap-receipt:v1:")) {
      try {
        const binding = object(JSON.parse(receipt.native_id.slice("ahap-receipt:v1:".length)));
        if (binding?.kind === "message" && exact(binding.native_id)) messageId = binding.native_id;
      } catch { /* The core has validated its own receipt; no guessed message ID. */ }
    }
    return { status: "accepted", target: request.target, result_ref: request.result_ref,
      receipt_ref: String(value.task_ref), idempotency_key: request.idempotency_key,
      ...(request.target.agent === "opencode" ? { input_id: key, native_input_message_id: messageId } : {}),
    };
  }
  if (value.state === "rejected") return outcome(request, "rejected", "canonical_delivery_rejected");
  return outcome(request, "ambiguous", "canonical_delivery_" + String(value.state ?? "unknown"));
}

/** No polling interval, receipt ledger, native client, standalone process, or retrying send. */
export function createCanonicalResumeTransport(options: CanonicalResumeTransportOptions = {}): CanonicalResumeTransport {
  let pending: Promise<CanonicalAutomationClient> | undefined;
  const client = (): Promise<CanonicalAutomationClient> => {
    if (options.client) return Promise.resolve(options.client);
    return pending ??= createCanonicalAutomationClient(options).then(value => {
      if (!value) throw new Error("canonical_mode_required");
      return value;
    });
  };
  const execute = async (request: ResumeTransportRequest, readOnly: boolean): Promise<ResumeReceipt> => {
    if (!exact(request.idempotency_key)) return outcome(request, "rejected", "idempotency_key_required");
    let attempted = false;
    try {
      const authority = await client();
      const retained = await readRetainedResumeReceipts(authority);
      const previous = Object.hasOwn(retained.records, request.idempotency_key) ? retained.records[request.idempotency_key] : undefined;
      if (previous) return retainedResumeReceipt(previous, request);
      if (request.target.agent === "claude") return outcome(request, "rejected", "harness_disabled");
      const nativeId = request.target.agent === "hermes" ? request.target.locator.session_key : request.target.session_id;
      const target = await authority.resolveNative(request.target.agent, nativeId);
      const key = canonicalResumeKey(request.idempotency_key);
      const message = canonicalResumeMessage(request);
      const read = async (): Promise<ObjectValue> => {
        const value = await authority.call("deliver", { action: "receipt", session_ref: target.sessionRef, request_key: key });
        validateProjection(value, target, key, message);
        return value;
      };
      let projection = await read();
      // An existing canonical intent is always queried, never delivered again.
      if (projection.found || readOnly) {
        if (projection.found && !["confirmed", "rejected"].includes(String(projection.state))) {
          try {
            await authority.call("compat_task", { action: "get", task_ref: projection.task_ref });
            projection = await read();
          } catch { /* Receipt recovery is bounded; UNKNOWN remains UNKNOWN. */ }
        }
        return fromProjection(projection, request, target, key);
      }
      if (projection.automatic_continuation !== true) return outcome(request, "rejected", "canonical_automatic_continuation_unsupported");
      if (retained.blockers.length) return outcome(request, "rejected", "canonical_legacy_receipts_unresolved");
      await requireCanonicalMigrationReady(authority);
      // Recheck the immutable legacy reservation immediately before the one send.
      const finalRetained = await readRetainedResumeReceipts(authority);
      if (Object.hasOwn(finalRetained.records, request.idempotency_key)) return retainedResumeReceipt(finalRetained.records[request.idempotency_key]!, request);
      if (finalRetained.blockers.length) return outcome(request, "rejected", "canonical_legacy_receipts_unresolved");
      attempted = true;
      try {
        await authority.call("deliver", { action: "session", session_ref: target.sessionRef,
          message, mode: projection.delivery_mode, request_key: key });
      } catch {
        // The server may have committed the original request. Only its receipt
        // can settle this call; no second transport or mutation is attempted.
      }
      projection = await read();
      if (projection.found && !["confirmed", "rejected"].includes(String(projection.state))) {
        try {
          await authority.call("compat_task", { action: "get", task_ref: projection.task_ref });
          projection = await read();
        } catch { /* Native ACK may arrive later; preserve the exact original task. */ }
      }
      return fromProjection(projection, request, target, key);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if ((error instanceof CanonicalHerderError && error.code === "idempotency_conflict")
        || detail === "idempotency_conflict" || /"code"\s*:\s*"idempotency_conflict"/.test(detail)) {
        return outcome(request, "rejected", "idempotency_conflict");
      }
      return outcome(request, attempted || readOnly ? "ambiguous" : "rejected",
        attempted ? "canonical_resume_outcome_unknown" : "canonical_resume_unavailable", detail);
    }
  };
  return { resume: request => execute(request, false), queryReceipt: request => execute(request, true) };
}
