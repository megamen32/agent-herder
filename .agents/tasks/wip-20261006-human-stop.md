# Preserve explicit human stops in Codex and ZCode

Owner: Codex01a10b3f-b648-74d0-8265-023d1ae85312.
User requires human-stopped chats to stay stopped: no automatic continuation,
watchdog retry, cache rollover or replacement. Existing automated launch policy
and completed-task protection remain independent.

Preflight main d8342d7 clean/synchronized. Herder1051892, native Codex4019392.
Confirmed gap: supervisor stop/cancel/terminate forgets unfinished work but
stores no durable human stop. Native Codex interrupted completion is flattened
into ordinary completed/idle, losing the distinguishing signal. Native ZCode
stop evidence is under investigation; stopped/completed is never alone proof
of a manual stop. No business session is stopped for this task.

Accepted behavior: retain a per-native-ID stop across restarts and settings
changes; release only on an explicit human resume/new user prompt. Automated
turn-start, duplicate terminal events and elapsed time cannot release it.
Native interruption evidence and unknown actors must be represented honestly.

Cheap investigators own native Codex, native ZCode and automation-path mapping.
Root integrates supervisor/API/state wiring. Ownership will be assigned before
parallel edits; all workers preserve shared main and foreign changes.

Measured host available30.6GiB, swap19.6GiB used, current memory PSI0.01.
Existing Herder budget unchanged: RAM1/2GiB, swap512MiB, CPU4cores, tasks512.
Tests/build share /run/user/1000/agent-herder/heavy-check.lock with RAM1/2GiB,
swap0, CPU2cores, tasks128, IOWeight10, runtime150s/command120s; one worker and
one heavy workload. No dependency install/GPU/unbounded suite. Controlled
native/browser canaries use only task-owned sessions and bounded waits.

Completion needs durable-stop regression/race checks, real controlled native
manual-stop proof, no automatic continuation/replacement after process restart,
explicit user resume proof, source review, clean pushed main and scoped rollout.

2026-10-06 root integration checkpoint:
- Pending generated prompt digests now promote to native turn IDs; otherwise a
  later genuine identical-text human prompt was wrongly considered generated.
- Supervisor lifecycle release includes actual prompt text and rejects generated
  evidence before clearing the hold. Store + integration: 19 focused checks pass.
- Root bounded TypeScript --noEmit check passed after this integration.
- Independent review confirmed health/remediation source propagation and queued
  ZCode/CLI Codex admission gaps; cheap workers own these immediate fixes. No
  business-native calls or deployments. All existing shared WIP is preserved.
- API remains NOT READY until remaining checks, coherent build, publication,
  rollout and owned native/browser stop/resume acceptance. Notice owners notified.
- External owners: 01a1106f owns done notify=false core slice; 01a10bc5 owns
  styles.css/layout helper only. Root owns main.tsx and one combined Herder build.
- Parallel user explanation delivered as standalone ecosystem-map.html in the
  thread visualization directory outside Git: read authorized Artem Popov DM,
  verified launch chain from source, real browser desktop/mobile scenarios pass
  without horizontal overflow, screenshots inspected, owned browser closed.

Source verification before rollout:
- 14 affected files, 341 checks passed; after final queued/prompt changes,
  4 affected files, 77 checks passed. TypeScript --noEmit passed.
- Review fixes: bounded 5s retry on failed queued stop inspection (direct
  fake-clock regression passed), await native callback persistence on teardown,
  and never bind an automated prompt to a previous active turn.
- Generated text is remembered before ordinary and queued native admission.
  Known different native turn IDs can distinguish identical human text; a
  callback without a turn ID uses a short conservative digest window instead
  of pretending the actor is known. Explicit web/MCP human resume remains
  available. The ledger stores digests, not prompt text.
- Archive uses supported Codex thread/archive, retains history and stop state;
  active/error/unknown/permission states are rejected. Notice owns autonomous
  cleanup criteria, meaningful incident names and original-card updates in
  reviewed source34baa9d, awaiting root exact API-ready.
- UI stable-layout source41e92d4 and done-notify opt-out9f2afbd are included.
- Enabled Codex Herder plugin was found in the supported plugin cache; its
  cached coordination script is old. Refresh it through official plugin
  installation after the coherent build and verify exact bytes; do not modify
  vendor core or restart the native daemon.

Remaining: coherent pushed clean main, one combined build, Herder-only rollout,
owned native/API/browser stop/resume and archive acceptance, durable hook-cache
refresh proof. No Notice deploy until exact API-ready SHA/PID is announced.

Live eec043e checkpoint (Herder2712270; native daemon2262581 preserved):
- Existing owned Codex01a11036-e2e7-72a2-9d01-323e2990f4b7 and
  ZCode sess_eb89671b-ba76-41fc-ae75-20727bdfcdf7 received bounded sleep
  prompts, were actually running, and accepted Stop200 with held=true.
- Automatic message/resume/fork and differently named source-based replacement
  were rejected for both (8 live checks); no replacement was created.
- Explicit human messages released both holds and produced matching unique
  SAME_ID_RESUME replies in those same native IDs. Evidence is outside Git
  in the thread visualization human-stop-evidence directory.
- The first synchronous Codex HTTP call and initial ZCode call timed out at
  the client while native admission still occurred. No duplicate prompt was
  sent; inspected the original native IDs before stopping. Subsequent queued
  explicit-resume calls returned200 and actual replies were inspected.
- Live repeat-Stop on already-idle Codex exposed No active turn502 although
  hold was persisted. Fixed idempotent Stop for idle/stopped native sessions
  without pending permission. 2 affected test files/14 checks pass.
- Public MCP registration had duplicated old schemas dropping humanRequested,
  sourceSessions and sender fields. Reused canonical schemas; real MCP
  InMemoryTransport consumer checks passed (2 tests), including blocked source
  creation, deliberate held resume and 200-character model acceptance.
- Peer66c4417 fixes the additional background loading-strip transcript jump;
  include in the corrective build justified by these newly exposed defects.

Separate infrastructure failure recorded without changing archival policy:
codex-session-retention.service failed226/NAMESPACE due its LogNamespace
application drop-in at2026-10-06 04:31:27MSK. Native daemon is healthy and this
30-day maintenance run is unrelated to short native turns. Its next step is
owner review of the supported user-unit logging namespace and archival scope;
do not silently rerun broad30-day session archival as a diagnosis/planner
cleanup canary. This does not block the Herder human-stop API.
