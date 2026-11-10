# RECONCILE10 — evidence reconciliation (2026-11-10)

Scope: read-only reconciliation of the original Herder V1 fullcycle. Canonical checkout `/home/roomhacker/agents-projects/agent-herder`, `main` at `1fcac12e511d17d203ab8a08fb662f2a1f7b46b1` (origin/main). No source/runtime/plan edits or external mutations performed. The only owned write is this file. Existing dirty `plan.*`, `lead-status.md`, and untracked MRESUME10/STATE10/CIROUTE10/RECONCILE10 leaves were preserved.

## Installed NoticePlace proof and identity

**Confirmed successful final cycle (historical installed runtime, 2026-11-08):** final release source `abd9a50fd5ee9f29f6598ab765de0eaa2aa8fcd9`; manifest `/home/roomhacker/herder-artifacts/releases/abd9a50fd5ee9f29f6598ab765de0eaa2aa8fcd9/noticeplace-manifest.json`, SHA256 `e30923f3b677b1b192a5980f34db1fb914caf91b34b9d7154bb34459d0d982be`. Completion handoff records active installed unit, queue mode and `incidentProgressPlanId=repair`; the independently inspected currently configured `agent-herder-v1-noticeplace.service` still points to this launcher/release. The manifest itself hashes to the SHA above.

Exact final2 live identities and receipts:

- Incident `inc_36bb1ad1283d43aa8bc5c6df1457128d`; native worker `ses_e430ed432ffe68MLZ5SaT1gWR5`; core ref `session:4be97d2e9d3b3dd088a13cbbf9532930`.
- Launch delivery `dlv_6eba2ba9aa06459fb0325b11e2009eee`; fixture measured HTTP 200, `healthy`, `repairs=1`.
- Automatic completion/check `check_3d43263852dc4e29a6efbdc79e86af49`, generation 1; completion job `job_62ee41a3d326b3e329efdc69bb38708a6211f6076aa230c4a0c39626d8a5c0bd` completed; judge job `job_088fff8563e9bf8aab22fbb702686181d720e791127cf63e936c31404ac5bb75` completed, `kind=done`; judge native `ses_e430c1254ffenk4I1fPofB8w63`.
- Independent SourceVerifier principal `source:agent-herder`, request `check_3d43263852dc4e29a6efbdc79e86af49`, measured the fixture healthy and resolved the same incident. No manual native/core ID edits in final2.
- Same-session resume preserved both IDs, input `np-final2-resume-7e4708cd-20261108`, native receipt `ahap-receipt:v1:{"kind":"message","native_id":"msg_1bcfc65490019mYbMvK0GCsjYO"}`, returned prior fixture context with zero tool calls.
- Saved progress outbox was drained exactly once under the original idempotency key; callback HTTP 200/count 1; post-drain readback found exactly one matching progress event. It made zero native sends, zero judge calls and zero generic notify calls. `human_delivery_count=0`; five exact known test sessions archived; three fixture ports closed; active jobs/pending updates 0. Do not replay.

Evidence (all in `.agents/tasks/20261107-herder-v1-core/`):

- `HANDOFF-COMPLETED-20261108.md` — end-to-end result, release identity, receipts and cleanup.
- `evidence/finish-20261108/chatgpt-handoff-continuation.json` — final completion attribution, release SHA, incident/session IDs and final source checks.
- `evidence/finish-20261108/noticeplace-final2-judge-proof.json` — matching native/core identity, jobs, judge terminal result, zero manual sends/identity changes/callbacks during automatic test window.
- `evidence/finish-20261108/noticeplace-final2-source-proof.json` — exact independent check, measured HTTP 200/healthy/repairs 1, resolved state.
- `evidence/finish-20261108/noticeplace-final2-resume-proof.json` — same-session resume and exact native receipt.
- `evidence/finish-20261108/noticeplace-final2-outbox-proof.json` and `noticeplace-final2-post-drain-proof.json` — one-time saved progress drain and independent post-readback.
- `evidence/finish-20261108/noticeplace-test-cleanup.json` — archived sessions, resolved incidents, zero human delivery, fixture cleanup.
- `evidence/finish-20261108/final-focused-green.log` — 6 suites / 78 tests; `HANDOFF-COMPLETED-20261108.md` records final 8 suites / 114 tests plus tsc/build exit 0.

