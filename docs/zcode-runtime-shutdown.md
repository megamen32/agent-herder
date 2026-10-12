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
   `--audit-native-activity` additionally reads native DB session identities
   updated since the exact current controller's `/proc` start generation,
   including identities outside the durable launcher store. The receipt also
   lists direct native workspace-client PIDs/cwds under the verified app-server.
   This is independent activity evidence, not an exhaustive loaded-session list:
   a process or a recent DB row alone does not establish an active/owned turn.
   Historical session bootstrap is deliberately unsupported. The 30-second
   deadline and every failed/missing snapshot stay visible; an incomplete scan
   exits 2, and `idleProof` always remains false.
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

The old 6b adapter already maps `nativeActiveTurnId` directly from
`snapshot.runtime.activeTurnId`, with `nativeStateRevision` and native status.
First-upgrade classification requires those existing fields, not a new alias.
`observed_idle` requires an available native snapshot, idle native/session status,
no active turn and no pending request. `native_snapshot_unavailable` (including
a historical row saying running), missing/replaced turn, missing revision,
HTTP failure/hidden ID, unknown hold, pending input/request and foreign Desktop
ownership each have a separate reason. None authorizes stopping an unknown turn.
Root must independently resolve unknown/partial workspace activity before stop;
the checkpoint command only preserves exact proven owned turns in the old store.

## Desktop input race

Native V4 `sendText` has no documented idle-only CAS. `baseRevision` is required
by other V4 commands; it is not claimed as an idle-only fence for `sendText`.
Recovery passes the exact failed turn/user/completion boundary. After all load,
Stop and generated-input awaits, the adapter re-reads an already-existing runtime
and rechecks the existing human Stop store after that final awaited snapshot.
It then synchronously verifies native latest user, turn and input queue immediately
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

## Native SDK drift and a confirmed parent crash

The installed native server strictly validates `session/events` before returning
it. An additive `payload.executionStartedAt` can reject the entire event read;
Herder cannot strip that field after a rejected response. The managed native
bundle remains unchanged. Herder uses its existing readonly native SQLite seam
to correlate the exact command ID in `message.anchor.sourceCommandId` (or native
input metadata), within the exact session, to its own assistant/terminal turn.
Prompt text and a Herder-looking prefix do not prove admission or ownership.
An admission receipt alone does not prove a started turn. A terminal failure
stays non-replayable. Legacy active ownership additionally requires the exact
accepted command and native turn anchor, an existing runtime snapshot matching
that turn, no pending queue and no outstanding foreign input.

The public native `readSessionDebug` uses `existing-only` and its own debug
schema, but exposes model rounds/network history, not active-turn/input-queue
coverage. It is not an idle proof. Existing-only native workspace lists and the
actual owned adapter's active/queued/waiter state are separate scoped evidence.
Cold historical discovery retains its native project address for same-ID resume.

For an externally confirmed owned-parent crash, the existing checkpoint utility
accepts `--confirmed-parent-crash <proof.json>`. The manifest supplies the exact
session, failed turn/user/completion boundary, native command anchor, historical
owned-parent generation receipt and exact journal cursor/error. The utility
checks those actual records, latest user/turn, root identity, settled tools and
no newer activity/pending input/human hold. `--dry-run` records nothing.
Without that flag it stores the exact proof and linked journal/generation context
as internal attribution in the existing locked StopStore, keeping its old schema.
It sends no input and performs no resume. Manual holds remain authoritative.

The Root-caused crash of parent 2193856 on 2026-10-12 at 07:32:04 MSK is prepared
for exact 4b attribution in ignored `.tmp/zcode70a-recovery-20261012/` manifests;
this is not permission to reinterpret other cancelled sessions. After Root's
reviewed installation, re-run fresh guards and record only that proof. Query the
same ID again before the supported prompt-free native resume: if Desktop/native
work has already resumed, submit nothing. Root owns activation and the final
consumer check. Completed 70a and all accepted external actions are retained.
