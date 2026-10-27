# Goal storage worker result

Implemented `src/autopilot/goal-store.ts` as a durable per-session store under the existing autopilot state directory (`goals/<identity-hash>.json`). Each operation addresses one identity directly; the store does not scan session files. Writes use `proper-lockfile`, reread under lock, atomically rename a temporary snapshot, and skip unchanged snapshots.

The API keeps complete primary human events and references append-only, derives requirements with source-event provenance, and tracks goal revision, accepted/processed input cursors, evidence version, and control epoch. Completion is split into a structural evidence check that issues a versioned ticket and a locked compare-and-set that rechecks every fence and evidence freshness. Accepted input increments the durable cursor and control epoch before return. Stop disables the goal and increments the epoch; state remains readable after restart. Evidence must state loaded material, provenance, version, observation time, and freshness bound when one applies.

Added isolated checks in `src/autopilot/goal-store.test.ts` for duplicate input, full-text persistence, stale completion tickets, pending projection, missing evidence, and stop across a new store instance.

Closed the audit/projection races: `checkCompletion(identity, expectedFence, auditEvidence?)` compares the identity and all revision/cursor/evidence/control versions under lock before accepting audit evidence or minting a ticket. `applyRequirements(identity, expectedFence, throughCursor, requirements)` rejects an obsolete extraction. `resume(identity)` re-arms the stopped incomplete objective without replacing primary text. `newGoal(...)` explicitly starts a different assignment only after stop/completion and archives the previous primary events, requirements and evidence.

Added isolated race checks for delayed audit versus late human input and stale requirement projection, plus resume and archived new-goal behavior.

## Verification

- `npx vitest run --root . --config vitest.config.ts src/autopilot/goal-store.test.ts` — 4 passed.
- `npx tsc --noEmit --pretty false` — passed after concurrent integration updates.

No runtime, deployment, configuration, model call, external effect, staging, commit, or push was performed.
