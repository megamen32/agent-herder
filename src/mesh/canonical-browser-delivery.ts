import {
  CanonicalHerderError, requireCanonicalMigrationReady, type CanonicalAutomationClient, type CanonicalSessionRef,
} from "../canonical-herder.js";
import { canonicalResumePayloadHash } from "../resume/canonical-transport.js";
import { AutomationDisarmStore, automationDisarmDecisionWithWork } from "../automation-disarm/index.js";
import { checkDeliveryModel, DeliveryModelRefusedError, type ProjectModelPolicyStateProvider } from "../project-model-delivery-gate.js";
import type { MeshDelivery } from "./gptadmin.js";
import type { NativeReceipt } from "./protocol.js";
import { FleetAttachmentFrameTooLarge } from "./delivery-schema.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function canonicalBrowserModelRefusal(request: MeshDelivery, policy?: ProjectModelPolicyStateProvider): Promise<NativeReceipt | undefined> {
  if (!policy) return;
  try {
    // The canonical session resolution contains owner identity only. A
    // project-specific restriction requires a verified work directory.
    checkDeliveryModel(await policy(), { harness: request.target.harness, directory: null });
  } catch (error) {
    const reason = error instanceof DeliveryModelRefusedError ? error.refusalReason : "project_model_policy_unreadable";
    return { state: "not_attempted", inputId: request.inputId, retryable: false, reason };
  }
}

/** Read the original owner intent, including its stored sender. Only a verified miss permits a new envelope. */
export async function readCanonicalBrowserReceipt(client: CanonicalAutomationClient, target: CanonicalSessionRef, request: MeshDelivery): Promise<NativeReceipt | undefined> {
  const { inputId, sender } = request;
  const unknown: NativeReceipt = { state: "unknown", inputId, retryable: false };
  const value = await client.call("deliver", { action: "receipt", session_ref: target.sessionRef, request_key: inputId });
  const address = record(value.target);
  if (value.version !== 1 || value.complete !== true || typeof value.found !== "boolean"
    || value.request_key !== inputId || value.session_ref !== target.sessionRef
    || typeof value.task_ref !== "string" || !value.task_ref.trim()
    || address?.node_ref !== target.nodeRef || address.instance_ref !== target.instanceRef
    || address.native_session_id !== target.nativeSessionId
    || (value.delivery_mode !== "queue" && value.delivery_mode !== "start")) return unknown;

  // Rust dispatch_payload_binding_with_sender hashes the native effect. The
  // original sender is bound separately in native_receipt, even on replay.
  const hash = canonicalResumePayloadHash(target, value.delivery_mode, request.message, request.attachments);
  if ((value.reserved_payload_hash != null && value.reserved_payload_hash !== hash)
    || (value.found && typeof value.payload_hash === "string" && value.payload_hash !== hash)) {
    return { state: "not_attempted", inputId, retryable: false, reason: "input_id_conflict" };
  }
  if (!value.found) {
    if (value.state !== undefined || value.native_receipt != null || value.payload_hash !== undefined) return unknown;
    return undefined;
  }
  if (value.payload_hash !== hash) return unknown;
  if (value.state === "rejected") return { state: "not_attempted", inputId, retryable: false, reason: "native_delivery_rejected" };
  const proof = record(value.native_receipt);
  const from = record(proof?.sender);
  const native = record(proof?.target);
  const instance = record(native?.instance);
  if (value.state !== "confirmed" || typeof proof?.native_id !== "string" || !proof.native_id.trim()
    || from?.hostId !== sender.hostId || from.harness !== sender.harness || from.nativeSessionId !== sender.nativeSessionId
    || native?.native_session_id !== target.nativeSessionId || instance?.node !== target.nodeRef
    || instance.instance_id !== target.instanceRef) return unknown;
  return { state: "admitted", inputId, nativeReceiptId: proof.native_id, retryable: false };
}

/** Called inside the receiving mesh ledger and its authenticated, local policy boundary. */
export async function deliverCanonicalBrowser(client: CanonicalAutomationClient, request: MeshDelivery, policy?: ProjectModelPolicyStateProvider): Promise<NativeReceipt> {
  const { target, inputId } = request;
  const unknown: NativeReceipt = { state: "unknown", inputId, retryable: false };
  let phase: "preflight" | "submit" | "readback" = "preflight";
  try {
    const binding = await client.resolveNative(target.harness, target.nativeSessionId, target.hostId);
    const prior = await readCanonicalBrowserReceipt(client, binding, request);
    if (prior) return prior;
    const refusal = await canonicalBrowserModelRefusal(request, policy);
    if (refusal) return refusal;
    await requireCanonicalMigrationReady(client);
    // The work-key resolver is called only for scoped rules. Neither the
    // canonical binding nor its receipt attests a session title and cwd.
    const disarm = await automationDisarmDecisionWithWork(AutomationDisarmStore.forRuntime(),
      async () => { throw new Error("canonical_work_metadata_unavailable"); }, "automation").catch(() => undefined);
    if (!disarm?.allowed) return { state: "not_attempted", inputId, retryable: false,
      reason: disarm ? "automation_disarmed" : "canonical_work_metadata_unavailable" };
    phase = "submit";
    const result = await client.call("deliver", { ...request });
    if (result.effect === "unknown" || result.outcome === "unknown") return unknown;
    phase = "readback";
    const receipt = await readCanonicalBrowserReceipt(client, binding, request);
    if (receipt?.reason === "input_id_conflict" || (result.outcome === "confirmed" && receipt?.state !== "admitted")) return unknown;
    if (receipt?.state === "admitted" && result.native_receipt_id !== undefined
      && result.native_receipt_id !== receipt.nativeReceiptId) return unknown;
    return receipt ?? unknown;
  } catch (error) {
    if (phase === "submit" && error instanceof FleetAttachmentFrameTooLarge) {
      return { state: "not_attempted", inputId, retryable: false, reason: error.message };
    }
    const ownerError = error instanceof CanonicalHerderError ? error : undefined;
    if (phase === "readback" || (phase === "submit" && ownerError?.effect !== "none") || ownerError?.effect === "unknown") return unknown;
    const code = ownerError?.code ?? (error instanceof Error && error.message.startsWith("canonical_") ? error.message : "");
    const reason = /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : "canonical_owner_unavailable";
    return { state: "not_attempted", inputId, retryable: !ownerError, reason };
  }
}
