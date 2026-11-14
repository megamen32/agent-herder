import { isDeepStrictEqual } from "node:util";

type Row = Record<string, unknown>;
export type ZcodeOwnedDraftFailure =
  | "draft_identity_unverified" | "draft_not_empty" | "draft_queue_not_empty"
  | "model_unverified" | "permission_unverified" | "model_changed" | "permission_changed";

export class ZcodeOwnedDraftError extends Error {
  constructor(readonly code: ZcodeOwnedDraftFailure) {
    super("ZCode owned draft: " + code);
    this.name = "ZcodeOwnedDraftError";
  }
}

export interface ZcodeOwnedDraftProof {
  sessionId: string;
  workspace: { workspacePath: string; workspaceIdentity: string; workspaceKey: string };
  traceId: string;
  modelSelection: Row;
  permission: Row;
}
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
function requireProof(ok: unknown, code: ZcodeOwnedDraftFailure): asserts ok {
  if (!ok) throw new ZcodeOwnedDraftError(code);
}
function assertEmptyRuntime(sessionId: string, workspacePath: string, value: unknown): void {
  const snapshot = record(value), session = record(snapshot.session), workspace = record(session.workspace), runtime = record(snapshot.runtime);
  requireProof(session.sessionId === sessionId && workspace.workspacePath === workspacePath
    && (workspace.workspaceIdentity === undefined || workspace.workspaceIdentity === workspacePath), "draft_identity_unverified");
  requireProof(session.status === "idle" && !runtime.activeTurnId && !runtime.activeTurnKind
    && runtime.eventSeq === 0 && Number.isSafeInteger(runtime.stateRevision) && Number(runtime.stateRevision) >= 0
    && Array.isArray(runtime.pendingRequestIds) && runtime.pendingRequestIds.length === 0
    && Array.isArray(snapshot.messages) && snapshot.messages.length === 0
    && (runtime.goalVerifications === undefined || Array.isArray(runtime.goalVerifications) && runtime.goalVerifications.length === 0)
    && (runtime.goalVerificationTimeline === undefined || Array.isArray(runtime.goalVerificationTimeline) && runtime.goalVerificationTimeline.length === 0), "draft_not_empty");
}

/** Called only with the response of this adapter instance's successful native create.
 * This proof never authorizes loading an absent runtime or replaces a cold DB proof. */
export function captureZcodeOwnedDraft(
  sessionId: string, workspace: ZcodeOwnedDraftProof["workspace"], value: unknown,
): ZcodeOwnedDraftProof {
  requireProof(textId(sessionId), "draft_identity_unverified");
  assertEmptyRuntime(sessionId, workspace.workspacePath, value);
  const snapshot = record(value), session = record(snapshot.session), settings = record(snapshot.settings);
  const modelSelection = record(record(settings.model).current), permission = record(settings.permission);
  requireProof(textId(session.traceId), "draft_identity_unverified");
  requireProof(textId(modelSelection.providerId) && textId(modelSelection.modelId), "model_unverified");
  requireProof(["build", "plan", "edit", "guarded", "auto", "yolo"].includes(String(permission.mode)), "permission_unverified");
  // Native transports may reuse mutable snapshot objects; retain our own values.
  return structuredClone({ sessionId, workspace, traceId: session.traceId, modelSelection, permission });
}

export function assertZcodeOwnedDraft(before: ZcodeOwnedDraftProof, value: unknown, queueValue?: unknown): void {
  assertEmptyRuntime(before.sessionId, before.workspace.workspacePath, value);
  const snapshot = record(value), session = record(snapshot.session), settings = record(snapshot.settings);
  requireProof(session.traceId === before.traceId, "draft_identity_unverified");
  requireProof(isDeepStrictEqual(record(settings.model).current, before.modelSelection), "model_changed");
  requireProof(isDeepStrictEqual(settings.permission, before.permission), "permission_changed");
  if (queueValue === undefined) return;
  const snapshotV4 = record(queueValue), queue = record(snapshotV4.queue), control = record(snapshotV4.control);
  requireProof(snapshotV4.sessionId === before.sessionId && Number.isSafeInteger(snapshotV4.revision)
    && Number(snapshotV4.revision) >= 0 && Array.isArray(queue.items) && queue.items.length === 0
    && typeof queue.autoDrain === "boolean" && control.phase === "draft" && control.sessionEnded === false
    && Array.isArray(control.activeWorks) && control.activeWorks.length === 0 && control.apiRetry === null
    && control.stopState === "idle" && control.canStop === false, "draft_queue_not_empty");
}
