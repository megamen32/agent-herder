# ZCode: exact recovery and first upgrade

The daemon's owned ZCode runtime can label its own shutdown as a human
cancellation without an assistant error. Generic cancelled turns remain fenced.
An exact pre-stop proof is stored in the existing, cross-process locked
HumanStopStore internal-stop attribution (`ignoredStopIds`); its existing schema
is readable by the previous daemon. No second session registry is introduced.

Proof requires a native turn observed in the existing owned runtime, an exact
promoted input with `intent.clientId=agent-herder`, no pending input/permission,
and no outstanding Desktop continuation. A loaded/subscribed session alone is
not ownership. Manual human holds are never cleared. The readonly projection
recognizes only that exact root turn cancelled within the recorded shutdown
window, with unchanged latest user, no assistant success and no later work.

## First upgrade owned by Root

The running old daemon lacks the new signal handler. Before its first stop:

1. Publish/build the owned source, retaining foreign WIP boundaries. For a narrow
   helper build before the site build, compile only `src/human-stop-store.ts` and
   `src/adapters/zcode-recovery-boundary.ts` with the repo TypeScript compiler,
   NodeNext/ES2022, into ignored `.tmp/zcode-checkpoint-sdk`.
2. Run `node scripts/checkpoint-zcode-runtime-shutdown.mjs --module-root
   .tmp/zcode-checkpoint-sdk --dry-run --receipt .tmp/first-upgrade-read.json`.
   It verifies the active Herder PID and exact descendant runtime, then observes
   existing durable session identities through the current local HTTP surface.
   It never resumes/creates/submits work. Unknown, held, pending or Desktop work
   is excluded. Coverage is explicitly partial, never a blanket idle proof.
3. After Root verifies the actual boundary, run the same command without
   `--dry-run` immediately before the controlled stop. This writes exact
   internal-stop attribution into the already locked store while the old daemon
   is still alive. It preserves manual holds and all accepted input/tool results.
   Keep the receipt and re-check PID/generation/state after stop. Never invent
   proof retroactively for a generic cancellation.
4. Activate the reviewed build once; retain the receipt for the first upgrade.
   For later upgrades use this pre-stop seam through the existing service's
   ExecStop route, or an explicitly reviewed main-first graceful stop order.
   The new SIGTERM/SIGINT handler also checkpoints the owned adapter before
   disposing it. With `KillMode=control-group`, simultaneous child termination
   can defeat an in-process observation; the pre-stop seam remains necessary.

## Desktop input race

Native V4 `sendText` has no documented idle-only CAS. `baseRevision` is required
by other V4 commands; it is not claimed as an idle-only fence for `sendText`.
Recovery passes the exact failed turn/user/completion boundary. After all load,
Stop and generated-input awaits, the adapter re-reads an already-existing runtime
and synchronously verifies native latest user, turn and input queue immediately
before ready-transport dispatch. New Desktop/queued/unknown work prevents that
recovery input. Ordinary guide/coordination delivery is unchanged. This is the
closest supported guard, not a cross-controller atomic admission guarantee.

The once-authorized live 70a continuation was admitted, produced new assistant
and tool events, and completed the same native ID. Desktop input preceded it;
its running state is not attributed exclusively to our continuation. Both
accepted inputs and completed tools were retained; no further recovery/cancel
was sent. Receipts: ignored `.tmp/zcode70a-recovery-20261012/`.

Checks: focused integration exact store/schema/hold/ownership/receipt boundaries
(expected 2s/max30s), protocol fake Node transport (expected2s/max10s), adapter
and launcher failure shields. No phone, calls, new business sessions or provider
experiments are involved in these tests. Root owns runtime activation and actual
consumer acceptance; source tests do not substitute for that boundary.
