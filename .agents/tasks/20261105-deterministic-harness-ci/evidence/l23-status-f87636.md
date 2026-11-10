# L23 functional snapshot, 2026-11-06

The isolated server-44 candidate is `/tmp/herder-l23-candidate-f87636` with v2 tested-payload SHA-256 `f87636c17fda5fa27a1f2d3ff51be5a5a89dfa1b67dbf129c926b681b8eec2a1`. This is a snapshot of the older WIP HEAD, not a final release candidate. The v2 hash excludes dependencies and does not establish an installed PID.

- `l23-qoder-f87636.json`: Qoder 1.1.84 network-none producer PASS; SHA before and after matches; validator output in `l23-qoder-f87636-validation.json`. Search is in-memory MCP. Dependency-tree immutability was not independently established.
- `l23-fast-search-f87636.json`: two exact sessions, complete scan for matching generation, partial false and two transcript pages; in-memory MCP.
- `l23-hermes-search-f87636.json`: HTTP MCP returns both exact native IDs but scan repeatedly reports `native_source_changed_during_scan`; coverage stays partial, FAIL.
- `l23-browser-fixture-f87636.json`: candidate dist, isolated namespace, two fixture sessions, but content search unavailable, FAIL. This is not ChatGPT.
- Shared release-gate test 13/13; Fast validator test 5/5; search wait contract test 3/3. No full unified PASS.

L21 identity evidence is proposed and has an unresolved packaging blocker; it is not enabled as full bundle identity. Updating L23 via the plan MCP was refused because its estimate expired and it demanded a plan split. The owner requested not to change the overall plan, so this status is preserved here instead.

A separate instrumented diagnostic candidate (not the tested candidate) logged the native SQLite db and WAL stat before/after three scans in `l23-hermes-dbstamp-diagnostic-f87636.json`: only WAL ctime changed; main DB stat, WAL size, and WAL mtime stayed equal. `dbStamp` includes ctime, so it reports `native_source_changed_during_scan`. The actor behind ctime changes is not established, and this observation does not prove content stability. Shared `src/session-search-sources.ts` was not edited.
