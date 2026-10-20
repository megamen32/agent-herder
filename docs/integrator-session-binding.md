# Integrator session binding store

`IntegratorSessionBindingStore` is a bounded durable receipt seam for an
integrator operation. The operation pins one harness and retains its ordered
attempt history. Each attempt binds one host and, when returned, one exact
native session address. It also retains a stable 64-hex attempt input ID,
checkpoint and the typed `FleetCreateReceipt` returned by the owner create
seam.

## States and recovery

- `reserve` writes an `intent` before a caller invokes a native launch seam.
  Only the caller receiving `claimed: true` may launch. Concurrent callers and
  restarts receive the existing record and must not launch again. Harness is
  immutable for the operation; host is immutable for each attempt. Advancing an
  existing operation requires the exact expected prior attempt ordinal, host
  and input ID, checked under the same file lock as the write. A missing or
  stale expectation cannot claim a retry.
- `accepted` is the binding's normalized state for owner receipt `created` and
  requires an exact `{ hostId, harness, nativeSessionId }` address matching
  that attempt's reserved host and the operation's pinned harness. The session
  ID cannot be rebound to another value.
- `unknown` remains unknown, including when no native session ID was returned.
  The stable attempt `inputId` is persisted before launch so a typed owner
  reconciliation reader can query that exact operation. `reconcile` only
  accepts the exact `FleetCreateReceipt` from that owner seam and cannot launch
  or infer refusal. The current fleet owner journal returns `unknown` while an
  exact create request still holds its lock (`fleet_create_busy` is also
  normalized to unknown); neither case opens a second attempt.
- `not_attempted` is accepted only as an explicit retryable receipt from the
  owner seam before another host may be reserved. A later `reserve` using the
  same operation ID and exact prior attempt identity may then create the next
  numbered attempt on a different host with a different input ID. Same-host
  retries, stale snapshots, exceptions, timeouts, process loss, non-retryable
  refusals and missing receipts do not open another attempt. The old v1 operation-level
  host migrates to each historical attempt without changing receipt or input
  IDs.
- Checkpoints are monotonically sequenced per attempt. Equal-sequence updates
  must carry the same cursor.

The JSON store uses a per-path `proper-lockfile` lock, atomic temp-file rename,
mode `0600` for data/lock files, and mode `0700` for its parent directory. A
malformed or incompatible file fails closed; it is never treated as empty.
Receipts intentionally hold only the typed status, input ID, observation time,
reason, turn ID, and evidence reference. Do not pass provider payloads or
credentials.

## H33/H34 composition contract

`admitBoundIntegratorSession` is the source composition wrapper. It calls the
real H33 `admitIntegratorSession` function with H34's optional trusted attempts
port. `request.attemptId` remains the stable operation ID and harness is pinned.
H33 prepares after its readiness and H31 checks, then uses the reserved
per-attempt `inputId` unchanged for native create. H33 validates the returned
receipt against that ID and awaits H34 `record` before considering fallback.
Receipt IDs are never aliased or rewritten.

The wrapper reads the durable binding first. Accepted, intent and unknown
operations return their stored address or unresolved state without native
create. Only a stored exact retryable `not_attempted` permits a later attempt;
the prior host is excluded so fallback selects a different eligible host.
Reservation is atomic, and only `claimed: true` reaches native create. A
concurrent caller that loses the claim returns the journal's existing/busy
state. Once create or record outcome is uncertain, the wrapper returns unknown
and does not try another host during that invocation. After restart, a durable
receipt remains authoritative. A host address is returned only from the final
durable accepted binding, never from an uncommitted candidate.

Unknown without a native ID remains unresolved. The wrapper has no guessed
session-name lookup or provider reconciliation path. This is a typed source
composition only; it is not registered in an index, wired to a runtime, or
accepted by a consumer canary.

## Boundary and remaining reconciliation dependency

This module does not create sessions, discover host identity, or query a native
provider. Its caller must obtain `hostId` from the trusted owner route and pass
the returned launch receipt/address or a receipt from that owner's exact
reconciliation read. It never treats an operation key as authorization.

`src/mesh/fleet-create-journal.ts` exposes `once` but no `get/reconcile`
method. Repeating the exact once request can return a receipt already saved by
that journal; when the journal saved `unknown` after a lost native create
result, current source exposes no read-only native lookup by the same input ID
to recover a missing session ID. Preserve that state as unknown and do not
guess a session by name or launch a new host. The H33/H34 source composition
is not registered in an index or wired to a runtime. No provider launch or
consumer acceptance is claimed here.
