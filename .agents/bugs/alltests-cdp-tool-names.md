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
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Isolated CDP 18/18 green; one consolidated CDP handler per family; old cdp_list_chats and cdp_export_chat direct calls still verified to answer.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
