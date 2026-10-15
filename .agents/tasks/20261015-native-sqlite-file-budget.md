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

Latest direct human correction: raise obstructive ceilings for real workload.
Measured100 DB3442515968B, free disk375843815424B,88 free93601443840B,
44 free68946292736B. First256MiB was adequate only for88 and is superseded
by8GiB per file (main+WAL16GiB retains20GiB disk reserve on all measured hosts).
Added sparse native-file-growth test BEFORE this change: actual EFBIG with
256MiB, GREEN with8GiB; one page allocated at DB-size+1MiB, logical temporary
bound8GiB. Existing real SQLite test also GREEN,2tests0.158s on44 in finite
512MiB/CPU1/tasks64/swap0/IO10/10s service.100 actual parent/SDK already
unlimited, untouched.88 GREEN2 original sealed256MiB was retained through
completion: one human input, natural expiry, one automatic recovery, one
completed action and native final. Source/runtime8GiB delivery follows.

Delivered8GiB persistently via supported user-service drop-in on44/88 and
pinned parent/SDK prlimit; same fleet PID239070 on44 and322786/SDK701544 on88,
no restart, other finite cgroup budgets unchanged. Separate native88 acceptance
sess_f48e46aa-58a7-43b4-96c4-cff973a2d77c: one input, native Bash proves inherited
8GiB, real DB quick_check=ok, MCP agent_info completed, LIMITS_OK final.
GREEN2 expiry proof remains one initial input, one auto reconnect, one note,
MCP_EXPIRY_RECOVERED. Own fixture processes and temporary credential copies
removed after terminal result; shared parent/SDK retained. See GPTAdmin task.

Setup findings retained separately: empty native session on100 was started by
unfinished-session automation without its original input; exact own fixture
was stopped and automation disabled, no action replay. Old88 queued-human
fixture stayed empty; its own queue job is cancelled, native input count0.
These old/autostart policy paths are not acceptance substitutes; they require
an independently scoped launcher repair/updated fleet artifact, with proof of
empty-session startup semantics before any production policy change. Evidence
GPTAdmin .tmp/mcp-expiry-20261015/side-findings.md; no blind service upgrade or
restart of foreign sessions was performed under this transport-only change.
