# Stable chat layout while load timing values refresh

Owner: Codex01a10bc5-6c86-7011-9962-e1bbd2285921.
User asks for multiple real browser screenshots and removal of header/transcript jumps caused by sessions/latest/hydrate loading metrics.

Ownership: ONLY src/web-ui/styles.css and a separate layout helper/tests; main.tsx/API/hooks and generated prompt attribution/provenance remain root01a10b3f. No separate Vite build/restart. Include scoped commit in root's single combined build after before/after proof.

Before first browser run: live Herder1051892 active, budget1GiB soft/2GiB hard,512MiB swap,4CPU,512tasks unchanged. One browser, CPU affinity2, renderer limit2, JS heap256MiB/renderer, existing host session guard; no GPU tasks, temp/evidence only scoped ignored .tmp/b and .tmp/ui-timings-20261006 (<100MiB). Browser workload within shared project budget; no simultaneous local build/test batch, no new native prompts/agents. A fresh public browser and prior own profile redirect to auth; failing pages screenshot captured before navigation. Read-only UI proof continues through the actual same deployed app on documented loopback18787; public SSO acceptance remains pending.

Source cause candidate: .load-timings flex-wrap lets value width changes add/remove rows in constrained chat headings. Also base rule appears after mobile media hide with same specificity, overriding intended mobile display:none. Background latest refresh resets hydrate measurement; main.tsx is not ours. We will reserve fixed geometry for the visible metric row and preserve intended mobile behavior in CSS. Inspect loading banner in transcript for separate in-flow movement; verify screenshots and measured rectangles before changing.

Current source/runtime gate: Notice9d5e3d6 source ready; Herder API NOT READY, stop/provenance race work ongoing. No deploy/canary until exact root readiness. Attribution must be applied to actual sent text BEFORE rememberGeneratedPrompt and must include real sender native address to enable replies; owned with root, no parallel native adapter edits.

## Source/browser acceptance before combined build

User explicitly chose gpt-5.6-sol (5.8 unavailable in enabled subagent list); worker herder_stable_layout changed only styles.css. No separate helper/source-mirroring test: real browser geometry is the discriminating check for this reversible CSS slice.

Before at1050x780: chat510px, actions531.531px, heading0px, metrics3rows45.0625px/header127.0625; title/CWD collapsed. Before mobile390x844: timing display:flex despite intended media hide, header93.6875px. Screenshots before1050a/b, before1280, before-mobile captured and inspected.

After local overlay of exact edited stylesheet on actual deployed app (no fake UI): at1050 header130px/scrollTop130px, heading470px, metrics one row12px.60 natural frames in9s had invariant header/scroll/timing geometry.5 explicit timer states …/—/999ms/13s/89.9s also invariant. At1280 heading434.515px/header94px; mobile timings hidden/header86px. Snapshots verified all three automation/settings controls remain accessible in existing Chat menu. After1050a/b, after1280, after-mobile and after-menu-accessible images inspected in owned session; browser herder-timings-20261006 closed.

CSS scope: chat-pane container queries; nonshrinking action row; constrained desktop hides long duplicate automation buttons but retains menu access; <=560px chat pane uses stable heading/actions rows; single-row timing grid with reserved5ch value slots; later higher-specificity mobile hide. No change to main.tsx timing data reset or history banner (no banner in captured frames, no confirmed related movement). Scoped ignore only .tmp/b and .tmp/ui-timings-20261006 keeps task evidence without hiding foreign work. git diff --check passed.

Runtime acceptance still pending root's single combined build/restart. Public SSO proof blocked by expired login and recorded screenshots; same real app exercised via documented loopback18787. No Native turn, stop, resume, settings save or Notice delivery was issued for this browser slice. Herder root-owned WIP remains preserved; do not call global checkout clean before root publication.

## Postdeploy verification and remaining refresh-strip defect

Live eec043ee00886d52498b54aea2f516172b6f4aed / PID2712270, asset index-Dyuq95Qv.css includes41e92d4. Read-only exact planner01a1103b-803f-7d60-9748-bff6fe3cdc62 opened through the same app loopback; heading/transcript matched, no injected stylesheet. Inspected live-1050-a/b, live-mobile and live-menu-accessible screenshots. Header130px/timing12px stayed constant over60 frames/9s with7 actual timing-text variants; desktop1280 header94px, mobile390 header86px/timings hidden; all automation and launch settings remain accessible in Chat menu. Browser closed, no policy or native mutations.

This live check exposed an additional actual jump: chat-scroll height563→520→563 whenever latest becomes loading. main.tsx sessionActivity fallback creates an activity-loading strip in the composer grid; its36px height plus7px gap displaces the transcript. The first CSS fix proves header stability but does not close this second defect.

One additional scoped CSS rule positions only activity-loading above the composer without changing other activity states. Before proof is live-observe-1050.json. Actual app overlay of only this rule, loading-strip-after-observe.json:60 frames/9s including7 real loading-strip frames; header, full scroll rectangle and full composer rectangle each have exactly one geometry variant. Screenshot loading-strip-after-1050.png inspected; owned browser closed. No source-mirroring tests or independent build/restart. Root will include this rule in the already-required idempotent-stop correction build/restart; final deployed verification remains pending exact new SHA/PID. Root-owned supervisor/test changes are preserved.

