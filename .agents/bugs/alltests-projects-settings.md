# alltests-projects-settings

Description: Full project test suite observed 1 failed test(s) in tests/projects-settings.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/projects-settings.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Projects navigation > is a first-class tab next to the other sections

Observed first errors:
- AssertionError: expected 'import {AUTOCONTINUE_HARNESS_IDS,load…' to contain 'showProjects ? "projects"'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN 4 test files, 99/99 PASS. Assertions follow current real UI: session mobile hash navigation persists, all panel states reset before entering Machines, project/settings tab identity preserved, statistics shows coverage and per-harness counters. Unsupported harnesses remain visible, clearly labeled and disabled, never silently enabled. No runtime guards disabled; existing functional markup confirmed.
