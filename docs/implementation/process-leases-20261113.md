# Herder process leases implementation

Status: local and remote integration, metadata wait gates and process diagnostics are committed at 1808bc6d7e2e3472e71e49e2c0038bb1472d4a83 in the isolated worktree. Its immutable candidate passed packaging and coherent Linux/Mac source verification. Full native acceptance and production migration remain incomplete. This task has not switched the shared runtime.
The user authorised the full plan on 2026-11-13.
Plan: https://chatgpt.com/space/page_835ee164266081918e5e4297ac92a2a3

## Source and ownership

Base: origin/main b371e9a0e57f12f44bf069ef5277e71afb81991f.
Latest fetched origin/main: a1c17a48ef05ff132af53f5018053e365cbece61, observed 2026-11-14.
Merge commit 414b95667416470e6311c9d0873938ed586d8a11 contains that upstream checkpoint and preserves its shared-core packaging work. The feature through 1808bc6d is pushed.
Worktree: /home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113.
Branch: feat/herder-process-leases-20261113.
Coordinator: ChatGPT session 6af76992-9198-8191-b01c-aaa6f7c6a044.
Shared main contains unrelated WIP and has not been edited by this task.

The first coherent implementation is committed and pushed:
0d398e197bac384fb916aad03289210fbb37988a.
Its immutable build worktree is
/home/roomhacker/agents-projects/.worktrees/herder-process-leases-build-0d398e19.

Later hardening, platform support and migration work described below must be
associated with its own committed SHA and rebuilt before installation. A green
source test does not prove that the shared installed runtime contains that fix.

## Architecture

Keep fourteen v1 public tool names. Extend resource and automation with process
completion, exact claim bindings and a read-only wait_status operation.

The registered resource descriptor and owner.json remain the canonical claim
authority. A durable execution binding records occupancy, not another owner.
Expiry, revision, nonce and fencing checks apply to acquisition, renewal,
release, binding and every protected effect.

ExecutionStore and herder_process_worker are internal Herder components. A
worker can outlive the control plane and renew claims without model calls.
The resource bridge belongs to the same release and has no independent
scheduler.

Trusted install configuration grants process and resource administration to
explicit principals. MCP arguments never grant access. Existing session ACLs,
native address bindings and scope generations remain mandatory.

A process has a stable execution reference, immutable request digest, real
executor identity and durable completion receipt. Local execution may specify an
absolute deadline; RemoteStart requires one. Source
metadata is captured explicitly as Git status evidence, not a content snapshot.
Artifacts require separate verification.

The source session remains the owner. A completed execution releases its build
slot or returns a claim to that session for a bounded handback interval anchored
to the original completion time.

## Implemented work

| Area | Implementation |
| --- | --- |
| Universal ownership | Resource registration, revision CAS, aliases, claims, expiry, retired nonces and durable execution occupancy. |
| Linux supervision | PID birth and boot identity, pidfd signalling, systemd user scope or direct subreaper, whole-tree evidence, crash recovery and no command replay. |
| macOS supervision | launchd job, boot and PID generation identity, private coalition task counts and kernel-checked signalling. No generic PID kill fallback. |
| Lease lifecycle | Bind before command, renew while owned work is live, stop owned work on lease loss, receipt before finalization, bounded handback. |
| Wait lifecycle | ProcessCompletion, Timer and SessionCompletion use durable registration, fast return, one background driver, busy-parent deferral, pause/CAS cancellation and exact session continuation. |
| HumanStop | Cancellation generation persists through restart. Process launch admission and HumanStop use the same canonical gate. A stopped registration cannot start a later build. |
| Lost ACK | Bounded native admission recovery using original request key, exact session and real native message ID. Full before/after CAS, atomic dispatch finalization, no resend, original UNKNOWN evidence retained. |
| Aggregate create tasks | A confirmed child admission can refresh an old aggregate projection using one exact native create receipt. Original parent bytes remain evidence. |
| Automatic work gates | Stop judge, unfinished-session paths, cadence and final automatic native admission inspect canonical waits. Human messages remain independent. |
| Remote scheduler reads | Existing pinned GPTAdmin transport reaches exact central AgentHerder authority. Missing, stale or ambiguous evidence blocks automatic work. |
| Canonical compatibility | resume_after and scheduled delivery use the same native automation authority; direct resume uses scoped native receipts and a principal-wide key reservation. No legacy clock or writable ReceiptLedger is constructed in canonical mode. |
| Legacy API | Standalone Agent Resume effectful entrypoints retire explicitly or use a trusted injected Herder facade. No fallback detached resume daemon is started. |
| Release compatibility | TypeScript and Python release gates delegate to one canonical resource bridge after a sealed, fenced migration. |
| Rollout | Immutable candidate, exact component provenance, guarded selector CAS, durable occupancy, independent process identity and consumer schema receipts. |
| Diagnostics | Read-only Get/List joins include late claim bindings, exact native wait target, delivery state, owner, TTL, recorded renewal history, typed next action and bounded gauges. Missing history is explicit. |

RemoteStart now has a separate trusted executor backend using the existing
Fleet GPTAdmin transport. It binds the actual executor, immutable job handle,
worker/config/root identity, one start dispatch and an independent Linux
deadline supervisor. Only the central authority owns resource claims. A stale
live ACK, transport partition or uncertain start cannot cause a command replay
or an indefinite renew. The isolated 414b9566 remote build now has a native
receipt, recorded below. Observer/watchdog fault acceptance is separate.

