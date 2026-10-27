# Goal evaluator worker result

Implemented `src/autopilot/goal-evaluation.ts` and focused tests in `goal-evaluation.test.ts`.

## API

`evaluateGoal(input: GoalEvaluationInput, model: GoalModel): Promise<GoalEvaluation>`.
The model is injected through `call({ stage, payload, maxOutputTokens })`; stages are
`requirements`, `evidence-reconciliation`, `next-action`, and `coverage-audit`. This reuses the caller's existing
judge route and creates no transport/provider.

Input preserves the full objective and ordered primary user events, cursor/revision,
requirements, versioned/freshness-bound evidence, control epoch, and all audit materials.
`GoalUserEvent.id` is the native human event id. Normalize storage events into this shape;
map store evidence freshness/provenance into `GoalEvidence`. `GoalRequirement` currently
includes status and evidence links in addition to the store's structural requirement.

Every primary user input must be complete and fit the bounded context; missing/incomplete
result materials are kept visible through requirement/evidence/action evaluation and included
in the separate coverage audit, but any missing, unloaded, or incomplete material forces a
blocked result. Oversize input, judge errors, and malformed model responses return `blocked`,
never done. Requirement extraction rejects invalid provenance and silent omissions. Supersession
requires a structured link to a specific accepted amendment; prior requirement details are
carried in the result archive, and the final audit confirms each retired item. Original
primary events remain stored. Requirements can be reused only via `requirementMemo` at the same revision and
primary hash. The separate evidence reconciliation must assess every requirement and can mark
it fulfilled only with listed evidence. Only evidence with `loaded === true`, sourced, versioned, and
fresh is provided; stale/revoked evidence therefore downgrades fulfillment back to open.
Completion is blocked for an empty or partly open ledger and when no audit materials are
available. A candidate completion always
triggers a separate per-requirement audit linking coverage to the same live evidence IDs.
`done-candidate` remains semantic only; storage `checkCompletion`/CAS ticket and
`applyCompletion` remain the authoritative freshness/atomicity barrier.

Memo fingerprint is derived from goal revision, input cursor, evidence version, and control
epoch. It is a dedupe hint only; recheck freshness before application. Usage accounting is
not exposed by the existing injected judge contract.

## Verification

Focused Vitest: 6 evaluator tests passed (per-requirement audit, incomplete material allowed
through evaluation but blocked at audit,
no model-created fulfillment, stale-evidence demotion, exact extraction-memo reuse, and
event-linked supersession with retained prior text).
No model/provider calls were made. `npx tsc --noEmit --pretty false` passed after the
concurrent integration files became syntactically valid.

No suite or runtime integration was performed. No source changes outside assigned ownership,
staging, or commit performed. Integration must pass/persist `requirementMemo`, map native
evidence loading/provenance/version/freshness faithfully, and always gate a candidate with
the storage CAS ticket/apply path.
