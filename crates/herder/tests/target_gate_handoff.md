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
