# Local node session read — root cause and proof (2026-11-14)

Bug: `LOCAL_NODE_MCP_READ_20261114` — MCP `sessions list` for the local node
(`roomhacker-server-100`) answered `code=source_unavailable`
("Адаптер не вернул проверяемый результат чтения."), while the same daemon over
HTTP answered `GET /api/sessions -> 200` with 100 sessions, and a remote node
(`server-44`) answered with registry rows only (`native=null, source=registered`).

## Root cause (measured, not inferred)

The MCP edge reads local native sessions through the AHAP bridge
(`crates/herder/src/bin/herder_native_stdio/owner_reads.rs`):

* `observe()` calls `native("listSessions", {"options":{"limit":256}})`;
  any native error is mapped to `source_unavailable`
  (`owner_reads.rs:551`, `owner_reads.rs:167/199/330`).
* A remote node has an empty registered corpus, so `observe()` returns early
  (`owner_reads.rs:548`) and never calls the native adapter. That is why the
  remote read "worked" — it never touched the native path.
* The local node has 5 registered `codex-local` sessions, so the native call
  runs. The codex adapter answered with the **complete persisted native index**:
  `~/.codex/state_5.sqlite` holds 8 666 threads, `sum(length(preview)) =
  8 221 373` chars → the AHAP frame was ≈ 10.8 MB.
* `writeAhapFrame` (`src/ahap-legacy-read.ts`) refuses frames above 4 MiB and
  answers `-32001`; the Rust facade turns that into `source_unavailable`.

The requested page limit was ignored: `CodexAppServerAdapter.listSessions()`
returned the unbounded index whenever no native controller was ready
(`src/adapters/codex-app-server.ts`, the `!this.isReady() && !this.socketPath`
branch), while the other two listing paths of the same adapter did honour the
limit.

## RED — pre-fix code, same request

Runner: the bundle the live MCP edge actually uses
(`herder-artifacts/releases/herder-v1-userio-lazy-cebecc13/fixture/ahap-codex-runner.mjs`),
request `listSessions {"options":{"limit":256}}` against the real codex index:

```json
{"code": -32001, "message": "AHAP response exceeds 4 MiB frame limit; request a smaller read or use the legacy native export path. No truncated transcript was returned.", "data": {"outcome": "read_failed", "method": "listSessions"}}
```

The same failure reproduced with `limit` = 1, 3, 10, 50 and 256: the limit never
reached the enumeration.

## GREEN — fixed source, same request

Rebuilt runner from the fixed source (`dist/ahap-codex-runner.js`), same env and
same request:

```
row 1: initialize -> ok
row 2: listSessions -> 100 rows, 241 994 byte frame (limit honoured), 0.4 s
```

All five registered `codex-local` sessions are present in the page:
`01a1bc5f…`, `01a1c551…`, `01a1c5a0…`, `01a1c5a1…`, `01a1c8ec…`.

## GREEN — MCP level (native stdio, `sessions list`)

`herder_native_stdio --trusted-owner-profile <local codex profile>` with the
fixed runner behind the profile, `tools/call sessions {"action":"list",
"node_ref":"roomhacker-server-100"}`:

```json
{"complete":true,"limitations":[],"native_coverage_complete":true,
 "next_cursor":null,"scope":"authorized_registered_sessions",
 "sessions":[{"address":{"instance":{"instance_id":"codex-local","node":"roomhacker-server-100"},"native_session_id":"01a1c5a1-…"},"human_stop":{"held":false},"native":{"cwd":"…","harness":"codex","id":"01a1c5a1-…","lastActivity":"…","model":"gpt-6.1-terra","status":"stopped","title":"Починить VPN и автохил"}}]}
```

Before the fix the same call answered `{"code":"source_unavailable","effect":"none"}`.

## Source changes

* `src/adapters/codex-app-server.ts` — one bounded page size for every listing
  path (`boundedPageLimit`); the persisted-index path now honours the requested
  limit and reports `exhaustive:false, reason:"bounded_state_index_page"`.
* `src/ahap-legacy-read.ts` — `boundSessionRows()` keeps the requested row count
  and stays inside the 4 MiB frame budget; a row that does not fit is reduced to
  its identity fields instead of failing the whole read.

## Tests

`tests/codex-app-server.test.ts` ("bounds the persisted state index page by the
requested limit when no native controller is ready") and
`tests/ahap-legacy-read-runner.test.ts` ("a native adapter that ignores the
requested page limit still answers inside the AHAP frame budget") both fail on
the pre-fix source and pass on the fixed source.