Local Linux and macOS share the process API and worker contract. Remote
lease execution on macOS and lease-bound RemoteAttach remain explicitly
unsupported. SSH client completion, container client exit and a remote harness
profile do not establish remote job completion.

## Native acceptance evidence

All paths below belong to this task under
/home/roomhacker/herder-artifacts/process-leases-20261113.

### Historical first Linux candidate

Candidate: /home/roomhacker/herder-artifacts/releases/process-leases-0d398e19-v2.
Manifest SHA256:
11afb9a3c15ee8d3622251da67cadfcb8f485fe225335de20ff208f151fd6d46.
Core SHA256:
94adedb51454bb2699412d3cf64eaa7a2428f403cdddddb45b2e333e2a79f3ff.
Worker SHA256:
1d16c41c87e3274fadd601ddd6fedeae8be1bda227853addbebbd374e2424913.

The candidate was checked without changing the public selector. Its private
canaries use fresh authority databases and protected test workspaces.

### Real build, renewal and control-plane restart

Run: canary-opencode-0d398e19-v1.
Session: session:ce6abe2a53c09de35c174eb369041bca.
Native session: ses_e2904998cffe49QdECwwDXtbsz.
Execution:
exec-54e39abb02c0e85b599e580abf4722ba832b7a7cc1abf144a1e7c2d8b0531283.

A real C program was compiled with cc, executed and checked for PROCESS_BUILD_OK.
The supervised command lasted 40.262 seconds with a 15-second lease.
The control plane was stopped and absent for 18 seconds. The same worker,
execution and claim survived; a post-restart read proved a renewed future
deadline. The worker's terminal receipt records exit_code 0, tree_complete true,
process_may_be_running false and completed lease finalization.

The first test harness treated a transient read-side scope_unavailable as fatal
and closed the control plane during wake handoff. The original wake intent is
durable dispatching with no persisted native receipt. This run therefore proves
build/renewal/restart/terminal processing, but does not yet prove a successful
native continuation. No command or wake was resent.

The canary harness now retries only the bounded read operation on an explicit
effect:none scope_unavailable response. It never retries a possible mutation.
The exact original checkpoint and receipt remain available for reconciliation.

### Paired candidate f488d9b0 and rejected wake acceptance

The immutable candidate is
/home/roomhacker/herder-artifacts/releases/process-leases-f488d9b0-v1.
Source commit: f488d9b001c139cf49f67186b1558a05e98d4a8a.
Manifest SHA256:
9eec5f04617567ed36b8c971ec74670a92bef1a508b2d4d195fdc3f0f7cfa223.
Core SHA256:
3f56a10649648d0e5f770b5fcc75b2ec7ad5afab1278b339ee4a9bba43f777cf.
Worker SHA256:
294eb29bf7ff009d48f5c194e788bdc190a6f26587cf3dd842b9cad0a1e88a65.

Run: canary-opencode-f488d9b0-v1.
Session: session:86b362c58630f70aebca7d019758bbd8.
Native session: ses_e28d1a406ffeboMQ5p2YPwj6Up.
The C build ran once for 40.452 seconds. With a 15-second claim and the
control plane absent for 18 seconds, the same claim renewed and the same
execution completed with exit 0 and proven empty process tree. Claim release
and artifact digest were independently observed.

The original quick check returned PASS after seeing the first assistant answer.
Its history projection was incomplete. Review of actual native records found
two assistant messages for the single wake intent:
msg_1d72f22da001t2BiLzZYF0Wb3b and
msg_1d72f38e6001ToSuu6D56sg7Mk.
The original user input is msg_1d72f22a800118GOIOBnk8yk4V.
The one canonical task is
mcp-delivery-task:28ec46e0dc95c1ffbe7b66fe875705315324f351373db16afc8b2704213643a2.

The checkpoint now says FAILED_NATIVE_DUPLICATE and preserves the original
quick-check evidence, both native message identities, and the valid build/lease
receipts. No build or wake was resent. This is not full native acceptance.

The installed native prompt schema has no atomic idle/turn admission condition.
The installed Hindsight hook already uses synthetic resume:false but inserts
its message with the native default delivery semantics. Simply changing Queue
to Steer could interrupt a concurrently started human turn. The updated runner
therefore advertises nativeAutomaticContinuation:
unsupported-no-idle-admission-v1. The new core disables automatic continuation for every OpenCode protocol,
including v22. Automatic process, timer, dependency and child wait creation
refuse before a new protected effect on those profiles. The failure above was
observed on v2; the shared installed bundle is unchanged.
Existing jobs still reconcile and finalize resources; original delivery intents
remain available for read-only recovery.

The canary helper now waits for stable native idle, checks duplicate assistant
answers, and requires complete history before accepting a unique continuation.
A native receipt proves input admission; it cannot by itself prove exactly one
model turn.

### Harness matrix

