import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { GoalModelUsage, GoalRequirementMemo, GoalVerificationKind } from "./goal-evaluation.js";

export type GoalIdentity = { harness: string; sessionId: string; cwd: string };
export type GoalReference = { uri: string; label?: string };
export type GoalEvent = { eventId: string; text: string; refs?: GoalReference[]; receivedAt?: string };
export type GoalRequirement = { id: string; text: string; sourceEventIds: string[]; verificationKind?: GoalVerificationKind };
export type GoalEvidence = {
  id: string;
  requirementId: string;
  version: string;
  provenance: string;
  observedAt: string;
  freshUntil?: string;
  materialLoaded: boolean;
  text?: string;
  sourceKind?: GoalVerificationKind;
};
export type GoalSnapshot = {
  identity: GoalIdentity;
  armed: boolean;
  completed: boolean;
  stopped: boolean;
  goalRevision: number;
  primaryEvents: GoalEvent[];
  requirements: GoalRequirement[];
  inputCursor: number;
  processedInputCursor: number;
  evidenceVersion: number;
  controlEpoch: number;
  evidence: GoalEvidence[];
  goalHistory: ArchivedGoal[];
  evaluation?: GoalEvaluationState;
  nativeCursor?: string;
};
export type CompletionTicket = {
  identity: GoalIdentity;
  goalRevision: number;
  inputCursor: number;
  processedInputCursor: number;
  evidenceVersion: number;
  controlEpoch: number;
  nativeCursor?: string;
  issuedAt: string;
};
export type CompletionCheck = { ok: true; ticket: CompletionTicket } | { ok: false; reasons: string[] };
export type ContinuationAdmission<T> = { admitted: true; result: T } | { admitted: false; reason: string };
export type ContinuationReceiptClass = "accepted" | "unknown" | "not-admitted";
export type ContinuationSubmission<T> = {
  actionFingerprint: string;
  evidenceFingerprint: string;
  classify: (result: T) => ContinuationReceiptClass;
};
export type GoalFence = Pick<GoalSnapshot, "identity" | "goalRevision" | "inputCursor" | "processedInputCursor" | "evidenceVersion" | "controlEpoch" | "nativeCursor">;
export type GoalEvaluationMetadata = {
  requirementMemo: GoalRequirementMemo;
  requirementsStatus: Array<{ id: string; status: "open" | "fulfilled" | "blocked"; evidenceIds: string[] }>;
  lastDecision: "continue" | "blocked" | "done-candidate";
  lastReason?: string;
  usage?: GoalModelUsage;
};
export type GoalEvaluationState = Partial<GoalEvaluationMetadata> & {
  /** Control epoch for which this evaluation status/reason was recorded. */
  controlEpoch?: number;
  lastAdmission?: {
    actionFingerprint: string;
    evidenceFingerprint: string;
    inputCursor: number;
    goalRevision: number;
    evidenceVersion: number;
    controlEpoch: number;
    nativeCursor?: string | null;
    outcome: "accepted" | "unknown";
    admittedAt: string;
  };
};
export type ArchivedGoal = { primaryEvents: GoalEvent[]; requirements: GoalRequirement[]; evidence: GoalEvidence[]; evaluation?: GoalEvaluationState; completed: boolean; archivedAt: string };

type GoalFile = GoalSnapshot & { schemaVersion: 1; seenEventIds: string[]; goalHistory: ArchivedGoal[] };

/** Durable session-scoped goal state. Files are addressed directly by identity; no directory scan is performed. */
export class GoalStore {
  constructor(private readonly stateDir: string) {}

