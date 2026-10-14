---
status: investigating
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
