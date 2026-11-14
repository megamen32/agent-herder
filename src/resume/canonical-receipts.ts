import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { receiptFingerprint, type BoundTarget, type ResumeReceiptRecord } from "agent-resume-mcp";
import type { CanonicalAutomationClient } from "../canonical-herder.js";
import { readCanonicalPinnedJson, readCanonicalPrivateBytes } from "../canonical-herder.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../resume-transport.js";

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_retained_receipts_invalid");
  return value as ObjectValue;
};
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** The retired Python OpenCode adapter rejected this exact preflight before
 * constructing a native POST. Keep its snake_case evidence intact and reserve
 * the original key. A generic rejected label or a missing flag is insufficient. */
function retainedNotSubmitted(row: ObjectValue): boolean {
  if (!["rejected", "failed"].includes(String(row.status))
    || row.admitted === true || row.admissionUnknown === true || row.admission_unknown === true) return false;
  if (row.notSubmitted === true) return true;
  const target = row.target as ObjectValue | undefined;
  return row.status === "rejected" && target?.agent === "opencode"
    && row.transport === "opencode-api" && row.error === "OpenCode v2 config has an invalid shape"
    && row.executed === false && row.pending === false && row.admitted === false
    && row.admission_unknown === false;
}

export interface RetainedResumeReceipts {
  records: Readonly<Record<string, ResumeReceiptRecord>>;
  blockers: string[];
}

/** Read the sealed original ledger; never create a new ledger, lock, or import. */
export async function readRetainedResumeReceipts(client: CanonicalAutomationClient): Promise<RetainedResumeReceipts> {
  await client.assertCurrent();
  const config = client.config.resume_receipts;
  if (!config) throw new Error("canonical_retained_receipts_required");
  const snapshot = record(await readCanonicalPinnedJson(config.snapshot, config.sha256));
  const identity = record(snapshot.file_identity);
  if (snapshot.version !== 1 || snapshot.kind !== "herder-resume-receipts-retained"
    || snapshot.epoch !== client.epoch || snapshot.path !== config.path || !hash(snapshot.sha256)
    || typeof snapshot.sealed_at !== "string" || !Number.isFinite(Date.parse(snapshot.sealed_at))
    || Date.parse(snapshot.sealed_at) > Date.now() + 5000 || !exact(identity.device) || !exact(identity.inode)) {
    throw new Error("canonical_retained_receipts_snapshot_invalid");
  }
  const before = await fs.lstat(config.path);
  if ((before.mode & 0o777) !== 0o400 || String(before.dev) !== identity.device
    || String(before.ino) !== identity.inode) throw new Error("canonical_retained_receipts_unsealed");
  const bytes = await readCanonicalPrivateBytes(config.path, 16 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) throw new Error("canonical_retained_receipts_changed");
  const ledger = record(JSON.parse(bytes.toString("utf8")));
  if (ledger.version !== 1) throw new Error("canonical_retained_receipts_invalid");
  const records = record(ledger.receipts);
  if (Object.keys(records).length > 10000) throw new Error("canonical_retained_receipts_invalid");
  const blockers: string[] = [];
  for (const [key, value] of Object.entries(records)) {
    const row = record(value);
    if (!exact(key) || row.idempotency_key !== key || !hash(row.fingerprint)
      || !["accepted", "rejected", "ambiguous", "failed"].includes(String(row.status))) {
      throw new Error("canonical_retained_receipt_invalid");
    }
    // An error label alone does not prove that the old writer never submitted.
    const accepted = row.status === "accepted" && exact(row.receipt_ref) && exact(row.result_ref)
      && row.target !== null && typeof row.target === "object" && !Array.isArray(row.target);
    const notSubmitted = retainedNotSubmitted(row);
    if (!accepted && !notSubmitted) blockers.push(key);
  }
  const after = await fs.lstat(config.path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || (after.mode & 0o777) !== 0o400) {
    throw new Error("canonical_retained_receipts_changed");
  }
  return { records: records as unknown as Record<string, ResumeReceiptRecord>, blockers };
}

/** Every old key stays reserved, including a definitely refused one. */
export function retainedResumeReceipt(row: ResumeReceiptRecord, request: ResumeTransportRequest): ResumeReceipt {
  const base = { target: request.target, result_ref: request.result_ref, idempotency_key: request.idempotency_key };
  if (request.target.agent === "hermes") return { ...base, status: "ambiguous", reason: "retained_legacy_locator_requires_review" };
  const target = row.target;
  if (!target || target.agent !== request.target.agent || target.session_id !== request.target.session_id
    || target.cwd !== request.target.cwd || (target.model ?? undefined) !== request.target.model
    || (target.marker ?? undefined) !== request.target.marker || row.result_ref !== request.result_ref
    || row.idempotency_key !== request.idempotency_key) {
    return { ...base, status: "rejected", reason: "idempotency_conflict" };
  }
  const fingerprint = receiptFingerprint({
    target: target as BoundTarget, prompt: request.prompt ?? request.goal ?? "",
    ...(request.goal === undefined ? {} : { goal: request.goal }),
    resultRef: request.result_ref, idempotencyKey: request.idempotency_key!,
  });
  if (row.fingerprint !== fingerprint) return { ...base, status: "rejected", reason: "idempotency_conflict" };
  if (row.status === "accepted" && exact(row.receipt_ref)) return {
    ...base, status: "accepted", receipt_ref: row.receipt_ref,
    ...(request.target.agent === "opencode" ? {
      input_id: typeof row.input_id === "string" ? row.input_id : null,
      native_input_message_id: typeof row.native_input_message_id === "string" ? row.native_input_message_id : null,
    } : {}),
  };
  if (retainedNotSubmitted(row as unknown as ObjectValue)) {
    return { ...base, status: "rejected", reason: row.reason ?? "retained_legacy_refusal" };
  }
  return { ...base, status: "ambiguous", reason: "retained_legacy_outcome_unknown" };
}
