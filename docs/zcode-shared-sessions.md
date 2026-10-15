# One native executor per ZCode session

Desktop and Agent Herder previously maintained independent native service
collections. Opening the same persisted ID could load two executors and start
two turns against the same history. A database row is not runtime ownership.

The shared-session adapter uses the existing native service and connection-scope
contract. Two private Unix endpoints attach consumers to the already loaded
owner. New Desktop sessions are created by Herder's native service. Legacy
Desktop-only sessions retain their live executor; Herder attaches to it. Neither
endpoint invokes the peer's routed service, so forwarding cannot recurse. Unknown
ownership fails before load. An uncertain command response is never replayed.

Consumer disconnect releases its native connection scope and subscriptions,
without cancelling the admitted turn or disposing the workspace. Native lifecycle
disposal remains owned by its hosting process. No additional executor, daemon,
timer, database registry or source checkout is introduced.

## Delivery and native source ownership

The direct human request15Oct2026 explicitly requires one executor and shared
Desktop/Herder state. The existing plugin-only integration observed the real
Desktop continuation but did not prevent a second native turn. The bounded
source adapter is staged against exact installed source hashes; it preserves
the earlier approved catalogue correction. No version drift is accepted.

`stage-shared-session-service.mjs` produces separate candidates. The activation
helper first exports the existing native service with routing disabled. Its
breakpoint is confined to a read call, the exact script and process generation
are verified, and cleanup removes the breakpoint/resumes the host/closes only
its own inspector. Read-only owner probes precede routing activation. Existing
duplicate active owners require explicit reconciliation; they are not silently
replayed or migrated.

Resource budget on server100: retain the sealed native service/cgroup budgets.
The bridge admits at most8 peer connections,128 pending calls/subscriptions per
peer,32MiB framed/output buffers and2048 cached native session addresses. RPC
wait30s and connect3s are finite, without command retry. Focused source/native
parse validation uses CPU1, RAM512MiB soft=hard, swap0, tasks128, IOWeight10,
private temp256MiB and50s emergency wall for expected5s. Measured peak110MiB;
actual runner admission also retains the live host/UID/tenant reserves.

## Acceptance

Installed and accepted15Oct2026 without restarting native hosts. Actual native
Codex caller was interrupted while its ZCode child retained the same turn and
completed91.872s later. Native history contains one input, one completed tool and
one final marker. The real Desktop received the running state and final result
through live events, with no local executor loaded and identical routed native
state in both hosts. Original user task/history and Desktop selection retained.

Six socket regressions, two selected adapter/lifecycle checks and exact staged
SDK/Desktop parsing passed. `scripts/canary-zcode-shared-state.mjs` reads an
already existing owned fixture without loading or sending. Its same assertion
fails with `--original` (preserved original native services) and passes against
the routed native services. These tests followed implementation; this is a
post-implementation regression proof, not strict test-first TDD.

Full acceptance, finite budgets, persistent install/rollback and retained failed
attempts: `.planning/quick/261015-fg7-independent-zcode-session-lifetime-after/261015-fg7-SUMMARY.md`.
