# HumanStop execution-gate handoff

This is a scoped prototype, not an integrated dispatcher or authority. The
production fail-closed guard in `application/reconcile.rs` remains in force.
No schema, canonical mapping, stop/release writer or Codex transport was changed.
The independent `application/target_gate.rs` primitive is only compiled by the
fixture; it accepts an already-open file and cannot establish its authority.

Legacy `HumanStopStore.withSourcesUnheld` holds the stop file lock while the
callback checks exact target identity and starts `supervisor.sendMessage`, but
`startNativeAdmission` returns a promise without proving the native write. In
`adapters/codex/connection.rs`, the actual synchronous transport boundary is
`stdin.write_all` and `flush` inside `request`; it then waits for an RPC response.
Creating/polling an async future is not equivalent to that write. Holding a gate
through the bounded `CodexControl::submit` response is conservative; no SQLite
transaction may remain open over that wait.

The integration owner must supply the exact Dirac schema/mapping SHA and the
following verified contract before activating the prototype:

1. Provision scope identity and generation atomically with the immutable mapping
   for a fresh isolated native session. Existing/imported sessions are unavailable
   until all old stop writers and holds have a verified handoff. Missing, stale,
   ambiguous or inaccessible authority fails closed. Resolve every alias to the
   same canonical native address and generation; do not take lock names from a
   request or infer identity from environment, lineage or a native snapshot.
2. Authority provisioning must bind every overlapping stop scope (including
   applicable global and ancestors) to a protected, permanently retained inode
   set and a common acquisition order. Every stop, release and dispatch writer,
   including other processes, must use those same inodes. A fresh file under a
   replaced path, an unchecked hardlink or an independently created inode breaks
   the lock. This prototype does not establish those filesystem guarantees.
3. Stop committed before claim must deny dispatch. Between claim and native
   handoff, acquire the common gate and atomically re-read authority generation,
   all applicable holds and exact intent. If stopped, transition using a state
   accepted by the actual schema and record definitely-not-sent. Never infer that
   `dispatching` or a successful claim alone permits the native write.
4. If final check passes, release the SQLite transaction but keep the gate until
   the bounded transport submission returns, not model completion. If handoff
   wins, subsequent stop records a hold and requests interrupt/reconciliation;
   it must not report definitely-not-sent. Timeout, broken pipe or crash after a
   possible write is UNKNOWN. A process exit and a released OS lock do not prove
   that a delegated native writer has stopped: do not retry or grant another
   writer until its lifetime is fenced and the original receipt is reconciled.
5. Barrier tests in `target_gate_fixture.rs` use a real cross-process OS file
   lock, an isolated *fixture* SQLite table and a Unix socket pretending to be a
   transport. They check stop-before-claim, stop between claim/handoff, and
   handoff before stop. The fixture's cancellation/interrupt flags are assertions
   about a toy state machine, not evidence of the actual application. There are
   no sleeps; child process and pipe handshakes order the barriers.

Still required after schema handoff: production-wired barriers for all four
cases, including reopen and restart, ancestor/global scopes and alternate aliases;
a fresh isolated native create -> unique deliver -> native readback -> stop ->
next denied; existing/unknown target denied; process-death and lost-response
UNKNOWN with no second submission. Do not count the fake socket fixture as this
native proof. Review the three reconcile success tests blocked by the temporary
unconditional authority gate without hiding their failures.

## Scoped v3 implementation and evidence

The earlier fixture-only description above is historical. The scoped v3 path is
implemented in `application/scoped_stop.rs`: an explicitly provisioned empty
isolated SQLite v3 authority pins one OS gate inode, and immutable session
binding, authority generation, scope generation, `global` and session scopes
commit together after a bounded native root create while that gate is held.
Unscoped legacy dispatch is refused. Imported or parented sessions have no
verified handoff and do not obtain scoped authority. The v2-to-v3 migration is
explicit and was executed only in disposable test databases; it is never applied
by `Writer::open_file`.

Claim and stop acquire the same pinned gate. Handoff acquires it again, checks
the exact mapping, scoped generation, durable claim and all registered holds in
a short SQLite transaction, durably marks `handing_off`, commits, and keeps the
OS gate through the bounded native submit. A stop that wins before handoff is
recorded as definitely not sent. A lost submit, crash during handoff, or lost
interrupt remains UNKNOWN; a persistent fence blocks replay and another writer
on that session. Interrupt attempts are bound to the exact session and native
turn and persisted before the bounded call, preventing repeated interrupts.
Acknowledgement alone is not native cancellation proof.

`tests/scoped_stop_gate.rs` uses pipe and channel barriers, including a separate
OS process for stop versus the real application handoff path, with no sleeps.
The three previous positive receipt, restart and no-replay cases were moved from
`reconcile.rs` into this suite under the same names and run with scoped
provisioning. The ignored live test starts a real isolated Codex app-server with
the shared loopback model and a barrier proxy: scoped create, unique send, exact
native receipt lookup, native interrupt, independent reopened `thread/read`
showing `interrupted`, and a denied next claim. The test-only Codex wrappers
poll the current create/submit futures once and fail if they ever suspend; they
are not a production adapter or an asserted general async cancellation contract.

The default MCP launcher does not yet construct `ScopedAuthority` or supply a
production bounded create/handoff implementation and issuer. The v3 route is
therefore not claimed installed or available to ordinary clients. Completing
that composition must preserve the synchronous bounded-handoff contract and
must not route around the gate. No live migration was performed.

### Isolated native readback, 2026-11-07

On source base `c5946f40` with the scoped candidate, Codex `0.167.0`
(binary SHA-256 `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`)
ran against the local test-model through the barrier proxy. Its fresh native
thread `01a1b4b9-e93b-7c11-b255-f6711c561ae0` and turn
`01a1b4b9-ea4c-77a1-9cfb-f8f1ce931dee` were matched to the stored receipt.
The exact `interrupt_exact` call was acknowledged, a separately reopened
app-server read that turn as `interrupted`, and the subsequent claim was
denied. The profile, authority database, gate and model process were disposable;
this is an isolated test, not installation or evidence of legacy cutover.

### Integration and blocking stop, 2026-11-07

On `origin/main` 740ac97f plus the scoped commits, `cargo test --test
 target_port` passed. To reproduce the external-harness collision, copy the
`origin/main` version of `tests/target_port.rs` to a temporary integration test
in the same `tests` directory and run `cargo test --test
 target_port_external_repro --no-run`: compilation reports E0624 on
`has_session_binding_schema`, `claim_create_exact`, `mark_create_unknown` and
`commit_created_session`, plus E0599 for the distinct externally included
`SessionRegistry` trait. The candidate imports the registered library module;
no store privacy was widened. The temporary repro file was removed.

Stop now waits on the same pinned OS lock, rechecks its identity after acquiring
it, and records its hold without requiring the caller to retry Busy. The
cross-process handoff barrier verifies a competing gate is busy before stop;
stop completes after the handoff without sleeps or a database transaction
while waiting. The isolated native proof was repeated on this base: thread
`01a1b4be-bfac-73e3-a564-f36ab5f7fa11`, turn
`01a1b4be-c0ef-7852-8aa9-4c79490e46f5`, exact interrupt acknowledged,
reopened native read `interrupted`, next claim denied. This does not change the
production-composition limitation above.