Sender attribution/reply formatter remains root01a10b3f owned and incomplete; metadata must describe the real sending session and precede rememberGeneratedPrompt, independently of ancestry sourceSessions. Notice upgrade still waits for exact API-ready after native stop/resume acceptance. This tracker does not claim either requirement complete.

## Deployed CSS acceptance

2026-10-06 11:12–11:14UTC: actual live app, PID2919148, deployed CSS asset index-BIsPHvTN.css. Exact same native planner URL/heading/transcript, no task stylesheet overlay. Desktop1050:60 frames/9s, natural loading strip present with computed position:absolute; header, full scroll rectangle and full composer rectangle each have one geometry variant despite3 timing-text variants. Mobile390x844:60 frames/9s, scroll and composer full rectangles each have one variant. Final-live-css-1050.png, final-live-css-mobile.png and final-live-css-menu.png captured and independently inspected; menu retains continuation/autopilot/launch controls. Both owned browser runs closed; no prompts, stop/resume, policy changes, builds or restarts by this owner.

CSS layout slice41e92d4+66c4417 is live and accepted. This does not release the separate Notice deploy hold or prove native stop/resume or sender attribution. Root is still changing human-stop store/supervisor/ZCode hooks/tests; those files are preserved. Public SSO login remains unverified; proof uses the actual production app's documented loopback, not a mock or standalone preview.

## Authorized native browser acceptance after480750a

Root announced480750a437fc337233cb026fb3299b6d41547f22/PID3125891, clean main, supported hook bytes refreshed and preserved native daemon2262581. It exclusively granted this owner the existing Codex01a11036-e2e7-72a2-9d01-323e2990f4b7, held=true/autopilot temporarily off; its ZCode fixture was reserved. No new native session was created.

Actual browser opened the canonical native ID through documented loopback. Inspector/title/transcript matched. Resume button sent POST resume/humanRequested:true→200, retained the same ID, displayed running and an actual assistant reply «Задача завершена: проверочный ответ отправлен». The turn completed before the Stop click could find its button, so supported idle Stop API200 restored the hold. To verify the actual visible Stop path, one bounded human UI message in the same ID requested only sleep30/no files/no network; UI showed running, actual Stop button click returned200/humanRequested:false, inspector returned «Явная остановка — автоматика приостановлена». Final strict GETconsume0 held=true; Notice source gate also rejected this source before POST after the browser.

Screenshots stop-resume/before-held.png, after-resume.png, controlled-running.png and controlled-final-held.png captured and inspected; actual requests recorded in controlled-actions.json. All owned browser sessions/broker closed; no user business mutation or policy change, no calls or ZCode writes, no Herder/native daemon restart. Root received fixture release with held=true and untouched/off autopilot. Evidence is in the existing scoped ignored .tmp/ui-timings-20261006/stop-resume. Public SSO is still outside this acceptance.

Own layout/native UI/source-stop checks are accepted. Root's separate sender formatter remains WIP in handlers/session-tools/new provenance module/tests; preserve those paths. Notice owner is correcting terminal adapter decision-field loss discovered by the first real quiet canary before another scoped release/canary; overall quiet delivery is not yet claimed.

## Sender reply proof and final quiet phase

Root source046fda6 plus compatibility manifestcfdd2c2 and docse55429b published. Root confirmed live e55429be4982c3e4a46581b0d24370d293dbac64/PID3722532 at15:23:51MSK, after the corrective Notice d236108 quiet result was already captured. Restart window END was communicated to Notice owner before its separate new ZCode queue canary. No own Herder restart/build or new canary.

This owner used actual send_message with truthful fromHarness:codex/fromSessionId:01a10bc5-6c86-7011-9962-e1bbd2285921 to existing root01a10b3f. Received real reply header explicitly identified «AI-сессия Codex», full root native ID, canonical copyable URL and JSON reply args addressed to that root ID with this receiver's sender fields. An earlier message with no sender declaration showed truthful unknown AI sender. Ancestry sourceSessions was never used as authorship. Existing live deliver metadata lacks from fields; send_message exposes them and was chosen for declared reply context. Native caller authentication is unavailable in the shared MCP contract; this proves declared existing-session attribution and reply routing, not authenticated identity.

Independent read of Notice .tmp/notification-noise-20261006/quiet-final-proof.json confirmed inc_8748be7099304b029397d58e3521b9a6, Hub5fda0ed782c28cdef462c1c1c85ba9b3, native01a11112-b1a4-7ac0-b1b0-023c16bc0f00 completed42114ms, durable notify_user:false, Telegramcancelled, no sent calls/Telegram/no planner. Notification behavior is accepted; no independently verified infrastructure repair is claimed.

Separate root blocker remains native hook delivery: installed/enabled plugin and supported refresh did not produce Herder handlers in native hooks/list. Root is implementing additive reviewed own UserPromptSubmit user-config callback without trusting unrelated hooks or guessing human intent. Root reported native daemon3673547 started15:17:34MSK, before its Herder restart; old2262581 disappeared for an unknown cause. Historical preserved226 proof above applies to its earlier checkpoint only. Root-owned ZCode/server/hook installation source/tests and untracked .tmp diagnostics remain untouched; global checkout cleanliness is not claimed while this WIP exists. Own layout/UI/source-stop/declared sender proof is accepted and published.