| Harness/profile | Observed outcome | Acceptance state |
| --- | --- | --- |
| Codex local | Quota guard rejected thread/start before native submission. Fresh 2026-11-14 provider read reports 6% remaining, while the unchanged local policy reserves 20%. | Blocked by the configured reserve; no session created and no policy bypass. |
| Codex server-44 | Exact create returned create_not_sent with no create/prompt effect. | Not accepted; do not infer a model turn occurred. |
| OpenCode v2 | Paired f488d9b0 candidate admitted the initial prompt and completed the real build. One canonical wake produced two native assistant replies. | FAILED_NATIVE_DUPLICATE. The new candidate refuses automatic continuation for all OpenCode protocols. The shared installed bundle is unchanged; explicit delivery and fresh creation remain separate. |
| ZCode | Original admission recovered without resend; the original native turn ended in error 2056. A new 1808bc6d canary stopped before admission because current status remained error; full export returned source_unavailable. | BLOCKED_BEFORE_ADMISSION for the new operation. Current idle/input-queue absence and successful model continuation remain unverified. The export failure cause is not established. |
| ChatGPT UserIO | Original create remains dispatching/UNKNOWN after caller timeout. | Preserve original operation, reconcile read-only, never repeat create blindly. |
| ZAI UserIO | One bounded create ended after the native 120-second handoff with outcome_unknown; no persisted native binding. | Not accepted. Preserve the original key and do not repeat create. |
| Claude | Disabled according to the user's choice. | Excluded. |
| Hermes | No active public native profile in the inspected six-profile installation. | Not enabled for this rollout. |

Read-only quota evidence from 2026-11-14 00:16 UTC is retained in
quota-preflight-20261114.json. Codex provider allowed:true does not override
Herder's configured reserve. At that historical checkpoint MiniMax reported
quota_exhausted and GLM reported unknown after a provider error. The later
MiniMax window report is recorded below. No native submission was made by
either quota read.

ZCode evidence binds the exact original create-prompt key, native session
sess_bae78beb-46f1-4199-8eaa-d1a145b1833e and native user message
msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c. Its native sourceCommandId
preserves the original request correlation. Recovery accepts the exact native
automation anchor, rejects raw human input IDs and leaves reserved-prefix
collisions UNKNOWN. A text match is not used as proof.

The first public OpenCode QA session was explicitly contained and interrupted
after it started work without the intended initial prompt. Its HumanStop remains
active. Evidence: opencode-containment-v1.json. It is not a successful acceptance
session and must not be resumed.

### Preserved browser uncertainty

ChatGPT original key canary-chatgpt-0d398e19-v1-create has no native receipt.
The installed browser bundle does not retain the original create request key in
its local draft mapping. Matching a title or creation time would not establish
the original operation. No blind replay is permitted.

ZAI original key canary-zai-0d398e19-v1-create belongs to
create-operation:8b290852236819388c4d15c9d699133d. Its exact intent is unknown,
not rejected, with no native receipt or session binding. Its checkpoint is
canary-zai-0d398e19-v1/checkpoint.json.

### Native macOS evidence

Mac Mini was reached through its currently verified host identity. Source was
copied into an owned isolated directory and checked by digest. Native cargo
check --bins passed for the worker, MCP core and resource bridge on macOS 15.7.8
with Rust 1.97.1.

The final real process suite passed 15 tests, including a detached setsid grandchild
that outlived its wrapper, worker SIGKILL with retained UNKNOWN occupancy,
coalition-empty recovery and safe cancellation by PID generation. A wrong PID
generation was rejected by the kernel while the intended child remained alive.
This is platform acceptance evidence, not a shared fleet deployment receipt.

## Test checkpoints

Test counts describe separate suites and must not be added without checking
their overlap.

- Original Linux implementation: library 218, engine 12, resource 26, bindings 6,
  automation 8 and catalog 6 tests passed.
- Canonical release bridge: Rust 10, real Python/Rust 2, cutover 15, canonical
  Python gate 5 and real TypeScript/Rust 6 passed.
- Wait gates and remote read route: TypeScript 48 passed; local reader 13 passed.
- Cadence/admission/ZCode projection: targeted 44 passed.
- OpenCode protocol/projection: 53 passed, including the observed top-level native
  v2 payload and the capability-gated initial-turn admission.
- Lost-ACK/CAS: scoped receipt recovery 15, AHAP 12 and the existing reconciliation
  test passed. Existing create-prompt 4 and create/delivery wire checks passed.
- Root process automation 12 passed after automatic ACK reconciliation and
  HumanStop-before-launch admission fencing were connected.
- Native macOS process supervision 15 passed; process units 2, pinned gates 2,
  real worker lease renew/release 1 and automation restart/wake 1 passed.
- Final Linux process supervision 16 passed; process automation 12 passed,
  including a real claim released after proven cancellation before launch.
- Strict candidate packaging: baseline 15, adapter transition 12 and rollout
  coordinator 18 passed. The adapter suite includes actual tsc and bundling.
- The first full Rust run passed 220 library tests but stopped at one launcher
  fixture whose script was group-writable under umask 0002. The fixture now
  explicitly uses mode 0700; the exact regression passed with that umask.
  The coherent serial run below supersedes that incomplete attempt.
