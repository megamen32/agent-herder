# Independent active-session review

2026-10-23 18:26 UTC. Read-only source/test review; product/runtime unchanged.

## Current verdict
Consumer acceptance NOT RUN: new feature not installed. R1 updater and production reader wiring fixes reviewed; 6 tests passed. R2 plus attribution finding R3 and native GUI coverage R4 remain with owners.

## R1 — workspace ingestion disconnected / first location frozen
`src/active-session-inventory.ts:41` constructed updater with `readEvidence:async()=>[]`. `createSessionWorkspaceOwnerUpdater` skipped every nonempty record. Counterexample: declare A, execute in B, activity changes; updater never reads B. Required regression A→A+B with independent evidence. Core/workspace owners acknowledged and are fixing background ingestion separately from fast materialization.

## R2 — startup declaration instruction not connected beyond tool description
`src/index.ts:647` registers workspace tools, but task-start declaration instruction appears only in `session_workspaces_declare` description. No lifecycle/server instruction invoking that seam found in current source. Existing common MCP instruction seam should tell every new session to declare exact runtime identity and real work host/path; capability availability alone is not lifecycle activation.

## Verified source guards
- Physical owner from local hostname; primary hostId matches workspaces, runtimeHostId independent.
- Totals before pagination; unknown workspace makes filtered exact count null.
- Dedicated coverage receipts, ZCode known-candidate coverage non-exhaustive.
- Slow provider does not block fresh provider publication. Read does not renew TTL.
- proper-lockfile, reload-under-lock, expectedVersion CAS. Durable declarations have no activity TTL.
- Mavis status_type 1 active despite retained error; metadata cursor-cycle validation.
- Parent inheritance only explicit native parent identity, same runtime/harness.
- Legacy list_agents explicitly directs current inventory to list_active_sessions.
- Native evidence persistence contains absolute path plus message/tool references; raw full tool command is not persisted. User-supplied evidence remains freeform; callers must not supply secrets.

## Validation
First focused run: active-session-inventory, session-workspaces, session-workspaces-backfill, opencode-active-runtime: 4 files, 17 passed. Second: minimax-active-runtime, minimax-active-native-proof, zcode-active-runtime, session-workspaces-owner: 3 files passed, 1 skipped; 8 tests passed, 2 skipped. Skipped native proofs do not establish installed acceptance. Durations 2.77s and 3.35s.

## Acceptance still required
Current native IDs vs installed command IDs, same observedAt window; roots/children counts; 1..N actual paths/evidence; three sequential read-only timed fleet queries with no LLM gaps. Dynamic live count has no fixed historical expectation. Native metadata status proof does not yet independently prove in-memory GUI generating/compacting-only coverage. No deployment, restarts, activation, messaging, or AI launches by reviewer.

## Re-review 18:28 UTC
R1 updater corrected in 9707c7a: known records can ingest changed native activity; inherited-only child follows exact parent version while own declarations/explicit clear stay authoritative. Production native reader wired and background ingestion does not block materializer. Rerun owner/backfill: 2 files, 6 passed.

## R3 — declared host is not per-tool execution host proof
Production resolver picks the single known ledger host then labels every extracted native shell path as that host. Counterexample: declared server100; native local M1 bash cwd=/Users/user/project -> false server100 workspace. Or ssh server44 with cd /home/roomhacker/other -> false server100. Need explicit native execution host/verified transport per event; leave uncertain paths unknown. Sent core+Lead.

## R4 — metadata-exhaustive differs from GUI-busy-exhaustive
`src/adapters/minimax-code-active.ts:59` says exhaustive true, while :60 only matches status_type 1. Required native GUI OR includes isGenerating, generatingBySession and compacting. Need prove those flags always imply started from current native source/runtime, or use specific gui_activity_flags_unobserved coverage reason and partial. No observed live omission is claimed; this is a source-level completeness gap, not a fabricated consumer failure. Sent Lead.

## Final source delta review 18:39 UTC — SOURCE GREEN
- R2 closed c51f74c: declaration instruction now in MCP initialization instructions, not just tool description.
- R3 closed 9614acd: only native tool.executionHostId or explicit MCP shell target establishes execution host; declared workHostId does not. Ambiguous local/SSH paths remain unknown. Native persistence contains paths and event references, not raw tool commands.
- R4 closed 656827d for actual accepted native execution contract: union metadata-started + read-only accepted-ingress candidate IDs, validate every candidate through current turn-continuation Running=2. Stale metadata Started cannot override idle controller; metadata Idle can still be active. Failed seed/per-ID reads yield partial receipt, retaining independent positives. Read-only SQLite selects only distinct session_id; no prompt/message/tool body or credentials read/persisted by this index. Source proof reviewed at canonical minimax-native-active-turn-source-proof.md; direct installed source absolute root not yet independently reread. Optimistic pre-acceptance GUI spinner states intentionally outside actual execution contract.
- Concurrent recovery regression was observed RED (21 pass, 1 fail), then fixed 74436ba and independently rerun GREEN: 4 files / 22 tests, 0 fail, 649ms vitest duration. Failed workspace reader does not stop other identities and retries unchanged failed identity after cooldown.

No source blockers remain from this bounded review. This statement is SOURCE GREEN only; installed consumer/API/MCP, current native ID equality, actual workspace inventory, and three sequential timed queries remain pending deployment readiness.
