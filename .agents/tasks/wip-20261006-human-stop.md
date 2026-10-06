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

Corrective callback/concurrency gate:
- Peer live send failed before native admission at11:04:36UTC with generated
  prompt lock contention. No duplicate or successful-delivery claim was made.
  Observations of unfenced prompt metadata now read instead of taking a write
  lock; mutation acquisition has bounded randomized backoff. A real shared
  filesystem lock held for1.1s regression verifies eventual input registration.
- A hook can be executing inside the native runtime that a fresh read would
  re-enter. Existing durable holds return immediately; a qualified native
  prompt release uses its supplied evidence without waiting on that runtime.
  Tests emulate a runtime unable to read until its hook returns.
- The already-installed ZCode UserPromptSubmit helper now forwards real prompt
  evidence, preserving the automation input prefix and protected state mode0600.
- 4 focused files/35 checks and TypeScript passed. Supported official Codex
  plugin reinstall refreshed its cached scripts and compiled store/MCP code;
  five source/cache byte comparisons matched. Native daemon2262581 preserved.

Final live480750a checkpoint (Herder3125891, native daemon2262581):
- Codex/ZCode owned native holds survived the Herder restart; automatic resume
  was rejected. Browser owner01a10bc5 verified an explicit Resume in the exact
  original Codex chat, then a bounded sleep turn and actual visible Stop click.
  Final consume=0 returned strict humanStopHeld=true. Browser screenshots and
  controlled action receipts are in .tmp/ui-timings-20261006/stop-resume.
- Notice source guard independently rejected launch from that held native
  source before POST. Its manual card5822 passed real recipient observation;
  quiet card5824 exposed dropped terminal notify_user fields in the Notice
  adapter. The Notice owner is publishing/reloading the correction; quiet live
  delivery is not yet accepted. No phone actions or calls.
- A controlled direct native turn/start to the original owned Codex ID got
  NATIVE_PROMPT_HOOK_OK_20261006 at11:42:57UTC, but the human hold stayed true.
  Native hooks/list shows no Agent Herder plugin hooks despite plugin/list
  installed/enabled=true; the existing user Stop is disabled and no Herder
  UserPromptSubmit handler is registered. Plugin-cache byte parity alone is
  not a native callback acceptance proof. Preserve the hold and investigate
  supported hook discovery/trust, without restarting the native daemon or
  guessing that every recently observed native prompt is human.
- Sender attribution is declared metadata checked against an existing native
  session, not caller authentication. Missing/unavailable/ambiguous sources
  remain explicitly unknown. No ancestry-as-author inference. The Russian
  sender header and reply route precede final generated-prompt registration.

UserIO owning-root handoff verified11:31/11:41UTC: deployed3849f83 contains
f02410f. Selected Telegram chat conv_cedf4b78f9cfa282b3713505 has12 proposed
drafts,12 enabled Send/Edit controls and enabled Suggest Reply. No draft action
was clicked or sent. Cause: late generic refresh response overwrote the selected
account/chat; latest-request-wins fixes the race. First documented complaint
Oct5 07:49UTC predates today's performance work; initial failure time is unknown.
Source main99e0ae is clean per owning-root handoff; deployment of later message
edit support remains separately owned, not part of the restored-button claim.

Native callback and signed delivery acceptance (e55429b runtime3722532):
- Actual same-ID Codex MCP delivery contained the Russian AI sender name,
  full root session ID, canonical copyable URL and correct reverse reply route.
  Automatic follow-up AUTO_SIGNED_MESSAGE_OK_20261006 received its native
  assistant reply; the digest of the actual final delivered body, including
  signature, matched generatedInputs. The initial deliberate human resume was
  not classified as automation. No business messages or new chats.
- Manifest compatibility cfdd2c2 and official plugin refresh still did not
  make Herder plugin hooks visible in native hooks/list. Added the supported
  user UserPromptSubmit callback through installer0c7e3d0, preserving all other
  handlers and the disabled legacy Stop hook. Native CLI /hooks reviewed and
  trusted only this exact new definition; seven unrelated hooks stayed
  untrusted. Callback hash1f0f16111b7c9bea03fa7c075187ddf80e2dff4d0f9e3ff7698075b378c7a958.