- Coherent Rust verification on 2026-11-14 passed all 33 targets: 465 tests
  passed and 7 native/opt-in tests remained ignored. The command used --locked,
  --all-targets, --no-fail-fast and --test-threads=1. The private
  rust-source-test-receipt-20261114.json binds the log and 167 crate source files.
  The initial parallel run exposed a transient fake-executable ETXTBUSY and an
  invalid two-second fixture wall-clock assertion. The latter now checks one
  actual admission; canonical_waits also passed 14/14 in parallel.
- Canonical direct resume passed 18 focused tests after the typed conflict fix.
  Principal-wide delivery keys passed 7, scoped receipt recovery passed 20.
- Paired runtime readiness passed 34 TypeScript tests, plus 9 existing gate/auth
  checks and tsc. Python readiness 10, coordinator 22, candidate 17 and paired
  adapter packaging 12 passed; the final persistent environment hardening was
  rechecked in the readiness suite.
- TypeScript --noEmit and git diff --check passed at reported source
  checkpoints. Final merged TypeScript and immutable candidate checks are
  recorded with their own commit and receipt.

Logs and native task receipts are retained with this task. The final report
must distinguish source tests, isolated candidate evidence and actual installed
consumer evidence.

## Migration and deployment gates

The current public MCP still uses the prior composite manifest. The TypeScript
service is another installed surface and must be upgraded separately. A native
core restart alone does not activate TS automatic-continuation gates.

The adapter update must pin new OpenCode and ZCode bundles from the same clean
source. It must preserve all other component hashes and every existing authority
database, gate, generation, principal, native account, model and environment.
Only the reviewed adapter path may change in a new protected sibling profile.
Existing profiles are retained.

The canonical release cutover currently encounters three retained legacy
records: vpn-panel fence 9, exmanager fence 1 and macintel-webvnc fence 1.
Expiry or an absent PID does not prove their protected operation completed.
In particular, the observed vpn-panel cleanup receipt releases fence 8, while
the retained record is the later fence 9. It cannot close that generation.

Forty-seven legacy Agent Resume records previously reported running despite
missing recorded process and watcher PIDs. Preserve them as unresolved evidence;
do not bulk-wake their sessions, relaunch commands or manufacture success.

Shared rollout requires a current project release proof held through guarded
installation, the exact child restart, fresh process identity and actual
consumer verification. The production coordinator requires the source to be
merged into freshly fetched origin/main. Unresolved cutover occupancy cannot be
deleted to bypass this gate.

Airlock VPS is excluded. No calls or notifications to people are permitted in
acceptance. Keep the existing default and public-child selectors distinct.
Preserve the shared dirty main and the separately retained local commit 98593d9c.

## Canonical source integration and migration boundary

The native owner runtime now hosts ProcessCompletion, Timer, SessionCompletion
and existing child completion through one automation driver. Timer due times
are persisted once. Dependencies bind exact native turn identity and reject
cross-profile cycles. Read-only session.resolve and deliver.receipt use scoped
bindings without invoking native adapter methods. A cold owner runtime can
start its AHAP companion during initialization; these reads do not start a
model turn. Missing or ambiguous evidence
remains a typed error.

Canonical TypeScript compatibility delegates to that runtime over the exact
pinned Fleet route. It starts no legacy resume-after sweep and constructs no
legacy ReceiptLedger. Its direct-resume key is principal-wide, durably bound to
one target and payload inside the existing resource authority, and rechecked
at the actual native handoff. Cross-session key reuse and corrupted bindings
cannot produce another send. A lost ACK reads only the original intent and
receipt.

Canonical activation requires old waits and receipts to remain at their
original locations as sealed evidence. The shared installation has not activated
this transition. The activation barrier checks exact inventories and original
writer birth identities; an old process already inside handoff must be drained. UNKNOWN,
pending and insufficiently settled cancelled records block new admission.
HumanRequest-bound canonical waits and Darwin writer-drain activation remain
explicitly unsupported pending their own reviewed authority/verifier.
No legacy fallback is allowed after selecting canonical mode.

The candidate includes the immutable remote bridge. Its successful native
execution used only the isolated controller on roomhacker-server-100 and the
verified server-44 executor, with the existing credential generation and exact
artifact pins. The remote test sent no model prompt.

The production coordinator also requires a paired TypeScript canonical cutover
proof. The old installed TS scheduler must not remain capable of continuing
sessions while the new native core owns waits. Installed process identity,
immutable source/configuration, writer drain and a fresh query through the
actual TS gate must be verified across the native switch. Isolated candidates
do not change shared services.

See canonical-waits-and-resume.md and remote-process-execution.md for exact
contracts and focused test evidence. These source changes do not settle the
native/profile or migration blockers recorded above.

## Verified checkpoint 2026-11-14

### Committed source and immutable candidate

Canonical waits, direct resume, remote execution and paired-runtime hardening
were committed in ac571a99765dd29a5a20e6da77a855e973793b24. Merge
414b95667416470e6311c9d0873938ed586d8a11 preserves upstream a1c17a48.
Its clean build worktree is
/home/roomhacker/agents-projects/.worktrees/herder-process-leases-build-414b9566.

Candidate: /home/roomhacker/herder-artifacts/releases/process-leases-414b9566-v1.
Manifest SHA256:
53751988f12f54ee1165a9f1af186bdaf3d115be29c82d27c5457154355f1a7c.
Core SHA256:
369009122759f43e114ac48364d4123f2c5d8ec12ece4d808d0059dcafba9ca3.
Worker SHA256:
a7b5093f6659e5d2125fc201657665ba2e9df2ef188314ece0d42a7482abfef5.
Remote bridge SHA256:
dcd4317d0d6b2ba8eb764a9828d88ecc162b6b47eae12f5b97d7d24c06e7f1f5.

