import { createHash } from "node:crypto";
import { z } from "zod";

/** User events are the authority; summaries and agent messages are never inserted here. */
export type GoalUserEvent = { id: string; cursor: string; kind: "objective" | "amendment"; text: string };
export type GoalRequirement = { id: string; text: string; sourceEventIds: string[]; status: "open" | "fulfilled" | "blocked"; evidenceIds: string[] };
export type GoalEvidence = { id: string; requirementId: string; text: string; observedVersion: string; validUntil?: number; source: string; loaded?: boolean };
export type GoalMaterial = { id: string; text: string; complete: boolean; version: string };
export type GoalMemoKey = { goalRevision: string; inputCursor: string; evidenceVersion: string; controlEpoch: string };
export type GoalEvaluationInput = {
  goalRevision: string; fullObjective: string; userEvents: GoalUserEvent[]; inputCursor: string;
  requirements: GoalRequirement[]; evidence: GoalEvidence[]; evidenceVersion: string; controlEpoch: string;
  materials: GoalMaterial[]; requirementMemo?: GoalRequirementMemo; maxInputBytes?: number; now?: number;
};
export type GoalRequirementMemo = { goalRevision: string; primaryHash: string; requirements: Array<{ id: string; text: string; sourceEventIds: string[] }>; supersessions?: GoalSupersession[] };
export type GoalSupersession = { requirementId: string; amendmentEventId: string; replacementRequirementId?: string; reason: string; previous: { id: string; text: string; sourceEventIds: string[] } };
export type GoalModel = { call(request: { stage: "requirements" | "evidence-reconciliation" | "next-action" | "coverage-audit"; payload: unknown; maxOutputTokens: number }): Promise<unknown> };
export type GoalModelUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
export type GoalEvaluation = { memoKey: GoalMemoKey; requirementMemo: GoalRequirementMemo; supersessions: GoalSupersession[]; usage?: GoalModelUsage; requirements: GoalRequirement[]; decision: { kind: "continue"; nextAction: string } | { kind: "blocked"; reason: string } | { kind: "done-candidate"; summary: string; audit: "passed" } };

const requirementSchema = z.object({ id: z.string().min(1), text: z.string().min(1), sourceEventIds: z.array(z.string().min(1)).min(1), status: z.enum(["open", "fulfilled", "blocked"]), evidenceIds: z.array(z.string().min(1)) }).strict();
const requirementProjectionSchema = z.object({ id: z.string().min(1), text: z.string().min(1), sourceEventIds: z.array(z.string().min(1)).min(1) }).strict();
const supersessionSchema = z.object({ requirementId: z.string().min(1), amendmentEventId: z.string().min(1), replacementRequirementId: z.string().min(1).optional(), reason: z.string().min(1) }).strict();
const requirementsReply = z.object({ requirements: z.array(requirementSchema), supersessions: z.array(supersessionSchema) }).strict();
const actionReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue"), nextAction: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("complete"), summary: z.string().min(1) }).strict(),
]);
const evidenceReply = z.object({ assessments: z.array(z.object({ requirementId: z.string(), fulfilled: z.boolean(), evidenceIds: z.array(z.string()), reason: z.string() }).strict()) }).strict();
const auditReply = z.object({ complete: z.boolean(), coverage: z.array(z.object({ requirementId: z.string(), covered: z.boolean(), evidenceIds: z.array(z.string()) }).strict()), supersessionChecks: z.array(z.object({ requirementId: z.string(), confirmed: z.boolean(), amendmentEventId: z.string() }).strict()), summary: z.string().min(1) }).strict();
const MAX_BYTES = 256 * 1024;

