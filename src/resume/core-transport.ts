import { homedir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeClient,
  ReceiptLedger,
  resumeBoundTarget,
  type ResumeReceiptRecord,
} from "agent-resume-mcp";
import type { ResumeReceipt, ResumeTransport, ResumeTransportRequest, SelectedResumeTarget } from "../resume-transport.js";

/**
 * Herder's in-process resume transport over the shared core.
 *
 * The core owns admission: the durable receipt, the idempotency key and the
 * native delivery path. This transport only translates Herder's selected target
 * into the core's bound-target request and the core's receipt back into Herder's
 * shape. It deliberately shares one ledger file with the legacy Agent Resume
 * service, so handing a request back to that service after a core failure
 * replays the stored receipt instead of delivering the goal twice.
 */
export interface CoreResumeTransportOptions {
  /** Ledger file; defaults to the legacy Agent Resume state directory. */
  ledgerPath?: string;
  /** OpenCode endpoint; the core needs it to admit an OpenCode goal natively. */
  opencodeUrl?: string;
  opencodePassword?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultResumeLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.AGENT_RESUME_STATE_DIR?.trim() || join(homedir(), ".local/state/agent-resume");
  return join(stateDir, "receipts.json");
}

/** True when the core can admit this target natively, without a CLI process. */
export function coreCanDeliver(target: SelectedResumeTarget, opencodeUrl?: string): boolean {
  if (target.agent === "hermes") return false;
  if (target.agent === "opencode") return Boolean(opencodeUrl);
  return false;
}

export function createCoreResumeTransport(options: CoreResumeTransportOptions = {}): ResumeTransport {
  const env = options.env ?? process.env;
  const ledger = new ReceiptLedger({ path: options.ledgerPath ?? defaultResumeLedgerPath(env) });
  const opencodeUrl = options.opencodeUrl ?? env.OPENCODE_URL;

  return {
    async resume(request: ResumeTransportRequest): Promise<ResumeReceipt> {
      if (!coreCanDeliver(request.target, opencodeUrl)) {
        return { status: "failed", target: request.target, result_ref: request.result_ref, reason: "unsupported" };
      }
      if (!request.idempotency_key) {
        // Without a key the core cannot promise a single admission; refusing is
        // safer than a delivery that a retry could duplicate.
        return { status: "rejected", target: request.target, result_ref: request.result_ref, reason: "idempotency_key_required" };
      }
      const target = request.target as Exclude<SelectedResumeTarget, { agent: "hermes" }>;
      const client = target.agent === "opencode"
        ? new OpenCodeClient({
            baseUrl: opencodeUrl,
            ...(options.opencodePassword ?? env.OPENCODE_SERVER_PASSWORD ? { password: (options.opencodePassword ?? env.OPENCODE_SERVER_PASSWORD)! } : {}),
          })
        : undefined;
      try {
        const receipt: ResumeReceiptRecord = await resumeBoundTarget({
          target: { agent: target.agent, session_id: target.session_id, cwd: target.cwd, ...(target.model ? { model: target.model } : {}) },
          prompt: request.prompt ?? request.goal ?? "",
          ...(request.goal ? { goal: request.goal } : {}),
          resultRef: request.result_ref,
          idempotencyKey: request.idempotency_key,
        }, { ledger, ...(client ? { nativeClient: client } : {}) });
        return toHerderReceipt(receipt, request);
      } catch (error) {
        return {
          status: "failed",
          target: request.target,
          result_ref: request.result_ref,
          reason: error instanceof Error ? error.message : String(error),
          idempotency_key: request.idempotency_key,
        };
      }
    },
  };
}

function toHerderReceipt(receipt: ResumeReceiptRecord, request: ResumeTransportRequest): ResumeReceipt {
  if (receipt.status === "accepted") {
    return {
      status: "accepted",
      target: request.target,
      result_ref: receipt.result_ref ?? request.result_ref,
      ...(receipt.receipt_ref ? { receipt_ref: receipt.receipt_ref } : {}),
      ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
      ...(request.target.agent === "opencode" ? { input_id: receipt.input_id ?? null, native_input_message_id: receipt.native_input_message_id ?? null } : {}),
    };
  }
  return {
    status: receipt.status,
    target: request.target,
    result_ref: receipt.result_ref ?? request.result_ref,
    reason: receipt.reason ?? receipt.error ?? "resume_rejected",
    // The provider named the exact cause of the refusal; keep it next to the
    // reason so a refused delivery is diagnosable without the raw receipt.
    ...(receipt.reason && receipt.error ? { detail: receipt.error } : {}),
    ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
  };
}
