# alltests-web-ui-controls

Description: Full project test suite observed 4 failed test(s) in tests/web-ui-controls.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/web-ui-controls.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- mobile chat and session controls > shows every automation control supported by the active harness
- mobile chat and session controls > keeps automation modes discoverable on mobile with their current state
- mobile chat and session controls > exposes Machines from the session-list header without selecting or creating a chat
- mobile chat and session controls > opens a session deep link directly in the mobile chat

Observed first errors:
- AssertionError: expected 'import {AUTOCONTINUE_HARNESS_IDS,load…' to contain 'onMachines={() => { setShowSearch(fal…'
- AssertionError: expected 'import {AUTOCONTINUE_HARNESS_IDS,load…' to contain 'React.useState(() => readPanelLayout(…'
- AssertionError: expected '<SessionList pins={sessionPins.pins} …' to contain 'onMachines={() => { setShowSearch(fal…'
- AssertionError: expected 'import {AUTOCONTINUE_HARNESS_IDS,load…' to contain 'React.useState<"sessions" | "chat">((…'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
