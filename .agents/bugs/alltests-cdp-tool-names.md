# alltests-cdp-tool-names

Description: Full project test suite observed 3 failed test(s) in tests/cdp-tool-names.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/cdp-tool-names.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- the ChatGPT tools of the MCP server > serves one owner per name when the live page and the archive are both present
- the ChatGPT tools of the MCP server > lets the local archive answer a name the live page cannot
- the ChatGPT tools of the MCP server > registers no ChatGPT tool when there is no driver at all

Observed first errors:
- AssertionError: expected [] to have a length of 1 but got +0
- AssertionError: expected [] to have a length of 1 but got +0
- AssertionError: expected [ 'read_message', 'event_list', …(34) ] to include 'list_agents'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