**Distinction:** this is accepted installed/live proof for the Nov 8 final2 operation, and the current service unit configuration still references its immutable release. It is not a fresh Nov 10 repair. No live incident was created or re-run.

## Requested leaf reconciliation

`done` below means the leaf's stated, bounded acceptance is evidenced. It does not imply the full 5-harness V1 plan is done. `Owner-deferred` marks explicitly excluded/blocked work that should not be silently folded into these leaf closures.

| Leaf | Evidence-backed completion | Remaining / defect / status recommendation |
|---|---|---|
| `NPIDENTITY` | **Done.** Final2 proves exact native ID ↔ core ref with no manual correction; same-session queue resume receipt. Source commit `85aa674a…` contains identity fix. Evidence above plus `evidence/finish-20261108/identity-lookup-green.log`; bug `bugs/NPIDENTITY_LOOKUP_UNKNOWN.json` is `fixed` (RED 2 failed, GREEN 72 passed). Current leaf already says `done`. | No status change needed. Preserve the historical first-run/manual-ID incident as history; do not relabel it as final2. |
| `NPLIVEFINAL` | **Done for its acceptance.** Final2 automatic launch → repair → work_finished → completed judge → independent SourceVerifier resolved, exact IDs; resume and cleanup also proven. Exact receipt IDs above. Current leaf already says `done`. | Separate outbox recovery was a later one-time maintenance drain, proven and completed; zero human delivery. No status change and do not repeat drain. |
| `RESTORECORE` | **Acceptance is the first pure-functional public slice; COREWAKE and REMOTEFULL are separate proven later slices.** Current-main `cargo test --manifest-path Cargo.toml --lib` passed 203/203, including `domain::completion`; installed/live child→parent wake is evidenced in `evidence/finish-20261108/native-wake-final.md` and `native-wake-confirmed.json`, leaf `COREWAKE=done`; installed remote consumer is evidenced in `remote44-full-canary-metadata.json`, leaf `REMOTEFULL=done`. The early `restore-core-luna.md` is stale for later wiring. | Reconcile leaf against its narrow stated acceptance and exact source/receipt at the owning MCP record; do not claim remaining wake or remote wiring. The regression suite is source evidence, not full installed five-harness acceptance. |
| `RESTORECONTRACTS` | **Multiple scoped consumers are proven; integrated three-path acceptance remains incomplete.** Installed/live Codex 44 full consumer (`REMOTEFULL`), installed native completion wake (`COREWAKE`), and NoticePlace final2 each have separate receipts. A later remote AHAP read-only probe also succeeded for a Codex socket. | Keep overall contract leaf `running` until all three contracts are reconciled against the public installed Rust-core route and required executable acceptance. `restore-remote-terra.md` explicitly says isolated remote AHAP read is not an installed shared-core cross-host consumer; use that limitation, not its stale earlier HTTP 401 checkpoint. NoticePlace and wake results satisfy their respective scoped paths and must not be called unimplemented. |
| `27 open (Rust V1 graph as of STATUS-20261110)` | **No leaf closures inferred from aggregate count.** `evidence/ci-visible-20261109/runner-install-final/result.json` has installed workflow executed but installed functional status FAIL/all-five false. `evidence/ci-visible-20261109/collector-final-v3/result.json` explicitly says installed component FAIL/all-five false. | **Still 27 open on that snapshot.** Root blockers include public Vibe parent route mismatch in `STATUS-20261110.md`, five-harness receipts absent/UNKNOWN, ZCode installed create/read absent, and required installed consumer scenario. New NoticePlace final2 proof closes only its scoped leaves; it does not close unrelated graph nodes. Update exact per-leaf MCP states from their individual receipts; do not bulk-close the 27. |

### 27-open snapshot: leaf IDs and evidence-driven next status

The count comes from `STATUS-20261110.md` (58/85) and is a snapshot, not permission to overwrite per-leaf history. IDs below are the non-done leaf records visible in the canonical source leaves at reconciliation time; there are 32 including the four new Nov-10 work leaves and leaves whose status field is omitted. Five are new coordination/reconciliation leaves or already separately being worked, so they are not all part of the historical 27 count. For MCP, update only the matching original leaves with these recommendations and exact evidence; leave stale aggregate/generated views for the plan owner to regenerate.

