import { isDeepStrictEqual } from "node:util";
import type { HarnessAdapter } from "../types/index.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../resume-transport.js";
import type { PermissionNoticeObserverDependencies } from "../permission-control/notice-bridge.js";
import { collectCanonicalAsyncUserInputAnswers, parseAsyncUserInputContextRef } from "./async-user-input-notice.js";
import { humanRequestResumeTarget } from "./resume-admission.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

export interface AsyncUserInputCompletion {
  admitted: boolean;
  pending: boolean;
  record: HumanRequestRecord;
}

/** Continue one exact terminal async question with all canonical sibling answers. */
export async function completeAsyncUserInputNotice(
  registry: HumanRequestRegistry,
  inputRecord: HumanRequestRecord,
  adapter: HarnessAdapter,
  resume: (request: ResumeTransportRequest) => Promise<ResumeReceipt>,
  dependencies: PermissionNoticeObserverDependencies = {},
): Promise<AsyncUserInputCompletion> {
  const record = await registry.get(inputRecord.requestId);
  const target = parseAsyncUserInputContextRef(record?.contextRef);
  if (!record || !target) throw new Error("invalid async question completion binding");
  const siblings = (await registry.list()).filter(candidate => {
    const other = parseAsyncUserInputContextRef(candidate.contextRef);
    return other && other.hostId === target.hostId && other.harness === target.harness && other.sessionId === target.sessionId
      && other.turnId === target.turnId && other.itemId === target.itemId && other.fingerprint === target.fingerprint;
  }).sort((a, b) => parseAsyncUserInputContextRef(a.contextRef)!.questionIndex - parseAsyncUserInputContextRef(b.contextRef)!.questionIndex);
  const carrier = siblings[0]!;
  const settle = async (succeeded: boolean, receipt: string, records: HumanRequestRecord[]) => {
    for (const sibling of records) {
      const latest = await registry.get(sibling.requestId);
      if (latest?.status !== "resuming" || !latest.attemptId) continue;
      if (succeeded) await registry.markResumed(latest.requestId, latest.attemptId, { receipt });
      else await registry.markResumeFailed(latest.requestId, latest.attemptId, { receipt, retryable: false });
    }
  };
  // A duplicate can arrive after the native session has advanced. Its durable
  // carrier is authoritative, so do not require the old terminal item to exist.
  if (carrier.status !== "pending") {
    if (carrier.status === "resumed" || carrier.status === "resume_failed") {
      await settle(carrier.status === "resumed", carrier.receipt ?? "async-user-input:unknown", siblings.slice(1));
    }
    return { admitted: false, pending: carrier.status === "resuming", record: (await registry.get(record.requestId))! };
  }
  const collected = await collectCanonicalAsyncUserInputAnswers(registry, record, adapter, dependencies);
  if (!collected) return { admitted: false, pending: true, record };
  const resumeTarget = humanRequestResumeTarget(collected.carrier);
  if (!resumeTarget) throw new Error("async question resume target unavailable");
  const first = collected.siblings[0]!;
  const admission = await registry.admitResume(first.record.requestId, { resultRef: first.resultRef });
  if (!admission.admitted || admission.recovered) {
    return { admitted: false, pending: admission.record.status === "resuming", record: (await registry.get(record.requestId))! };
  }
  const snapshot = (value: NonNullable<typeof collected>) => JSON.stringify({ target: value.target, answers: value.answers,
    siblings: value.siblings.map(sibling => ({ requestId: sibling.record.requestId, resultRef: sibling.resultRef })) });
  let succeeded = false;
  let receipt = "async-user-input:unknown";
  try {
    for (const sibling of collected.siblings.slice(1)) {
      const claim = await registry.admitResume(sibling.record.requestId, { resultRef: sibling.resultRef });
      if (!claim.admitted || claim.recovered) throw new Error("async question sibling already admitted");
    }
    const prompt = ["Пользователь ответил на вопросы агента. Продолжи ту же задачу в этой сессии, используя все ответы ниже.",
      JSON.stringify(collected.answers.map(answer => ({ question: answer.question, answer: answer.answer })), null, 2)].join("\n");
    const transportRequest: ResumeTransportRequest = { target: resumeTarget, result_ref: first.resultRef, prompt,
      idempotency_key: admission.idempotencyKey, human_requested_at: Date.parse(admission.record.admittedAt!) };
    // Re-read both the native terminal source and all canonical answers after
    // durable admission, immediately before invoking the supported transport.
    const fresh = await collectCanonicalAsyncUserInputAnswers(registry, record, adapter, dependencies);
    if (!fresh || snapshot(fresh) !== snapshot(collected)) throw new Error("async question changed before continuation");
    const result = await resume(transportRequest);
    succeeded = result.status === "accepted" && result.result_ref === first.resultRef
      && isDeepStrictEqual(result.target, resumeTarget)
      && (result.idempotency_key === undefined || result.idempotency_key === admission.idempotencyKey);
    if (succeeded) receipt = result.status === "accepted" ? result.receipt_ref ?? "async-user-input:accepted" : receipt;
  } catch {
    // The transport may already have accepted the continuation. Never turn an
    // unproven result into another send, including after a process restart.
  }
  await settle(succeeded, receipt, collected.siblings.map(sibling => sibling.record));
  return { admitted: true, pending: false, record: (await registry.get(record.requestId))! };
}