- Before new native CLI input, consume=0 held=true. A typed prompt in original
  Codex01a11036 triggered the actual callback and produced
  NATIVE_USER_RELEASE_OK_20261006; the durable row changed to held=false,
  clearedBy=new-user-prompt at2026-10-06T12:43:34.349Z. No Herder
  humanRequested RPC or guessed transcript release was used for this proof.
  Repeated idle Stop200 restored the hold afterwards.
- Own temporary Autopilot overrides restored: Codex inherits the original
  enabled policy; ZCode retains its original enabled per-session setting/CWD.
  Holds remain intact. Global Autocontinue/watchdog settings were not changed.
- Own finished Codex test thread archived via API200; later exact-ID details
  returned200/history retained. Peer immediate archival read exposed a60s
  stale rollout-path cache; archive presence does not prove which racing actor
  committed the archive. Do not replay that mutation. Fix exact-ID reads from
  authoritative SQLite on ENOENT and retain unknown-stop failure semantics.
- Native daemon3673547 began2026-10-06 15:17:34MSK, before our Herder restart
  at15:23:51MSK; old2262581 had disappeared. No native daemon restart was
  requested here. Do not claim that old PID was preserved throughout.

Mac-native log acceptance remains externally blocked:
- Canonical reverseSSH127.0.0.1:2222 accepted then closed before key exchange;
  permitted recoveryLAN192.168.2.8:22 reset the connection. Registered Mac
  Tailscale100.84.94.127 reportsOnline=false. No alternate device/phone used.
- Smallest next step: make the actual Mac reachable and verify hostname
  MacBook-Pro-User.local, then read its native Codex errors and reproduce the
  affected Mac interface. A text availability question is pending; elapsed
  time is not an answer. Server/native-ID/browser stop acceptance is separate
  from this unverified Mac interface claim.

Final combined deployment checkpoint (2026-10-06 13:44UTC):
- Source/runtime 0a4f8469b5319bb115dc73026a684ba3099e1e07, Herder PID113237,
  active and NRestarts=0; main clean and HEAD=origin/main. Bounded build,
  TypeScript and 5 focused files/54 tests passed. The final cold-ZCode binding
  delta passed 3 files/28 checks; these overlapping subsets are not additive.
- Native Codex archive reads now refresh only the exact stale rollout path
  from authoritative SQLite on ENOENT, retry once, and preserve unknown-stop
  failures. Original root archived01a11036 and peer archived01a110fb both
  returned exact-ID details200 after this deployment. No archive replay.
- Explicit signed human choice uses same-ID human-origin resume; automatic
  timeout uses automation-origin resume and cannot clear a hold. Cold ZCode
  target resolution binds the verified native ID to its supplied CWD before
  dispatch. Codex/ZCode original root holds remain strict true after restart.
- Launch policy GET200 preserves independent initial-launch settings:
  Codex/ZCode allowed, preferred Codex, exact existing model routes unchanged.
- Notice final real quiet result was independently accepted: d236108,
  inc_8748be7099304b029397d58e3521b9a6, durable notify_user=false,
  Telegram cancelled, no sent Telegram/calls and no planner. Its native
  diagnosis completed in the original admitted Codex session.
- Peer01a1106f owns the remaining actual same-ID ZCode choice/queue browser
  acceptance after the coordinated Notice attachment upgrade. No root
  Herder/native restart or native canary mutation is planned during it.
- Native user UserPromptSubmit callback is trusted and proven above. The
  disabled legacy Stop hook stays disabled; plugin hook discovery still did
  not register Herder handlers. Do not extrapolate this callback proof into
  blanket native Autopilot acceptance for every Codex session.