| Leaf IDs | Finding | Recommended MCP action |
|---|---|---|
| `NPIDENTITY`, `NPLIVEFINAL` | Their source leaf snapshots are stale/absent-status relative to the completed handoff; canonical local `plan.graph.json` and `HANDOFF-COMPLETED-20261108.md` record completed results. | Set `done` with exact proof refs above (if already done in live MCP, no-op). |
| `RESTORECORE`, `RESTORECONTRACTS`, `RESTORELEGACY`, `RESTOREPROOF` | First functional slice, installed wake, installed remote consumer and NoticePlace final2 have separate evidence; full aggregate cycle is not proven done. | Keep parent/full-cycle leaves at MCP states, cite completed narrow leaves and preserve exact aggregate gaps. Do not call proven wake/remote44/NoticePlace paths unimplemented. |
| `CIINSTALLFINAL`, `CINATIVE`, `CHATB2`, `QUIET429` | Explicitly `blocked`; installed result files report FAIL and/or provider/route precondition unresolved. | Keep `blocked`; cite exact owner blocker from each leaf/result. Do not convert provider/network UNKNOWN into success. |
| `S1`, `S2`, `S3`, `FIX`, `C14`, `READBACK`, `CIROUTE10`, `MRESUME10`, `STATE10` | Consumer/public route, final package or installed readback has not been shown complete by this reconciliation; some are current Nov-10 leaves. | Preserve active/current statuses; close only after matching installed receipt. Do not claim “installed V1 complete”. |
| `NCHAT`, `NZAI`, `PROFILELIVE`, `B13`, `FIXBI`, `FIXC`, `FIXQC`, `FIXQW`, `FIXZ`, `N1` | Per-lane/provider or negative-proof tasks; earlier receipts include provider capacity/transport refusals and/or candidate-only evidence. | Preserve UNKNOWN/refusal or existing terminal source result; no new native operation. Reconcile each from its own exact receipt before status mutation. |
| `C10`-adjacent packaging/bootstrap (`C13`), `WORKSPACEAUTO`, `USERIOQUIET`, `NETDIAG`, `BROWSERRECOVER`, `R2`, `R3`, `RECONCILE10` | Ancillary, explicitly deferred, read-only, publication, or current-task leaves; not evidence for five-lane installed acceptance. | Leave at current status/owner. Do not promote these to V1 acceptance. `RECONCILE10` may be completed after this file is attached by its authorized MCP owner. |

Source leaf enumeration returned 32 non-done records, not 27, because it includes newer coordination leaves and records without a `status` field. The authoritative historical 27 count remains the snapshot in `STATUS-20261110.md`; a plan owner should reconcile graph generation against MCP rather than derive counts from leaf JSON alone.

## Suggested MCP changes (do not hand-edit plan/leaves)

1. `NPIDENTITY` and `NPLIVEFINAL` are already `done` in source leaves; no MCP status change. Retain the proof references above.
2. `RESTORECORE`: reassess using its narrow first pure-functional public slice acceptance and cite current focused core tests; cite `COREWAKE`/`REMOTEFULL` evidence for already accepted later wiring. Do not re-open completed slices.
3. `RESTORECONTRACTS` remains `running`: cite installed remote44, live wake and NoticePlace receipts as completed scoped paths. Remaining requirement: prove all declared consumer contracts through the public installed Rust-core → existing AHAP → existing TypeScript adapter route; isolated remote AHAP access alone does not prove that route.
4. Do not change `RESTORELEGACY`/milestones to done. Keep installed five-lane leaves blocked/unknown until actual installed lane receipts exist; the Nov-8 NoticePlace proof is only one scoped consumer.
5. Do not change `RESTORELEGACY`/milestones to done. Keep installed five-lane leaves blocked/unknown until actual installed lane receipts exist; the Nov-8 NoticePlace proof is only one scoped consumer.

No additional NoticePlace create/repair/resume/drain/archive, model send, phone call, external message, plan mutation or test was performed. Cost and model token consumption for this reconciliation: **unknown**; no authoritative measurement was collected.