function fail(message: string): never { throw new Error(`Goal evaluation fail-closed: ${message}`); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function validateMaterials(input: GoalEvaluationInput): void {
  if (!input.fullObjective.trim() || !input.userEvents.length) fail("full objective and primary user events are required");
  if (!input.userEvents.some(e => e.kind === "objective")) fail("primary objective event is missing");
  if (input.userEvents.some(e => !e.text.trim() || !e.id || !e.cursor)) fail("primary user event unavailable");
  if (bytes({ objective: input.fullObjective, events: input.userEvents, requirements: input.requirements, evidence: input.evidence, materials: input.materials }) > Math.min(input.maxInputBytes ?? MAX_BYTES, MAX_BYTES)) fail("input exceeds supported complete-context limit");
}
function memoKey(i: GoalEvaluationInput): GoalMemoKey { return { goalRevision: i.goalRevision, inputCursor: i.inputCursor, evidenceVersion: i.evidenceVersion, controlEpoch: i.controlEpoch }; }

export async function evaluateGoal(input: GoalEvaluationInput, model: GoalModel): Promise<GoalEvaluation> {
  try { return await evaluateGoalChecked(input, model); }
  catch (error) {
    const openLedger = input.requirements.map(r => ({ ...r, status: "open" as const, evidenceIds: [] }));
    return { memoKey: memoKey(input), requirementMemo: input.requirementMemo ?? { goalRevision: input.goalRevision, primaryHash: "", requirements: [] }, supersessions: [], requirements: openLedger, decision: { kind: "blocked", reason: error instanceof Error ? error.message : "Judge unavailable or returned invalid data" } };
  }
}

async function evaluateGoalChecked(input: GoalEvaluationInput, model: GoalModel): Promise<GoalEvaluation> {
  validateMaterials(input);
  const key = memoKey(input);
  const eventIds = new Set(input.userEvents.map(e => e.id));
  const current = new Map(input.requirements.map(r => [r.id, r]));
  if (current.size !== input.requirements.length) fail("duplicate requirement id");
  const primaryHash = createHash("sha256").update(JSON.stringify({ fullObjective: input.fullObjective, userEvents: input.userEvents })).digest("hex");
  // Requirements are reused only for this exact objective revision and primary material hash.
  const memoIsCurrent = input.requirementMemo?.goalRevision === input.goalRevision && input.requirementMemo.primaryHash === primaryHash;
  const projection = memoIsCurrent
    ? { requirements: input.requirementMemo!.requirements, supersessions: input.requirementMemo!.supersessions ?? [] }
    : requirementsReply.parse(await model.call({ stage: "requirements", maxOutputTokens: 6000, payload: { fullObjective: input.fullObjective, userEvents: input.userEvents, existingRequirements: input.requirements } }));
  const derived = projection.requirements.map(r => ({ ...r, status: "open" as const, evidenceIds: [] }));
  const supersessions: GoalSupersession[] = projection.supersessions.map(s => {
    const old = current.get(s.requirementId) ?? ("previous" in s ? s.previous : undefined);
    if (!old) fail("supersession cites unknown historical requirement");
    return { ...s, previous: { id: old.id, text: old.text, sourceEventIds: old.sourceEventIds } } as GoalSupersession;
  });
  const supersededIds = new Set(supersessions.map(s => s.requirementId));
  if (supersededIds.size !== supersessions.length) fail("duplicate supersession record");
  for (const supersession of supersessions) {
    const event = input.userEvents.find(e => e.id === supersession.amendmentEventId && e.kind === "amendment");
    if (!event || !supersession.reason.trim()) fail("supersession must cite a specific primary user amendment");
    if (supersession.replacementRequirementId && !derived.some(r => r.id === supersession.replacementRequirementId)) fail("supersession replacement is not in the active ledger");
  }
  const returned = new Map(derived.map(r => [r.id, r]));
  if (returned.size !== derived.length) fail("duplicate derived requirement id");
  for (const old of input.requirements) {
    const next = returned.get(old.id);
    if (!next && !supersededIds.has(old.id)) fail("requirement removed without explicit supersession record");
    if (next && (next.text !== old.text || old.sourceEventIds.some(id => !next.sourceEventIds.includes(id)))) fail("existing requirement rewritten; preserve it and supersede explicitly");
  }
  for (const r of derived) {
    if (!r.sourceEventIds.every(id => eventIds.has(id))) fail("requirement references non-primary event");
    const old = current.get(r.id);
    if (r.status !== "open" || r.evidenceIds.length) fail("requirement extraction cannot assert fulfillment");
  }
  const validEvidence = input.evidence.filter(e => e.loaded === true && e.text.trim() && e.source.trim() && e.observedVersion.trim() && (e.validUntil === undefined || e.validUntil > (input.now ?? Date.now())));
  const rawAssessments = evidenceReply.parse(await model.call({ stage: "evidence-reconciliation", maxOutputTokens: 3000, payload: { requirements: derived, evidence: validEvidence, materials: input.materials } })).assessments;
  const assessmentMap = new Map(rawAssessments.map(a => [a.requirementId, a]));
  if (assessmentMap.size !== rawAssessments.length || derived.some(r => !assessmentMap.has(r.id)) || rawAssessments.some(a => !derived.some(r => r.id === a.requirementId))) fail("evidence assessments must cover each current requirement exactly once");
  const ledger: GoalRequirement[] = derived.map(r => {
    const a = assessmentMap.get(r.id)!;
    if (a.evidenceIds.some(id => !validEvidence.some(e => e.id === id && e.requirementId === r.id))) fail("evidence assessment cites missing, stale, or mismatched evidence");
    if (a.fulfilled && !a.evidenceIds.length) fail("fulfilled requirement has no evidence");
    return { ...r, status: a.fulfilled ? "fulfilled" : "open", evidenceIds: a.fulfilled ? a.evidenceIds : [] };
  });
  if (!ledger.length) fail("requirement ledger is empty");
  const requirementMemo: GoalRequirementMemo = { goalRevision: input.goalRevision, primaryHash, requirements: derived.map(({ id, text, sourceEventIds }) => ({ id, text, sourceEventIds })), supersessions };
  const liveEvidence = validEvidence;
  const action = actionReply.parse(await model.call({ stage: "next-action", maxOutputTokens: 2000, payload: { fullObjective: input.fullObjective, userEvents: input.userEvents, requirements: ledger, evidence: liveEvidence, materials: input.materials } }));
  if (action.kind !== "complete") return { memoKey: key, requirementMemo, supersessions, requirements: ledger, decision: action };
  if (ledger.some(r => r.status !== "fulfilled")) return { memoKey: key, requirementMemo, supersessions, requirements: ledger, decision: { kind: "blocked", reason: "Completion proposed while requirements remain open or blocked" } };
  // Completion is provisional until a distinct audit sees every accessible primary source in full.
  validateMaterials(input);
  const audit = auditReply.parse(await model.call({ stage: "coverage-audit", maxOutputTokens: 4000, payload: { fullObjective: input.fullObjective, userEvents: input.userEvents, requirements: ledger, supersessions, evidence: liveEvidence, materials: input.materials } }));
  const auditMap = new Map(audit.coverage.map(c => [c.requirementId, c]));
  const required = ledger.map(r => r.id);
  const coverageValid = auditMap.size === audit.coverage.length && required.length === auditMap.size && required.every(id => {
    const c = auditMap.get(id); const req = ledger.find(r => r.id === id)!;
    return !!c?.covered && req.evidenceIds.length > 0 && c.evidenceIds.length > 0 && c.evidenceIds.every(eid => req.evidenceIds.includes(eid) && liveEvidence.some(e => e.id === eid && e.requirementId === id));
  });
  const supersessionChecks = new Map(audit.supersessionChecks.map(c => [c.requirementId, c]));
  const supersessionsValid = supersessionChecks.size === audit.supersessionChecks.length && supersessions.length === supersessionChecks.size && supersessions.every(s => {
    const check = supersessionChecks.get(s.requirementId);
    return !!check?.confirmed && check.amendmentEventId === s.amendmentEventId && s.previous.id === s.requirementId;
  });
  const materialsComplete = input.materials.length > 0 && input.materials.every(m => m.complete && !!m.text && !!m.version);
  if (!audit.complete || !coverageValid || !supersessionsValid || !materialsComplete) {
    const reason = !materialsComplete ? "Primary result materials are missing or incomplete" : `Per-requirement coverage or supersession audit failed: ${audit.summary}`;
    return { memoKey: key, requirementMemo, supersessions, requirements: ledger, decision: { kind: "blocked", reason } };
  }
  return { memoKey: key, requirementMemo, supersessions, requirements: ledger, decision: { kind: "done-candidate", summary: audit.summary, audit: "passed" } };
}

export function goalMemoFingerprint(key: GoalMemoKey): string { return createHash("sha256").update(JSON.stringify(key)).digest("hex"); }