  async arm(input: { identity: GoalIdentity; goal: GoalEvent; requirements: GoalRequirement[]; nativeCursor?: string }): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(input.identity);
    validateEvent(input.goal);
    const requirements = normalizeRequirements(input.requirements, [input.goal.eventId]);
    return this.mutate(identity, (file) => {
      if (file.goalRevision > 0) throw new Error("a durable goal already exists for this session; it cannot be replaced");
      file.identity = identity;
      file.armed = true;
      file.completed = false;
      file.stopped = false;
      file.goalRevision = 1;
      file.primaryEvents = [normalizeEvent(input.goal)];
      file.requirements = requirements;
      file.inputCursor = 1;
      file.processedInputCursor = 1;
      file.evidenceVersion = 0;
      file.controlEpoch += 1;
      file.evidence = [];
      file.nativeCursor = input.nativeCursor === undefined ? undefined : normalizeNativeCursor(input.nativeCursor);
      file.seenEventIds = [input.goal.eventId];
      return copySnapshot(file);
    });
  }

  /** Re-enable the same objective after stop without replacing its source text or requirements. */
  async resume(identityInput: GoalIdentity): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(identityInput);
    return this.mutate(identity, (file) => {
      if (file.goalRevision === 0 || file.completed) throw new Error("no resumable incomplete goal exists for this session");
      if (!file.armed || file.stopped) {
        if (file.stopped) {
          if (file.evaluation) file.evaluation.controlEpoch ??= file.controlEpoch;
          file.controlEpoch += 1;
        }
        file.armed = true;
        file.stopped = false;
        file.completed = false;
      }
      return copySnapshot(file);
    });
  }

  /** Explicitly start a new assignment while retaining the previous goal's complete primary history. */
  async newGoal(input: { identity: GoalIdentity; goal: GoalEvent; requirements: GoalRequirement[]; nativeCursor?: string }): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(input.identity);
    validateEvent(input.goal);
    return this.mutate(identity, (file) => {
      if (!file.completed && !file.stopped) throw new Error("the current goal must be completed or stopped before starting a new one");
      if (file.seenEventIds.includes(input.goal.eventId)) throw new Error("new goal eventId must be unique for this session");
      const requirements = normalizeRequirements(input.requirements, [input.goal.eventId]);
      file.goalHistory.push({ primaryEvents: file.primaryEvents, requirements: file.requirements, evidence: file.evidence,
        ...(file.evaluation ? { evaluation: file.evaluation } : {}), completed: file.completed, archivedAt: new Date().toISOString() });
      file.armed = true;
      file.stopped = false;
      file.completed = false;
      file.goalRevision += 1;
      file.primaryEvents = [normalizeEvent(input.goal)];
      file.requirements = requirements;
      file.inputCursor += 1;
      file.processedInputCursor = file.inputCursor;
      file.evidence = [];
      file.evaluation = undefined;
      file.nativeCursor = input.nativeCursor === undefined ? undefined : normalizeNativeCursor(input.nativeCursor);
      file.evidenceVersion += 1;
      file.controlEpoch += 1;
      file.seenEventIds.push(input.goal.eventId);
      return copySnapshot(file);
    });
  }

  /** Store a primary human event exactly once; acceptance itself invalidates every old completion ticket. */
  async acceptHumanEvent(identityInput: GoalIdentity, event: GoalEvent): Promise<{ snapshot: GoalSnapshot; duplicate: boolean }> {
    const identity = normalizeIdentity(identityInput);
    validateEvent(event);
    return this.mutate(identity, (file) => {
      requireArmed(file);
      if (file.seenEventIds.includes(event.eventId)) {
        const prior = file.primaryEvents.find((item) => item.eventId === event.eventId);
        if (!prior || prior.text !== event.text || JSON.stringify(prior.refs ?? []) !== JSON.stringify(event.refs ?? [])) {
          throw new Error("human eventId was already accepted with different primary content");
        }
        return { snapshot: copySnapshot(file), duplicate: true };
      }
      file.primaryEvents.push(normalizeEvent(event));
      file.seenEventIds.push(event.eventId);
      file.goalRevision += 1;
      file.inputCursor += 1;
      if (file.evaluation) file.evaluation.controlEpoch ??= file.controlEpoch;
      file.controlEpoch += 1;
      file.completed = false;
      return { snapshot: copySnapshot(file), duplicate: false };
    });
  }

  /** Project accepted primary input into derived requirements, retaining source-event provenance. */
  async applyRequirements(identityInput: GoalIdentity, expected: GoalFence, throughCursor: number, requirements: GoalRequirement[]): Promise<GoalSnapshot | null> {
    const identity = normalizeIdentity(identityInput);
    return this.mutate(identity, (file) => {
      requireArmed(file);
      if (!fenceMatches(identity, file, expected)) return null;
      if (!Number.isInteger(throughCursor) || throughCursor < file.processedInputCursor || throughCursor > file.inputCursor) throw new Error("invalid goal input cursor");
      if (throughCursor !== expected.inputCursor) throw new Error("requirement projection must cover exactly the snapshotted input cursor");
      const normalized = normalizeRequirements(requirements, file.primaryEvents.map((event) => event.eventId));
      file.requirements = normalized;
      file.processedInputCursor = throughCursor;
      return copySnapshot(file);
    });
  }

  async recordEvidence(identityInput: GoalIdentity, evidence: GoalEvidence[]): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(identityInput);
    return this.mutate(identity, (file) => {
      requireArmed(file);
      const next = normalizeEvidence(evidence, file.requirements);
      if (JSON.stringify(next) !== JSON.stringify(file.evidence)) {
        file.evidence = next;
        file.evidenceVersion += 1;
        file.completed = false;
      }
      return copySnapshot(file);
    });
  }

  /** Persist UI/cache metadata only when the exact evaluation fence is still current. */
  async recordEvaluation(identityInput: GoalIdentity, expected: GoalFence, metadata: GoalEvaluationMetadata): Promise<GoalSnapshot | null> {
    const identity = normalizeIdentity(identityInput);
    const normalized = normalizeEvaluation(metadata);
    return this.mutate(identity, (file) => {
      requireArmed(file);
      if (!fenceMatches(identity, file, expected)) return null;
      if (normalized.requirementMemo.goalRevision !== String(file.goalRevision)) throw new Error("requirement memo belongs to a different goal revision");
      const eventIds = new Set(file.primaryEvents.map((event) => event.eventId));
      if (normalized.requirementMemo.requirements.some((item) => item.sourceEventIds.some((eventId) => !eventIds.has(eventId)))) throw new Error("requirement memo has invalid primary provenance");
      if ((normalized.requirementMemo.supersessions ?? []).some((item) => !eventIds.has(item.amendmentEventId) || item.previous.sourceEventIds.some((eventId) => !eventIds.has(eventId)))) throw new Error("requirement supersession has invalid primary provenance");
      assertSupersessionsAppendOnly(file.evaluation, normalized);
      const next: GoalEvaluationState = { ...normalized, controlEpoch: file.controlEpoch, ...(file.evaluation?.lastAdmission ? { lastAdmission: file.evaluation.lastAdmission } : {}) };
      if (JSON.stringify(file.evaluation) !== JSON.stringify(next)) file.evaluation = next;
      return copySnapshot(file);
    });
  }

  async snapshot(identityInput: GoalIdentity): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(identityInput);
    const file = await this.read(identity);
    if (file.goalRevision === 0) throw new Error("goal is not armed for this session");
    return copySnapshot(file);
  }

  /** Advance the verified native transcript cursor without changing goal or evidence versions. */
  async recordNativeCursor(identityInput: GoalIdentity, expected: GoalFence, cursor: string): Promise<boolean> {
    const identity = normalizeIdentity(identityInput);
    const nextCursor = normalizeNativeCursor(cursor);
    return this.mutate(identity, (file) => {
      requireArmed(file);
      if (!fenceMatches(identity, file, expected)) return false;
      if (file.nativeCursor === nextCursor) return true;
      file.nativeCursor = nextCursor;
      return true;
    });
  }

  async checkCompletion(identityInput: GoalIdentity, expected: GoalFence, auditEvidence?: GoalEvidence[]): Promise<CompletionCheck> {
    const identity = normalizeIdentity(identityInput);
    if (!sameIdentity(identity, normalizeIdentity(expected.identity))) return { ok: false, reasons: ["audit identity changed"] };
    return this.mutate(identity, (file) => {
    if (!fenceMatches(identity, file, expected)) return { ok: false, reasons: ["goal changed while completion audit was running"] };
    if (auditEvidence) {
      const next = normalizeEvidence(auditEvidence, file.requirements);
      if (JSON.stringify(next) !== JSON.stringify(file.evidence)) {
        file.evidence = next;
        file.evidenceVersion += 1;
        file.completed = false;
      }
    }
    const snapshot = copySnapshot(file);
    const reasons: string[] = [];
    if (snapshot.stopped || !snapshot.armed) reasons.push("goal is stopped or disabled");
    if (snapshot.inputCursor !== snapshot.processedInputCursor) reasons.push("accepted human input is not yet projected into requirements");
    if (!snapshot.requirements.length) reasons.push("requirements are missing");
    const events = new Set(snapshot.primaryEvents.map((event) => event.eventId));
    for (const requirement of snapshot.requirements) {
      if (!requirement.sourceEventIds.length || requirement.sourceEventIds.some((id) => !events.has(id))) reasons.push(`requirement ${requirement.id} has missing primary provenance`);
      const proof = snapshot.evidence.find((e) => e.requirementId === requirement.id && (e.sourceKind ?? "file") === (requirement.verificationKind ?? "file") && e.materialLoaded && e.provenance.trim() && e.version.trim()
        && (!e.freshUntil || Date.parse(e.freshUntil) > Date.now()));
      if (!proof) reasons.push(`requirement ${requirement.id} lacks fresh, loaded, provenance-backed evidence`);
    }
    if (reasons.length) return { ok: false, reasons };
    return { ok: true, ticket: ticketFrom(snapshot) };
    });
  }

  /** Compare-and-set under the same process/file lock used by input acceptance and stop. */
  async applyCompletion(identityInput: GoalIdentity, ticket: CompletionTicket): Promise<boolean> {
    const identity = normalizeIdentity(identityInput);
    if (!sameIdentity(identity, normalizeIdentity(ticket.identity))) return false;
    return this.mutate(identity, (file) => {
      if (!file.armed || file.stopped || file.completed || file.inputCursor !== file.processedInputCursor
        || ticket.goalRevision !== file.goalRevision || ticket.inputCursor !== file.inputCursor
        || ticket.processedInputCursor !== file.processedInputCursor || ticket.evidenceVersion !== file.evidenceVersion
        || ticket.controlEpoch !== file.controlEpoch || ticket.nativeCursor !== file.nativeCursor) return false;
      const events = new Set(file.primaryEvents.map((event) => event.eventId));
      const now = Date.now();
      const valid = file.requirements.length > 0 && file.requirements.every((requirement) =>
        requirement.sourceEventIds.length > 0 && requirement.sourceEventIds.every((id) => events.has(id))
        && file.evidence.some((e) => e.requirementId === requirement.id && (e.sourceKind ?? "file") === (requirement.verificationKind ?? "file") && e.materialLoaded && !!e.provenance.trim() && !!e.version.trim()
          && (!e.freshUntil || Date.parse(e.freshUntil) > now)));
      if (!valid) return false;
      file.completed = true;
      return true;
    });
  }

  /** Hold the per-goal lock through only native continuation admission, ordering human acceptance after it. */
  async withContinuationAdmission<T>(identityInput: GoalIdentity, expected: GoalFence, admit: () => Promise<T>, submission?: ContinuationSubmission<T>): Promise<ContinuationAdmission<T>> {
    const identity = normalizeIdentity(identityInput);
    if (!sameIdentity(identity, normalizeIdentity(expected.identity))) return { admitted: false, reason: "goal identity changed" };
    if (submission) {
      validateFingerprint(submission.actionFingerprint, "actionFingerprint");
      validateFingerprint(submission.evidenceFingerprint, "evidenceFingerprint");
      if (typeof submission.classify !== "function") throw new Error("continuation submission needs a receipt classifier");
    }
    return this.mutate(identity, async (file) => {
      if (!file.armed || file.stopped || file.completed) return { admitted: false, reason: "goal is not active" };
      if (!fenceMatches(identity, file, expected)) return { admitted: false, reason: "goal fence changed" };
      if (file.inputCursor !== file.processedInputCursor) return { admitted: false, reason: "accepted human input is pending projection" };
      const result = await admit();
      const outcome = submission?.classify(result);
      if (submission && (outcome === "accepted" || outcome === "unknown")) {
        const evaluation: GoalEvaluationState = file.evaluation ?? {};
        evaluation.lastAdmission = {
          actionFingerprint: submission.actionFingerprint,
          evidenceFingerprint: submission.evidenceFingerprint,
          inputCursor: file.inputCursor,
          goalRevision: file.goalRevision,
          evidenceVersion: file.evidenceVersion,
          controlEpoch: file.controlEpoch,
          nativeCursor: file.nativeCursor ?? null,
          outcome,
          admittedAt: new Date().toISOString(),
        };
        file.evaluation = evaluation;
      }
      return { admitted: true, result };
    });
  }

  async stop(identityInput: GoalIdentity): Promise<GoalSnapshot> {
    const identity = normalizeIdentity(identityInput);
    return this.mutate(identity, (file) => {
      file.armed = false;
      file.stopped = true;
      file.controlEpoch += 1;
      return copySnapshot(file);
    });
  }

  private path(identity: GoalIdentity): string {
    const key = createHash("sha256").update(`${identity.harness}\0${identity.sessionId}\0${identity.cwd}`).digest("hex");
    return join(this.stateDir, "goals", `${key}.json`);
  }

  private async read(identity: GoalIdentity): Promise<GoalFile> {
    try {
      const raw = JSON.parse(await readFile(this.path(identity), "utf8")) as GoalFile;
      if (raw.schemaVersion !== 1 || !sameIdentity(normalizeIdentity(raw.identity), identity)) throw new Error("invalid goal store identity or schema");
      raw.goalHistory ??= [];
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile(identity);
      throw error;
    }
  }

  private async mutate<T>(identity: GoalIdentity, update: (file: GoalFile) => T | Promise<T>): Promise<T> {
    const path = this.path(identity);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockTarget = `${path}.lock`;
    await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 } });
    try {
      const file = await this.read(identity);
      const before = JSON.stringify(file);
      const result = await update(file);
      if (JSON.stringify(file) !== before) {
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, path);
        } finally {
          const { unlink } = await import("node:fs/promises");
          await unlink(temporary).catch(() => undefined);
        }
      }
      return result;
    } finally { await release(); }
  }
}