The six staged profiles passed the pinned launcher check, explicitly
staged_payloads_not_installed. Its shared process config packages the remote
bridge but registers no executor. The remote canary uses private separately
pinned controller/executor configurations. Receipt: candidate-414b9566-receipt.json.
The final follow-up candidate must include the metadata-gate fixes described
below; this baseline artifact does not contain later source edits.

### Merged source verification

At 414b9566, build:core passed; all 84 internal package tests passed in 13
suites. Full Vitest passed 5738 tests in 632 files, with 15 explicit skips and
no failures. TypeScript checking passed. Adapter packaging passed 12 tests and
candidate packaging passed 17. Provider opt-ins were disabled. These counts
describe source checks, not live native continuation.
Receipt: merged-typescript-414b9566/state.json.
SHA256: 23e0fa6af350c7463fed589d551b36726c606754238ee5d4ba5b30771b961b2c.

On the Mac Mini, exact 414b9566 source passed cargo check --bins,
canonical_waits 14 tests and delivery_keys 7 tests. All 188 transferred source
files remained unchanged. These 21 tests are separate from the earlier 15
process-supervision checks, which were retained without rerunning.
Receipt: macmini-414b95667416470e/acceptance-414b95667416470e.json.
SHA256: c1ea58c925fdd419dfd772feeeb7b82c3b910e6fb09a09781f7cc070f315c8a7.

### Real remote build and central lease

The isolated controller on roomhacker-server-100 used the immutable 414b9566
worker and Fleet bridge to execute one C build on server-44.
Execution: exec-36582ac0d8d745c9dadb76b84e8092f050f8f53eccf1847d6489d9e94eb0eb8b.
The remote command lasted 40.290 seconds. The original central claim had a
15-second TTL and was observed live with a renewed expiry after that original
TTL. Its exact remote receipt records exit 0, tree_complete true and
process_may_be_running false. Canonical release followed claim finalization.

An independent executor read confirmed exactly one invocation marker, matching
source and command hashes, output herder-remote-canary-ok, and artifact SHA256
c8036d97ea3a14ad33c8441c9af209892bf4e4ef79be7e093a1f4a8930a53b53.
The pinned watchdog was ready before command admission. The recorded process
births and exact cgroup were absent under the same boot after completion.
No model wake was used. This ordinary-success run did not inject observer or
watchdog failure and does not prove their restart behavior.

Controller summary:
remote-canary-controller-v1/executions/exec-36582ac0d8d745c9dadb76b84e8092f050f8f53eccf1847d6489d9e94eb0eb8b/canary-summary.json.
SHA256: e98d812b29ff17b99107bed422514094400f67812bb13e7024f16cbef11bb984.
Independent executor readback:
remote-canary-preparation-v1/native-canary-readback-exec-36582ac0.json.
SHA256: dc779d52ce8adfaefdcbf64952c45fd2f12c2d55ae81034283470a18d5523168.

Review found that public wait_status compared a remote receipt with the
controller node. Two regression tests demonstrated both a stuck valid wait and
acceptance of a substituted controller receipt. The source fix verifies the
executor, current installed configuration, original rule and exact durable
terminal proof without RPC. Both new tests and both existing local wait_status
tests passed. The baseline 414b9566 candidate predates that fix.

### Original ZCode acknowledgement recovered

At 2026-11-14 01:01:13 UTC, candidate 414b9566 recovered the exact original
child intent with compat_task.get, then returned a recovered projection for
the original aggregate. The native message remains
msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c. Only the original child task
result and intent receipt changed. The aggregate's stored result, authority
generation, database/gate inodes, model, environment, session binding, original
profile and old checkpoint were preserved. No create, send or resume call was
made. This proves native admission recovery, not a successful model turn.
Receipt: reconcile-zcode-original-414b9566/attempt2/acceptance.json.
SHA256: f406c122a21cd2334641f492d53e07b5e13b45753b82d0caf58eb57faab32035.

A fresh quota read at 01:11:54 UTC reported MiniMax interval and weekly
remaining percentages of 100 after its previous window expired. Codex still
reported 6 percent remaining against the unchanged 20 percent local reserve;
GLM remained unknown after provider code 500. A quota report is not proof of
a successful model turn and does not authorize changing a profile or model.
Receipt: quota-preflight-after-window-20261114.json.
SHA256: 1672a58fec7ad84e5bae1d3b61d9996d2dd283d0346d8c13b80e823d2019cd96.

### Source 1808bc6d and its immutable candidate

Source: 1808bc6d7e2e3472e71e49e2c0038bb1472d4a83.
Rust tree: 8adecc98d7367cd485afb874bfe9410f56d09887.
Build worktree:
/home/roomhacker/agents-projects/.worktrees/herder-process-leases-build-1808bc6d.
Candidate:
/home/roomhacker/herder-artifacts/releases/process-leases-1808bc6d-v1.