- UserIO owner final no-send acceptance on ddb92cd/core3820661 confirms all
  12 existing proposed drafts and enabled Edit/Send controls in the exact
  selected chat. The first documented complaint remains Oct5 07:49UTC;
  exact first failure time is unknown. Source text/attachments are a separate
  owner-coordinated extension, not part of the button restoration claim.

Peer live ZCode interim proof received after Notice upgrade (13:49UTC):
- On Herder PID113237, automatic input into held sess_5af9 was rejected
  nonRetryable. Explicit browser Resume reused that exact ID and cleared its
  hold; previously disabled Autopilot stayed disabled and its response ended.
- With Autopilot enabled only for the controlled canary, the question created
  a choice and released native Stop. A new composer input appeared in the
  same native history and received the completed answer “ОЧЕРЕДЬ ПРОШЛА”.
  Signed choice/duplicate proof and final canary hold restoration remain
  pending the owner's final receipt; do not extrapolate this interim result.
- Owner's readonly Codex planner01a110fc archive returned200, followed by
  immediate exact-ID details200 with3 messages. This closes the real first-read
  archive path regression without repeating the earlier uncertain archive.

Adjacent live duplicate-choice defect now owned (13:54UTC):
- Peer observed two pending choices for the same native color turn8ca1 and
  two more for completed queue turnf604. Cached last user context included
  generated leading coordination notes; the judge treated that service block
  as unfinished user work. Existing receipt hash changes with evidence and
  stopHookActive, permitting another terminal decision in the same native turn.
- Released only src/autopilot/index.ts and tests/autopilot-core.test.ts to
  peer01a1106f for a judge-view-only envelope filter plus turn-wide terminal
  receipt guard. Preserve raw native prompt, generated digest, cached evidence,
  ancestry and all human-stop gates. Continue decisions may reevaluate;
  durable pending completion notice retry must keep its original key.
- Final noise/signed-choice acceptance is pending this coherent correction.
  Root owns bounded review/integration and a necessary combined build only
  after the peer releases its current canary window. No other runtime edits.

Corrective source review/checkpoint (14:38UTC):
- Cheap independent review found and then cleared three sanitizer defects:
  arbitrary literal tag removal, missing canonical envelope recognition, and
  bounding before projection. Final judge view strips only complete leading
  canonical generated boards before truncation; literal/incomplete markup and
  actual trailing user goals survive. Transcript projection uses the existing
  4MiB scan bound and final16KiB judge budget. Raw prompt/cache/receipt evidence
  is unchanged. All generated-input fingerprints and human-stop gates remain.
- The receipt loader previously discarded persisted kind=choice. Corrected
  loading plus session/turn-wide terminal suppression retains changed-hash
  pending notice retry with its original payload/key, while changed evidence
  after continue and later native turns can still be judged.
- Root shared-budget absolute-Node run passed core28/28 in3.43s; six related
  files passed45/45 in6.84s. No broad-suite success is claimed. The packaging
  failure was a stale static test assertion: supported readContext(true) still
  consumes inbox context and the packaged script was present. Only that
  obsolete assertion was aligned with the existing helper call.
- Status owner published171f0fa/1addfe6: qualified native user-prompt marks
  turn-start; activity refreshes a bounded running heartbeat; Stop records
  turn-end even when held; persisted status considers observed lifecycle and
  native session time_updated in milliseconds. Automated input early return
  and releaseHumanStop were preserved. Independent source critique and the
  affected HTTP/hooks/status/human-stop checks passed.
- During integration the user-service manager changed independently of this
  task; one scope launch failed before tests with D-Bus connection refused.
  Live user manager666051 and Herder666185 subsequently became active. Root
  did not request that reset. The controlled rerun started after bus recovery
  and passed. dist/autopilot/index.js still has16:22:29MSK build time (0a4 code);
  do not equate new source HEAD with deployed compiled behavior yet.
- Peer verified old color selection was an automatic timeout receipt, not a
  signed human click. No signed-click claim is made from that receipt. Its
  test session remains stopped/held=true/Autopilot off; fresh actual selection,
  duplicate suppression and final no-noise proof await the corrective build.
