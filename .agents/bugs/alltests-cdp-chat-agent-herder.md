# alltests-cdp-chat-agent-herder

Description: Full project test suite observed 4 failed test(s) in tests/cdp-chat-agent-herder.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/cdp-chat-agent-herder.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Agent Herder CDP chat capability > registers namespaced tools alongside the existing coding-agent send_message
- Agent Herder CDP chat capability > does not advertise chat operations that a partial driver cannot verify
- Agent Herder CDP chat capability > registers the read-only checkpoint archive instead of fixture chat tools
- Agent Herder CDP chat capability > starts the Agent Herder MCP server without the live BrowserClaw tools when the adapter is unavailable

Observed first errors:
- AssertionError: expected [ 'cdp_edit_message', …(40) ] to include 'send_message'
- AssertionError: expected [ 'read_message', 'event_list', …(35) ] to include 'send_message'
- AssertionError: expected [ 'read_message', 'event_list', …(37) ] to deeply equal ArrayContaining{…}
- AssertionError: expected [ 'read_message', 'event_list', …(34) ] to include 'list_agents'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Isolated 18/18 CDP and common-scope tests green; current catalog advertises cdp_chat/cdp_archive/cdp_account while original CDP names continue as callable aliases and unsupported partial driver action is not registered.
