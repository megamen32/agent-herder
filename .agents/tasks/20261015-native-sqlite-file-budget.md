# Native SQLite file budget on88

Discovered while fulfilling the direct human MCP-expiry TDD/native acceptance
mandate in GPTAdmin. Native GREEN failed before tool dispatch: SQLITE_IOERR.
Source ownership is this fleet unit template/drop-in and focused real SQLite test.
Canonical main; preserve unrelated untracked OpenCode artifacts and native data.

Measured88: available RAM about90GiB, free disk93837410304B. Native database
97124352B, WAL exactly16777216B, SHM65536B. Fleet parent322786, SDK701544 and
owned native CLI772131 inherit hard/soft LimitFSIZE16777216. Native quick_check
returned ok; server-side failed canary note count0. No database repair/replay.

TDD: first small SQLite insert did not touch pages above cap and was discarded
as a reproducer. Corrected actual20MiB DB plus1MiB append/checkpoint reproduces
sqlite3.OperationalError: disk I/O error with inherited16MiB. Source template
remained unchanged until that RED. Fast unit expected1s/emergency10s; real
disposable21MiB data, finite44 test service512MiB/CPU1/tasks64/swap0/IO10,
temporary64MiB and inherited test-only file ceiling512MiB.

Reviewed budget change: per-file soft/hard256MiB permits about2.7x the existing
97MiB DB and its checkpoint while retaining finite limits. Main+WAL headroom
is at most512MiB, far below current88GiB free disk; no RAM/swap/CPU/tasks/I/O
limit or existing artifact/storage aggregate is raised. Persistent unit template
plus native-sqlite-file-budget.conf drop-in. Live prlimit only the pinned fleet
parent and its pinned SDK (future native CLI inherits the new budget); current
foreign children retain original sealed limits. No service/native restart.

Acceptance: same real SQLite test GREEN and fresh native ZCode post-expiry
single-action completion under the reviewed cap. Original failed canary and
its request are preserved, never continued or replayed. GPTAdmin evidence:
.tmp/mcp-expiry-20261015/{fleet-file-budget-real-red.log,fleet-file-budget-green.log}.
