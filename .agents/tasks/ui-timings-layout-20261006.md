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
