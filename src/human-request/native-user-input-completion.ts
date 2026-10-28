import type { ControlResult, HarnessAdapter } from "../types/index.js";
import type { PermissionNoticeObserverDependencies } from "../permission-control/notice-bridge.js";
import { collectCanonicalNativeUserInputAnswers, parseNativeUserInputContextRef } from "./native-user-input-notice.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

type NativeInputAdapter = HarnessAdapter & {
  respondNativeUserInput?: (sessionId: string, requestId: string, answers: Record<string, { answers: string[] }>) => Promise<ControlResult>;
};

export interface NativeUserInputCompletion {
  admitted: boolean;
  /** A sibling answer or the first native writer is still outstanding. */
  pending: boolean;
  record: HumanRequestRecord;
  nativeResult?: ControlResult;
}

/** Native RPC completion only. Callback payloads never supply the answer. */
export async function completeNativeUserInputNotice(
  registry: HumanRequestRegistry,
  inputRecord: HumanRequestRecord,
  adapter: HarnessAdapter,
  dependencies: PermissionNoticeObserverDependencies = {},
): Promise<NativeUserInputCompletion> {
  const record = await registry.get(inputRecord.requestId);
  const target = parseNativeUserInputContextRef(record?.contextRef);
  if (!record || !target) throw new Error("invalid native user-input completion binding");
  const siblings = (await registry.list()).filter(candidate => {
    const other = parseNativeUserInputContextRef(candidate.contextRef);
    return other && other.hostId === target.hostId && other.harness === target.harness
      && other.sessionId === target.sessionId && other.nativeRequestId === target.nativeRequestId;
  }).sort((a, b) => parseNativeUserInputContextRef(a.contextRef)!.questionId.localeCompare(parseNativeUserInputContextRef(b.contextRef)!.questionId));
  const carrier = siblings[0]!;

  // Check the durable fence before asking the adapter for a pending request:
  // successful native completion removes that request from its live map.
  if (carrier.status !== "pending") {
    if (carrier.status === "resumed" || carrier.status === "resume_failed") {
      for (const sibling of siblings.slice(1)) {
        const latest = await registry.get(sibling.requestId);
        if (latest?.status === "resuming" && latest.attemptId) {
          const result = { receipt: carrier.receipt ?? "native-user-input:unknown", retryable: false };
          if (carrier.status === "resumed") await registry.markResumed(latest.requestId, latest.attemptId, result);
          else await registry.markResumeFailed(latest.requestId, latest.attemptId, result);
        }
      }
    }
    return { admitted: false, pending: carrier.status === "resuming", record: (await registry.get(record.requestId))! };
  }

  const native = adapter as NativeInputAdapter;
  if (!native.respondNativeUserInput) throw new Error("native user-input response transport unavailable");
  const collected = await collectCanonicalNativeUserInputAnswers(registry, record, adapter, dependencies);
  if (!collected) return { admitted: false, pending: true, record };
  const canonicalCarrier = collected.siblings[0]!;
  const admission = await registry.admitResume(canonicalCarrier.record.requestId, { resultRef: canonicalCarrier.resultRef });
  // An expired lease means the previous outcome is unknown, never permission
  // to replay an RPC lacking a provider-side idempotency ledger.
  if (!admission.admitted || admission.recovered) {
    return { admitted: false, pending: admission.record.status === "resuming", record: (await registry.get(record.requestId))! };
  }

  let nativeResult: ControlResult | undefined;
  let succeeded = false;
  try {
    // Close every sibling's admission fence before crossing the native writer.
    for (const sibling of collected.siblings.slice(1)) {
      const claimed = await registry.admitResume(sibling.record.requestId, { resultRef: sibling.resultRef });
      if (!claimed.admitted || claimed.recovered) throw new Error("native user-input sibling already admitted");
    }
    nativeResult = await native.respondNativeUserInput(target.sessionId, target.nativeRequestId, collected.answers);
    succeeded = nativeResult.ok && (nativeResult.admission === "accepted" || nativeResult.admitted === true)
      && nativeResult.admission !== "unknown" && nativeResult.admission !== "pending" && nativeResult.admission !== "not_submitted"
      && !nativeResult.admissionUnknown && !nativeResult.pending && !nativeResult.notSubmitted && nativeResult.admitted !== false;
  } catch {
    // A throw may happen after the RPC write. Persist an explicit no-replay
    // outcome instead of returning the record to pending.
    nativeResult = { ok: false, admission: "unknown", admissionUnknown: true, nonRetryable: true };
  }
  const result = { receipt: succeeded ? "native-user-input:accepted" : "native-user-input:unknown", retryable: false };
  // Settle the carrier first: after a crash duplicate callbacks finish the
  // remaining admitted sibling fences from that durable outcome.
  for (const sibling of collected.siblings) {
    const latest = await registry.get(sibling.record.requestId);
    if (latest?.status !== "resuming" || !latest.attemptId) continue;
    if (succeeded) await registry.markResumed(latest.requestId, latest.attemptId, result);
    else await registry.markResumeFailed(latest.requestId, latest.attemptId, result);
  }
  return { admitted: true, pending: false, record: (await registry.get(record.requestId))!, nativeResult };
}