| Component | SHA256 |
| --- | --- |
| Manifest | 53fb8f86fe18e9460490031fc74085c78add38fc96d5aecd12c9f847af5ac843 |
| Core | c6326251a2bd237e5ac691dd4b191c77dbb30aee2643d27540440e373727ba7c |
| Worker | 1e3ae1d8011e4586b5c15c834497e0d8a7f8e3cc1838923553766d331a0aeee5 |
| Remote bridge | d4f4cbf547cc69fe2b3e78c2813042d1a089eff80ce0559ddc3dadb4b6b2c04f |
| Wait reader | bb347e2280e1dbc7fb7f0fb81c7ba4ffea1c56f42ecd8dd48875c5898b9fc85a |

The candidate build took 80.290 seconds. All six staged profile payloads passed
the launcher check. The check did not install profiles, switch selectors or
register a remote executor. All 757 recorded source inputs remained unchanged.
Receipt: coherent-1808bc6d/candidate-build-result.json.
SHA256: 25e3b8385e8d8fb7e3d8c675e3ba92f1f5555008b121cb80f5e40d77b6c28392.

The full Rust run passed **479 tests across 34 Cargo test harnesses**, with
7 explicit ignored tests and no failures, in 330.852 seconds. Source inputs
remained unchanged. A nested child test emits an extra one-test summary; it is
retained separately and is not added again to the primary total.
Original raw receipt: coherent-1808bc6d/cargo-all-targets-result.json,
SHA256 8861599b99480769d8e50376b000277db3da086034718cd99126de2684e1a0d9.
Count interpretation: coherent-1808bc6d/cargo-count-interpretation.json,
SHA256 0f1e5f8c439b66b6d29556c5224731a590b76cb4f21093391ea27a217d173888.
Full log SHA256:
437241255fb5807a54b107095b61aa465829996d7decc4b8237274b1b39b8340.

TypeScript and the internal Agent Resume package are unchanged from the fully
verified 414b9566 checkpoint. The earlier 5738 Vitest and 84 package test
results apply to those same source bytes. They were not needlessly rerun.

On the Mac Mini, exact 1808bc6d source passed bins checking, diagnostics
10/10 and process automation wait_status 6/6. All 190 source/archive entries
were unchanged after testing, and the prior 414b9566 source backup was retained.
This is separate from the earlier native process supervision acceptance.
Receipt: macmini-1808bc6d7e2e3472/acceptance-1808bc6d7e2e3472.json.
SHA256: 8c632c6cae8c115b6d62d1f1155d2bf396dd5c3e10a75dccd0d9072ec5ba664f.

### Wait-gate and diagnostic closure

The Rust wait_status and installed Python reader now preserve uncertain
original delivery even after automation deletion or HumanStop cancellation
and release. They derive the original task/key, verify the exact principal,
target and request tuple, and refuse mismatched pointers or conflicting
intent rows. A cancelled phase alone cannot clear an UNKNOWN handoff.
The Python local suite passed 18 tests and its remote suite passed 8.
Evidence is under python-wait-gate-hardening. The shipped reader digest above
matches the tested source.

Process Get/List exposes validated current delegation, including resources
bound after launch. The current installed principal, storage authority,
execution, claim generation and descriptor revision still control access.
Best-effort renewal telemetry records actual canonical results while preserving
the original success/error even if telemetry cannot be written. Diagnostic
metadata never renews a lease or authorizes a wake.

Read projections include the known native target, current owner/expiry,
delivery state, typed next_action and bounded snapshot gauges. Unavailable
history stays null or incomplete. Logs have no automatic expiry; receipts,
request keys, retired nonces, dedup evidence and tombstones remain indefinite.
Diagnostics acceptance: process-diagnostics-acceptance-v2.json.
SHA256: 479e9da5d24c432d66d784b69f40c35f8c7d28b26ee68580fcfeb7055cfdc6c8.

### Remote prelaunch expiry evidence

The first fault-canary registration used a 15-second initial claim. Remote
preparation took 19337 milliseconds, so the claim expired before Start.
The executor persisted cancellation before supervisor admission, with no
command effect. start_dispatched was false; no start permit, command marker,
worker or cgroup existed. No fault signal was injected. Canonical claim
retirement and occupancy release completed.

This is useful expiry/fencing evidence, not a passed watchdog fault test.
The original execution is terminal and must never be replayed.
Execution:
exec-9bb384f1b2fb9534cbba1c33fdd2ce1b05ba5c8378807b1e912ee79e6b74b52a.
Controller receipt: remote-fault-controller-v1/fault-no-start-receipt.json.
SHA256: 51529132e6f9715204550ce5a67a59acf22d607dafba47fd92f0840486138465.
Executor receipt SHA256:
9f28e5c31495f6d0b1b639649e676063f34058702d39e741ca11246cc8fab829.

### Remote deadline and observer recovery

The v2 fault fixture admitted its command exactly once, but its QA coordinator
failed while reading a nested OwnerRecord as a flat claim. No fault signal was
injected. The independent executor watchdog still killed the original cgroup
9 milliseconds after its original deadline. The command tree became empty,
the original claim was retired and the execution binding resolved. The receipt
correctly preserves an unknown exit status; this is deadline evidence and not
a successful build or watchdog-restart acceptance.

