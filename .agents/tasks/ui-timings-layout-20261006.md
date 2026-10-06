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
