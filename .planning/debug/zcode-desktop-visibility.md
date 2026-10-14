---
status: resolved
trigger: User cannot see ZCode sessions created by Agent Herder in ZCode Desktop
---
## Mandate
Same owning Agent Herder task; preserve native IDs/history/foreign activity.
TDD regression plus real native desktop listing proof. No runtime core patches.
## Current focus
Compare native createSession persistence and metadata/workspace registration
with desktop task catalogue. Verify live host and supported extension before edits.

## Verified cause
- Human confirmed server100 Desktop. Actual Desktop3.15.3 host1431671 and Herder
  server437103 open the same tasks-index.sqlite; native rows/IDs/history exist.
- Actual native GUI omits new Herder airlock16ae while showing earlier tasks.
  Timeline/By project configuration-only canary failed; restored initial prefs.
- Installed createWindowHostControllerRuntime refreshSource returns immediately
  for the same source service object after its first snapshot. It refreshes only
  on that process's onDynamicWorkspaceEvent, which the separate Herder server
  cannot emit into Desktop. Exact native controller test reproduces the omission.

## TDD candidate / installation boundary
RED: exact installed source returns old task IDs after external row insertion.
GREEN: staged source observes catalogue revision and rereads registered online
local source through existing refreshSource. Three lifecycle tests and full
native module parse passed; runtime remains unmodified and un-restarted.
Observer is serial2s/unreferenced/cleared on dispose, no remote/offline sources,
no model calls or session creation. Native guard receipts under private .tmp.
Parent /home/roomhacker/agents-projects/AGENTS.md says to ask about runtime-source
policy after supported extension cannot provide capability. Candidate review:
integrations/zcode-desktop/README.md. Actual Desktop acceptance remains OPEN;
changing ASAR/activating candidate requires that explicit decision and safe
handoff of active Desktop CLI turns. No task recreation is needed.

## Resolution / actual acceptance
Human approved the precise native core patch. Activated tested observation in
existing host1431671 through a bounded debugger call at a read-only list request,
with verified exact script identity. No script-source replacement/dynamic import,
application/host/CLI restart. Breakpoint removed, host resumed and own inspector
closed. The old airlock16ae row appeared in the actual native sidebar.
Then one real GPTAdmin/Herder create_session returned d6546a0b in airlock-admin;
its unique title appeared automatically in Desktop. No prompt/model call.
Both policies disabled for this own empty canary. Native index confirms one ID.
Persisted identical candidate in ASAR through tested journalled installer; exact
SHA256 readback. Protected rollback preserves header/length and original source.
The previously unopened catalog-to-json folder was registered using the native
OpenWorkspacePath action; its original0dd4 task appeared. Original TelegramAuto
selected task dc1fbdef and Timeline/updated preferences restored. Same Desktop,
host and original2 CLI processes remain. Native screenshots inspected in place.
No sessions/history were recreated. Private acceptance.json records identities.