Execution:
exec-ff3493361469893085f4caff310904582e8a288fa19fe8052037c1f130e0b966.
Receipt: remote-fault-controller-v2/fault-terminal-readback.json.
SHA256: e5ab184010f5bc212cae536c73e2f2004d2f7fafc3020288ddf54a0c44cdd2d2.

The v3 fixture injected one exact PID-generation SIGKILL into its private
controller observer. The same original execution subsequently obtained a new
observer, with unchanged handle, command payload and start permit. Its recorded
38 successful renewals include renewal after the crash and beyond the original
claim expiry. The final executor watchdog fired 28 milliseconds after the
original cutoff; there was one command marker, an empty kernel scope, no command
replay and completed canonical finalization.

The QA coordinator's 15-second recovery sampling window failed. Recovery was
established separately from persisted process generations and post-signal
renewal evidence. No watchdog crash was injected in v3, and that boundary must
not be inferred from this receipt.

Execution:
exec-65e5b9e54209f8cd5e9e71b259c129bd2e29e57a0f243f83555f3a52d04f18bc.
Receipt: remote-fault-controller-v3/fault-terminal-readback.json.
SHA256: a5d3fdddaef4258fe0b00844c39edf6aed5001b53a436e4eff8523c1753dcf05.
Executor evidence SHA256:
5a028892415915434690348ef9f4bf264b5d0c7ef7cd737dec64d241596498e6.

Both runs used the 1808bc6d worker and remote bridge. The isolated test driver
was built from 414b9566; its separately retained compatibility receipt identifies
the unchanged command/transport source and the added observational telemetry.
Do not report the entire driver as rebuilt from 1808bc6d.

### Remote watchdog restart: prepared, not executed

The reviewed v4 fixture isolates the remaining watchdog restart boundary. Its
controller shutdown requires persisted evidence of the original admitted
remote command, not merely start_dispatched. That historical evidence is used
only to stop the exact private controller processes; it cannot renew a lease
or admit another Start. The executor phase independently verifies the live
tree, original handle, command marker, cutoff, watchdog PID generation and
held cgroup.kill descriptor before injecting the fault.

Nineteen focused offline tests passed. The exact predicate was also checked
against the retained real v3 VerifiedObservation and nested OwnerRecord,
without RPC or process effects. The reviewed helper and five QA source artifacts
are retained under remote-fault-preparation-v4.
Helper SHA256:
02d3ca27eac159f89a6fe39d4949cb642a3c25a8c9cbb1e77fa9aa675b74558b.

Executor staging received HTTP 503 with
enrolled writer bearer admission unavailable through the existing server-44
route. A bounded read proved the new directory absent before a second staging
attempt. The second attempt received the same admission error; its filesystem
outcome remains unconfirmed. No further server-44 read or write was attempted.
Do not claim the directory is still absent, or restart staging without readback.

No v4 Prepare/Start RPC, native command admission or fault signal was issued.
The test's reviewed source is ready; watchdog-crash/restart acceptance remains
outstanding. No credentials, permissions or transport were changed to bypass
the writer gate.

Preparation receipt: remote-fault-preparation-v4/preparation-receipt.json.
SHA256: b169c21c46d0e5516ca57bc3f95cdc07fc91ac0e732c07ad86d4487760b8d112.
Blocked checkpoint SHA256:
4d08be123f41c8259b00ee6b2436dd3cb71d69b195f9f8dda62a8fe117406e47.
Real-schema proof SHA256:
5e32c9af8af6187c47f1755c0b6755715bad438ca41abd08d3b9712c57637021.

### Generic native QA reader hardening

The repository helper now requires a reviewed complete-history contract before
bootstrap or native acceptance. All six non-prepare actions also validate it
before starting the private MCP runtime, because startup can run the automation
driver. Legacy unsupported checkpoints cannot bypass this gate through
preflight, observation, reconciliation or archive.

The only complete reader proven by this helper is local Linux ZCode with the
explicit source proof. This is an acceptance-helper limitation, not a change
to the runtime's supported platform or harness capabilities. Complete export,
exact native input receipt, assistant parent and message counts, the preserved
pre-effect baseline, normal accounting parts and at least 15 seconds of stable
idle are required. Only typed effect:none / scope_unavailable observations
receive bounded retries. An uncertain effect is not resent.

These edits affect tests/native only. The historical private reference helpers
are unchanged, and the immutable runtime candidate remains source 1808bc6d.
An independent review approved the final source and regression fixtures.

The final targeted offline suite passed 26/26 on the feature worktree, with
no native API or model calls. Production paths crates, src and packages have
no diff from 1808bc6d.
Receipt: native-canary-qa-fix-1808/acceptance.json.
SHA256: 35dfcc3c63855369a2189c121cda68d9fcadd70c5381ee84c354bfd8cdc1187a.
Helper SHA256:
91871000271e4e1ee954ab02a63843774cd55ab6052f1ea4a2d28fa4cea48b99.
Regression fixture SHA256:
a1aadd3d77d7fe626fa1b84203e08f429c76fe98bc6c9fe0c30bdf8321ec47cb.

### Native acceptance proof boundaries

The ordinary session.messages projection is a bounded tail and cannot prove
that no second native reply exists. ZCode acceptance uses the complete native
export, exact native message IDs, the admitted input correlation, assistant
parentage and a stable idle window of at least 15 seconds. The current ZCode
3.17.2 backend's complete read contract was checked against its actual running
release and retained with binary/source fingerprints. Mandatory step-start
and step-finish accounting parts are allowed; tool activity is not.

