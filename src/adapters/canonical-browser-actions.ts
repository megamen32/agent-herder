import {
  CanonicalHerderError, requireCanonicalMigrationReady, type CanonicalAutomationClient, type CanonicalSessionRef,
} from "../canonical-herder.js";
import { FleetAttachmentFrameTooLarge, MAX_INLINE_ATTACHMENT_BYTES, meshAttachmentsSchema, type MeshInlineAttachment } from "../mesh/delivery-schema.js";
import { canonicalDeliveryReceiptMode } from "../resume/canonical-transport.js";
import type { SessionImageStore } from "../session-images.js";
import { localSessionHostId, type ControlResult, type SendMessageOptions, type SendMessageResult } from "../types/index.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const validBrowserInputId = (key: unknown): key is string =>
  typeof key === "string" && key.length > 0 && key.length <= 512 && key.trim() === key && !/[\x00-\x1f\x7f]/.test(key);
const refused = (inputId: string | undefined, error: string): SendMessageResult =>
  ({ ok: false, inputId, notSubmitted: true, nonRetryable: true, error });
const unknown = (inputId: string, error: string): SendMessageResult =>
  ({ ok: false, inputId, admissionUnknown: true, nonRetryable: true, error });

function messageId(proof: unknown, target: CanonicalSessionRef): string | undefined {
  const receipt = record(proof);
  const address = record(receipt?.target);
  const instance = record(address?.instance);
  if (receipt?.sender != null || address?.native_session_id !== target.nativeSessionId
    || instance?.node !== target.nodeRef || instance.instance_id !== target.instanceRef) return;
  let id = receipt?.native_id;
  // Earlier browser receipts stored the provider message ID directly.
  const prefix = "ahap-receipt:v1:";
  if (typeof id === "string" && id.startsWith(prefix)) {
    const typed = record(JSON.parse(id.slice(prefix.length)));
    id = typed?.kind === "message" ? typed.native_id : undefined;
  }
  return typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 4096 && !/[\x00-\x1f\x7f]/.test(id) ? id : undefined;
}

/** Cabinet writes use the same pinned owner as the other canonical clients. */
export class CanonicalBrowserActions {
  constructor(private readonly client: CanonicalAutomationClient, private readonly images: SessionImageStore) {}

  private resolve(harness: string, id: string) {
    return this.client.resolveNative(harness, id, this.client.config.node_ref ?? localSessionHostId());
  }

  private async attachments(harness: string, id: string, images: SendMessageOptions["images"]) {
    if (!images?.length) return;
    const files = await this.images.resolve(harness, id, images.map(image => image.id));
    if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_INLINE_ATTACHMENT_BYTES) throw new Error("attachment_bytes_exceeded");
    const inline = await Promise.all(files.map(async file => {
      const { bytes } = await this.images.content(file.id);
      return { name: file.fileName, mime_type: file.mimeType, data_base64: bytes.toString("base64") };
    }));
    return meshAttachmentsSchema.parse(inline);
  }

  async send(harness: string, id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    const { inputId, message } = options;
    if (!validBrowserInputId(inputId)) return refused(inputId, "browser_input_id_required");
    let target: CanonicalSessionRef;
    let attachments: MeshInlineAttachment[] | undefined;
    try { target = await this.resolve(harness, id); }
    catch { return refused(inputId, "canonical_browser_session_unresolved"); }
    try { attachments = await this.attachments(harness, id, options.images); }
    catch { return refused(inputId, "canonical_browser_attachment_invalid"); }
    const binding = { session_ref: target.sessionRef, request_key: inputId };
    let original: { taskRef: unknown; mode: "queue" | "start" } | undefined;
    const read = async () => {
      const row = await this.client.call("deliver", { action: "receipt", ...binding });
      const mode = canonicalDeliveryReceiptMode(row, target, inputId, message, attachments);
      if (original && (row.task_ref !== original.taskRef || mode !== original.mode)) throw new Error("canonical_browser_task_changed");
      original ??= { taskRef: row.task_ref, mode };
      return { row, mode };
    };
    let submitted = false;
    let reportedReceipt: unknown;
    try {
      let { row, mode } = await read();
      if (row.found === false) {
        if (row.reserved_payload_hash != null || row.state !== undefined || row.native_receipt != null || row.payload_hash !== undefined) {
          return unknown(inputId, "canonical_browser_receipt_incomplete");
        }
        try { await requireCanonicalMigrationReady(this.client); }
        catch { return refused(inputId, "canonical_browser_migration_unavailable"); }
        submitted = true;
        try {
          const result = await this.client.call("deliver", { action: "session", ...binding, message, mode, ...(attachments && { attachments }) });
          reportedReceipt = result.native_receipt_id;
        } catch (error) {
          if (error instanceof FleetAttachmentFrameTooLarge) return refused(inputId, error.message);
          if (error instanceof CanonicalHerderError && error.effect === "none") return refused(inputId, error.code);
          // The handoff may have committed before its response was lost.
        }
        row = (await read()).row;
      }
      if (row.found && ["prepared", "dispatching", "admitted", "unknown"].includes(String(row.state))) {
        // The task read lets the owner reconcile a native receipt without another handoff.
        await this.client.call("compat_task", { action: "get", task_ref: row.task_ref });
        row = (await read()).row;
      }
      if (row.found && row.state === "rejected") return refused(inputId, "canonical_browser_delivery_rejected");
      if (row.found && row.state === "confirmed") {
        if (reportedReceipt !== undefined && reportedReceipt !== record(row.native_receipt)?.native_id) {
          return unknown(inputId, "canonical_browser_native_receipt_mismatch");
        }
        const nativeInputMessageId = messageId(row.native_receipt, target);
        if (nativeInputMessageId) return { ok: true, admitted: true, admission: "accepted", inputId, nativeInputMessageId };
      }
    } catch (error) {
      if (!submitted && error instanceof Error && error.message === "idempotency_conflict") return refused(inputId, "idempotency_conflict");
    }
    return unknown(inputId, "canonical_browser_delivery_unknown");
  }

  async stop(harness: string, id: string, inputId?: string): Promise<ControlResult> {
    if (!validBrowserInputId(inputId)) return refused(inputId, "browser_stop_input_id_required");
    let target: CanonicalSessionRef;
    try { target = await this.resolve(harness, id); }
    catch { return refused(inputId, "canonical_browser_session_unresolved"); }
    try {
      const row = await this.client.call("stop", { action: "stop", session_ref: target.sessionRef, request_key: inputId });
      if (row.session_ref === target.sessionRef && row.hold === "active") {
        const base = { sessionId: id, held: true };
        switch (row.native_interrupt) {
          case "acknowledged": return { ...base, inputId, ok: true, nativeInterrupt: row.native_interrupt };
          case "not_attempted_no_known_handoff":
          case "not_sent": return { ...base, ...refused(inputId, row.native_interrupt), nativeInterrupt: row.native_interrupt };
          case "required_or_reconcile": return { ...base, ...unknown(inputId, row.native_interrupt), nativeInterrupt: row.native_interrupt };
        }
      }
    } catch (error) {
      if (error instanceof CanonicalHerderError && error.effect === "none") return refused(inputId, error.code);
    }
    return unknown(inputId, "canonical_browser_stop_unknown");
  }
}
