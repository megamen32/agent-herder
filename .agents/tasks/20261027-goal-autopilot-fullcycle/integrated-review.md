# Integrated review — REVISE

Read-only review saved sources against task.md and council decision; no tests, native sessions, model calls, deployment, config or implementation edits. Foreign OAuth work untouched. Worker was still changing integration sources; line references describe the saved version read during this review. Existing focused-test claims are not independently rerun and no live acceptance is claimed.

Post-review worker notification: integration worker reports fixes for findings 1 and 2 (ticket-derived fence and explicit incomplete materials), saved after the reviewed reads. These fixes are not independently verified in this single review pass. Findings 3 and 4 remain actionable unless separately resolved; this is not a final verdict on later source revisions.

## Blocking findings

### 1. P1 — Successful audit cannot pass its own returned fence

`src/autopilot-runner.ts:307,327`; `src/autopilot/goal-store.ts:212–216`; `src/autopilot/background-stop.ts:69–70`.

`checkCompletion(..., activeEvidence)` persists the newly collected evidence and increments evidenceVersion. Its ticket contains that new version, but runner returns `goalFenceView(projected)` from before the mutation. Background compares that old version with the current store and returns stale-goal-fence. This is deterministic on the first successful proof. Each subsequent collection also changes observedAt/freshUntil, so full JSON comparison increments the version again even for unchanged content.

Smallest fix: return the exact fence represented by the issued completion ticket/post-check snapshot; keep completed application bound to that same ticket. Do not disable the background fence. Content-version equality should not be confused with observation timestamp equality when deciding whether semantic evidence changed.

### 2. P1 — Missing declared primary materials are silently absent from completion audit

`src/autopilot-runner.ts:256–258,272,291–294,335–342`; `src/autopilot/goal-evaluation.ts:36–41,106–110`; `src/web/autopilot-goal-api.ts:88–89`.

Events passed to the judge omit their refs. Collector failures appear only in `collected.unavailable`, which is not an evaluator input; materials contain successful reads only. Unsupported `herder-image://` refs are silently dropped. Thus an objective with a valid file plus an unavailable second file/image can receive all-fulfilled and complete based solely on the first file; neither audit nor structural validation knows that a primary material is missing. Merely requiring one material does not enforce complete primary context.

Smallest fix: preserve declared refs in primary audit input; represent every requested material as loaded or explicitly unavailable. Fail completion when any material required by the active goal is unresolved. Unsupported images must produce a visible blocker, not disappear. No need to implement generic image/tool adapters for this slice.

### 3. P1 — Old and fresh versions share evidence IDs in one audit

`src/autopilot-runner.ts:269–270`; `src/autopilot/goal-evidence.ts` evidence ID derives from requirementId + resolvedPath, while version derives from contents; `src/autopilot/goal-evaluation.ts:90–98,113–115`.

After a rejected completion persisted evidence, the next evaluation sends both snapshot evidence and newly read evidence. If the file changes within the old freshness interval, both entries are valid but have the same ID and different text/version. A model can reconcile against the old successful contents and cite that ID. Completion then installs fresh evidence and checks only fresh versions, not which version the audit proved. A stable ID alone is not a versioned proof.

Smallest fix: replace snapshot entries with current collector outcomes by evidence ID, including unavailable outcomes; never merge both versions into the evaluator. Bind audited references to the current observed version and compare that set at application.

### 4. P1 — Goal change can be accepted after the final continuation fence and before native admission

`src/autopilot/background-stop.ts:67–83`; `src/index.ts:1099–1112`; `src/web/autopilot-goal-api.ts:83–89`.

After the fence check there is an awaited rememberGeneratedPrompt, followed by delivery. A human amendment can acquire the GoalStore lock and be durably accepted during that interval. The selected delivery callback receives only prompt/inputId, not expected goal fence, so native admission can still execute the obsolete action. Store CAS protects completion, not this continuation transition.

Smallest fix: carry expected goal/control fence into the existing admission boundary and serialize admission with human input acceptance/Stop. A second check earlier in background only moves the race. Accepted/UNKNOWN delivery remains non-replayable.

## Contract gaps requiring explicit admission limits before QA

The goal API accepts Codex sessions without proving native Goals inactive (`src/web/autopilot-goal-api.ts:20–34`), and the goal branch exits before legacy controller safeguards (`src/autopilot-runner.ts:134–156`). The new path has no demonstrated durable per-goal budget/no-progress guard. These are not reasons to introduce another controller or scheduler. For isolated QA, enforce the selected harness/controller precondition and a bounded continuation allowance, and disclose that long-history completeness currently fails closed at 50 messages (`runner:365`). Do not call that full long-task acceptance.

## Positive scope assessment

Primary objective/events are durable; input acceptance and completion share a file lock/CAS; explicit Stop advances epoch; configured judge transport is honestly disclosed; declared file reads are bounded and read-only. These are useful foundations. Generic native tool proof and Codex subscription judging are not claimed here. Above defects prevent SHIP-for-isolated-QA on the reviewed snapshot; fixes need an updated targeted review/readback before live acceptance.

## Final delta readback — SHIP-for-isolated-QA

Read only the subsequent fixes requested by Lead; no second broad review, tests, native operations or model calls. The earlier REVISE describes the earlier snapshot; this is the current scoped verdict.

- Finding 1 resolved: runner returns `goalFenceView(check.ticket)` after evidence persistence (`autopilot-runner.ts:353–354`); completion CAS includes nativeCursor.
- Finding 2 resolved: failed collector outcomes and unsupported primary refs become `complete:false` materials (`runner:282–286,374–382`). The evaluator permits useful continuation, but completion additionally requires a nonempty set of entirely complete materials (`goal-evaluation.ts:119–123`). Missing primary proof cannot be overridden by an affirmative model verdict.
- Finding 3 resolved: the current collector overrides snapshot entries with the same evidence ID through Map insertion order (`runner:271,279`). Both conflicting versions no longer reach the judge.
- Finding 4 resolved for the supported Herder input/admission path: `withContinuationAdmission` checks the fence and pending input inside the same per-goal `mutate` file lock, and awaits native admission before releasing it (`goal-store.ts:294–322,353–365`). Background checks allowed/HumanStop and controller policy inside the callback (`background-stop.ts:92–108`). Durable lastAdmission fingerprints retain accepted/unknown outcomes; existing native delivery remains responsible for its accepted/UNKNOWN receipt and idempotency. This review does not claim a distributed transaction with the provider.
- Single-controller admission is explicit: standalone goal evaluation without nativeFence refuses control; Codex admission reads the exact thread's native Goals state and refuses active/paused/unreadable state, while unsupported harnesses fail closed (`goal-controller-admission.ts:5–22`). Hermes goal continuation is refused.
- Goal arm captures a native cursor baseline; subsequent checks require the exact anchor and inspect the delta. The old blanket 50-total-message prohibition is gone; missing anchor still fails closed. An explicitly armed blank session can reach its first evaluation (`goal-api:65–70`, `runner:412–427`, `background-stop:128–130`).
- Exact repeated action + unchanged goal/input/evidence is visibly refused (`runner:307–315`), using persisted accepted/unknown admission metadata. This is a bounded exact-repeat guard, not a claim that all semantic loops or paraphrases are detected.

No remaining blocker from the four reported defects was found in this delta. SHIP means proceed to the planned isolated QA for this declared-file, supported-controller slice. It does not mean install/live acceptance, general arbitrary native tool evidence, unlimited long-task reliability, a measured cache saving, or Codex-subscription judging is proven. Final type checking was still owned by the integration worker; no source was changed by this reviewer.