Native history source proof:
known-zcode-process-canary-preparation/native-history-source-proof.json.
SHA256: e499a03f7c27dfcffaf74abe8c80da483ba1b421e5ea65fae5bfe112c6e81d74.

The 02:11:11 UTC quota check reported MiniMax interval and weekly remaining
percentages of 99. Its account association with the existing ZCode profile is
unknown, so this is advisory evidence only. The profile, model, environment and
provider configuration were preserved. Codex still reported 6 percent against
the existing 20 percent reserve; GLM remained unknown. The zero total-count
fields were not used to infer availability.

### Existing ZCode session: no new admission

The reviewed v3 helper was invoked once as native task
6aeec4a23ef581c3501ef3f49c33d576. It stopped during preflight with
native_session_not_idle, before prime delivery, resource registration, claim,
process launch or wait registration. Its new request key has no canonical
intent. Original operation evidence was preserved.

A separate bounded status read identified the exact same native session,
complete native coverage, needsPermission=false and status=error. Its metadata
described the original completed error 2056, completedAt 1794606847471, with
pendingInput=false and progressedAfterFailure=false. This establishes the old
failed turn; it does not establish current idle or an empty native input queue.
Permission-request IDs are not an input-queue inventory.

A separate complete-export read returned source_unavailable with effect=none.
The adapter catches the underlying transcript-read error and returns null, so
the available receipt does not identify its cause. Do not describe this as a
proven provider or external outage. The configured native route and workspace
matched the existing session; no changed cwd or profile was found.

All three private core lifecycles ended through EOF, without signals or retained
private core processes. Settings stayed empty, the new delivery intent remained
absent and no new native prompt, claim or process was admitted. No second v3
run was attempted. This is BLOCKED_BEFORE_ADMISSION, not a passed continuation
canary and not an uncertain new delivery.

Final receipt:
known-zcode-process-canary-preparation-v3/final-blocker-receipt.json.
SHA256: 8734f13cf69f35beb83e76c6ad4812502f2d62fc2e7ee77d4b28466f6928adf1.
Status read:
known-zcode-process-canary-preparation-v3/preflight-native-status.json.
SHA256: 1694b6a7b0736851c8de94ca6224c3cecb82e69cd0df19a3a8559eddec9a7a62.

### Installed surfaces at handoff

A read at 2026-11-14 02:19:57 UTC still found the public native selector pointing
to ahap-opencode-resume-bce62de3-v1. Its selector SHA256 remained
173b613d78fa4262aed36716f5cf737a803fe7191fc317628c92a3a209769cf3,
and its manifest SHA256 remained
4a711887a69126c02ac870b42c896f806db312382f83120f998a45c00a1fe770.
The 1808bc6d candidate was not installed.

The active TypeScript service had PID 4077062 and its entry path was
/home/roomhacker/agents-projects/.fleet-candidate/releases/80420046b1be7cb8db03783f5c15d02e91c65fc8/dist/index.js.
This differs from the earlier c9bc35a6 observation. This task did not change or
restart that service. Its current identity, configuration and provenance must
be freshly checked during any later paired cutover; an old service observation
cannot serve as current deployment proof.

Receipt: handoff-installed-observation-20261114.json.
SHA256: 9439d416d896ad0df35c9ee0aabacaaa37d61ceb2102a671f62b7469b74d844d.

## Remaining closure work

1. Establish a native continuation contract for each active harness. OpenCode
   needs atomic idle admission or a proven equivalent before its automatic
   continuation capability can be enabled. Codex needs allowance above the
   existing reserve. ZCode needs a readable full native state and a proven
   admissible target; inspect the hidden transcript-read failure without
   replaying the old prompt. The browser paths need exact durable create
   correlation; title/time matching cannot resolve the retained ChatGPT/ZAI
   operations. A new correlation fix does not retroactively prove old admissions.
2. Complete the remaining remote watchdog-crash/restart boundary only after the
   existing server-44 writer admission works and the exact prepared files have
   been reconciled. The normal remote build, independent deadline and observer
   recovery are already evidenced. Preserve the v1-v3 terminal requests.
3. Close or explicitly preserve the three original project-release generations
   and 47 unresolved legacy Agent Resume records under the reviewed migration
   procedure. Missing PIDs and elapsed TTL are insufficient. Preserving unresolved
   evidence does not itself permit activation. Seal the original
   inventory and prove old writers drained before admitting a canonical owner.
4. Integrate the reviewed branch after native acceptance. Build from the exact
   merged, freshly fetched origin/main, preserve the installed composite
   component provenance and recheck the current TypeScript service. The runtime
   candidate in this report is source 1808bc6d; later QA/documentation commits
   do not change that artifact's source identity.
5. Hold the release guard continuously through the paired TypeScript/native
   transition, selector CAS, the exact process restart and actual consumer
   verification. Record installed component hashes and the final support matrix.

A green source test alone does not satisfy the production gates. This task has
not switched production selectors, restarted shared services, activated canonical
migration or registered a production remote executor. Review and resume from
the retained original keys, task IDs and receipts without blind retries.