function emptyFile(identity: GoalIdentity): GoalFile {
  return { schemaVersion: 1, identity, armed: false, completed: false, stopped: false, goalRevision: 0, primaryEvents: [], requirements: [], inputCursor: 0, processedInputCursor: 0, evidenceVersion: 0, controlEpoch: 0, evidence: [], goalHistory: [], seenEventIds: [] };
}
function copySnapshot(file: GoalFile): GoalSnapshot { return structuredClone({ ...file, seenEventIds: undefined }) as unknown as GoalSnapshot; }
function ticketFrom(s: GoalSnapshot): CompletionTicket { return { identity: s.identity, goalRevision: s.goalRevision, inputCursor: s.inputCursor, processedInputCursor: s.processedInputCursor, evidenceVersion: s.evidenceVersion, controlEpoch: s.controlEpoch, ...(s.nativeCursor === undefined ? {} : { nativeCursor: s.nativeCursor }), issuedAt: new Date().toISOString() }; }
function fenceMatches(identity: GoalIdentity, file: GoalSnapshot, fence: GoalFence): boolean {
  return sameIdentity(identity, normalizeIdentity(fence.identity)) && fence.goalRevision === file.goalRevision
    && fence.inputCursor === file.inputCursor && fence.processedInputCursor === file.processedInputCursor
    && fence.evidenceVersion === file.evidenceVersion && fence.controlEpoch === file.controlEpoch
    && fence.nativeCursor === file.nativeCursor;
}
function normalizeNativeCursor(cursor: string): string {
  if (typeof cursor !== "string" || !cursor.trim() || cursor.length > 512 || cursor.includes("\0")) throw new Error("native cursor must be bounded non-empty text");
  return cursor.trim();
}
function normalizeIdentity(value: GoalIdentity): GoalIdentity {
  if (!value || typeof value.harness !== "string" || !value.harness.trim() || typeof value.sessionId !== "string" || !value.sessionId.trim() || typeof value.cwd !== "string" || !value.cwd.trim()) throw new Error("goal identity requires harness, sessionId and cwd");
  return { harness: value.harness.trim(), sessionId: value.sessionId.trim(), cwd: value.cwd.trim() };
}
function sameIdentity(a: GoalIdentity, b: GoalIdentity): boolean { return a.harness === b.harness && a.sessionId === b.sessionId && a.cwd === b.cwd; }
function validateEvent(event: GoalEvent): void { if (!event || !event.eventId?.trim() || !event.text?.trim()) throw new Error("primary human event needs eventId and full text"); }
function normalizeEvent(event: GoalEvent): GoalEvent { return { eventId: event.eventId, text: event.text, refs: (event.refs ?? []).map((r) => ({ uri: r.uri, ...(r.label ? { label: r.label } : {}) })), receivedAt: event.receivedAt ?? new Date().toISOString() }; }
function normalizeRequirements(items: GoalRequirement[], eventIds: string[]): GoalRequirement[] {
  const known = new Set(eventIds); const ids = new Set<string>();
  return items.map((r) => {
    if (!r.id?.trim() || !r.text?.trim() || ids.has(r.id)) throw new Error("requirements need unique ids and non-empty text");
    ids.add(r.id);
    if (!r.sourceEventIds?.length || r.sourceEventIds.some((id) => !known.has(id))) throw new Error(`requirement ${r.id} has invalid primary provenance`);
    const verificationKind = r.verificationKind ?? "file";
    if (verificationKind !== "file" && verificationKind !== "native-report") throw new Error("invalid requirement verification kind");
    return { id: r.id, text: r.text, sourceEventIds: [...new Set(r.sourceEventIds)], verificationKind };
  });
}
function normalizeEvidence(items: GoalEvidence[], requirements: GoalRequirement[]): GoalEvidence[] {
  const allowed = new Set(requirements.map((r) => r.id)); const ids = new Set<string>();
  return items.map((e) => {
    if (!e.id?.trim() || ids.has(e.id) || !allowed.has(e.requirementId) || !e.version?.trim() || !e.provenance?.trim() || !Number.isFinite(Date.parse(e.observedAt)) || typeof e.materialLoaded !== "boolean" || (e.text !== undefined && (typeof e.text !== "string" || Buffer.byteLength(e.text, "utf8") > 1024 * 1024))) throw new Error("invalid goal evidence or provenance");
    ids.add(e.id);
    if (e.freshUntil && !Number.isFinite(Date.parse(e.freshUntil))) throw new Error("invalid evidence freshness bound");
    const sourceKind = e.sourceKind ?? "file";
    if (sourceKind !== "file" && sourceKind !== "native-report") throw new Error("invalid evidence source kind");
    return { ...e, sourceKind };
  });
}
function normalizeEvaluation(metadata: GoalEvaluationMetadata): GoalEvaluationMetadata {
  if (!metadata || !["continue", "blocked", "done-candidate"].includes(metadata.lastDecision)) throw new Error("invalid goal evaluation decision");
  const memo = metadata.requirementMemo;
  if (!memo || typeof memo.goalRevision !== "string" || !memo.goalRevision || typeof memo.primaryHash !== "string" || !memo.primaryHash
    || (memo.formatVersion !== undefined && memo.formatVersion !== 2)
    || !Array.isArray(memo.requirements) || memo.requirements.length > 512 || (memo.supersessions !== undefined && (!Array.isArray(memo.supersessions) || memo.supersessions.length > 512))) {
    throw new Error("invalid goal requirement memo");
  }
  const requirementIds = new Set<string>();
  const requirements = memo.requirements.map((item) => {
    if (!item.id?.trim() || requirementIds.has(item.id) || !Array.isArray(item.sourceEventIds) || item.sourceEventIds.length === 0 || item.sourceEventIds.length > 512) throw new Error("invalid memo requirement");
    requirementIds.add(item.id);
    const verificationKind = item.verificationKind ?? "file";
    if (verificationKind !== "file" && verificationKind !== "native-report") throw new Error("invalid memo verification kind");
    return { id: safeMetadataText(item.id, 256), text: safeMetadataText(item.text, 2048), sourceEventIds: item.sourceEventIds.map((id) => safeMetadataText(id, 512)), verificationKind };
  });
  const supersessions = (memo.supersessions ?? []).map((item) => ({
    requirementId: safeMetadataText(item.requirementId, 256), amendmentEventId: safeMetadataText(item.amendmentEventId, 512),
    ...(item.replacementRequirementId ? { replacementRequirementId: safeMetadataText(item.replacementRequirementId, 256) } : {}),
    reason: safeMetadataText(item.reason, 2048),
    previous: { id: safeMetadataText(item.previous.id, 256), text: safeMetadataText(item.previous.text, 2048), sourceEventIds: item.previous.sourceEventIds.map((id) => safeMetadataText(id, 512)) },
  }));
  const statuses = metadata.requirementsStatus;
  if (!Array.isArray(statuses) || statuses.length > 512) throw new Error("invalid goal requirement status projection");
  const statusIds = new Set<string>();
  const requirementsStatus = statuses.map((item) => {
    if (!item.id?.trim() || statusIds.has(item.id) || !["open", "fulfilled", "blocked"].includes(item.status) || !Array.isArray(item.evidenceIds) || item.evidenceIds.length > 512) throw new Error("invalid goal requirement status");
    statusIds.add(item.id);
    return { id: safeMetadataText(item.id, 256), status: item.status, evidenceIds: item.evidenceIds.map((id) => safeMetadataText(id, 512)) };
  });
  const lastReason = metadata.lastReason === undefined ? undefined : safeMetadataText(metadata.lastReason, 2048);
  let usage: GoalModelUsage | undefined;
  if (metadata.usage !== undefined) {
    const inputTokens = metadata.usage.inputTokens;
    const outputTokens = metadata.usage.outputTokens;
    const cachedInputTokens = metadata.usage.cachedInputTokens;
    for (const count of [inputTokens, outputTokens, cachedInputTokens]) if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)) throw new Error("invalid goal evaluation usage");
    usage = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) };
  }
  const normalized: GoalEvaluationMetadata = {
    requirementMemo: { goalRevision: safeMetadataText(memo.goalRevision, 64), primaryHash: safeMetadataText(memo.primaryHash, 256), ...(memo.formatVersion === undefined ? {} : { formatVersion: memo.formatVersion }), requirements,
      ...(supersessions.length ? { supersessions } : {}) },
    requirementsStatus, lastDecision: metadata.lastDecision,
    ...(lastReason === undefined ? {} : { lastReason }), ...(usage === undefined ? {} : { usage }),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 128 * 1024) throw new Error("goal evaluation metadata exceeds 128 KiB");
  return normalized;
}
function safeMetadataText(value: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) throw new Error("invalid bounded goal evaluation text");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s,;]{8,})/iu.test(value)) {
    throw new Error("goal evaluation metadata contains credential-shaped text");
  }
  return value;
}
function assertSupersessionsAppendOnly(previous: GoalEvaluationState | undefined, next: GoalEvaluationState): void {
  const prior = previous?.requirementMemo?.supersessions ?? [];
  const incoming = next.requirementMemo?.supersessions ?? [];
  for (const supersession of prior) {
    const key = `${supersession.requirementId}\0${supersession.amendmentEventId}`;
    const match = incoming.find((item) => `${item.requirementId}\0${item.amendmentEventId}` === key);
    if (!match || JSON.stringify(match) !== JSON.stringify(supersession)) throw new Error("goal requirement supersessions are append-only");
  }
}
function validateFingerprint(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) throw new Error(`${label} must be bounded non-empty text`);
}
function requireArmed(file: GoalFile): void { if (!file.armed || file.stopped) throw new Error("goal is not armed"); }
