# Independent autostart source predicate

`autostart_source_verifier.py` reads the original failed Codex session, independently of its repair executor. It does not start/resume a harness, use an LLM, send messages, poll in a loop, or alter Herder registries. It reuses the installed NoticePlace `SourceVerifier` for lifecycle, pagination and durable UNKNOWN reconciliation.

## Predicate and supported seam

The source tuple is `agent-herder / agent-herder-autostart / <exact host> / unfinished-session-autostart-failed`. The exact correlation is reproduced from the existing `UnfinishedSessionRecord` using the producer's `unfinishedRecordKey` and `startedAt`. No session ID is guessed from title/body. This first bounded adapter supports Codex only; other harnesses return unknown.

After a source request is pulled, the predicate freshly reads:

- Herder `unfinished-sessions.json`: exact episode, failed native root turn and failure notice time;
- `human-stops.json`, `human-requests.json`, `choices.json`: no active STOP/pending question for this original session;
- Codex `state_5.sqlite` in read-only/query-only mode: exact unarchived session, workspace and rollout path;
- the native rollout header and at most its final4MiB: a new native `task_started` followed by `task_complete`, in that same session and failed root, both after the failure notice. A repair executor's `work_finished`, ordinary idle or an unrelated newer turn is insufficient.

Header/root/timestamps must match, and no new input may follow the native completion. Source files and the exact indexed thread row must remain unchanged during measurement. Missing files, partial tails, unsupported/removed bindings, STOP/questions and ambiguity yield unknown. No prompt text is copied into evidence. Healthy means the original interrupted execution resumed and completed natively, not that its semantic business deliverable passed QA.

Read-only local check (does not contact NoticePlace or write receipts):

```sh
python3 deploy/noticeplace/autostart_source_verifier.py \
  --autopilot-state /existing/herder/autopilot-live \
  --human-stop-store /existing/herder/human-stops.json \
  --codex-root /existing/codex \
  --host-id EXACT_EXISTING_HOST \
  --check-group /path/to/existing-authoritative-group.json
```

`run_tick()` or `--tick --verifier-state <dedicated-source-state>` is the supported one-shot SDK seam for the **existing owning cycle**, not a new timer. It uses the existing `NOTIFY_CENTER_EVENT_URL` and `NOTIFY_CENTER_TOKEN`; registration/grant is not created by this helper. One source check per call, bounded10s admission. Never invoke a live tick just to generate acceptance evidence.

## Integration boundary — not installed

The existing owner is `UnfinishedSessionLauncher`, `src/autopilot/unfinished-session-launcher.ts`. Its `notifyExhausted` emits this source through `createUnfinishedSessionNotifier` in `src/index.ts`; its existing reconcile/watchdog cycle is the future invocation seam. The current NoticeplaceHealthObserver follows the **repair executor** and intentionally cannot supply source health.

At handoff, index/server/unfinished-session-launcher have foreign WIP; no hook was added and no shared build/runtime was changed. The source adapter and fixtures alone are not installed consumer coverage. The owner must also retain the exact source binding before the producer emits: normal completion removes the unfinished record (`store.remove`), so an absent historical binding cannot safely become healthy. Reuse the existing producer/episode receipt rather than inventing a failed turn or new scheduler. The adapter intentionally returns unknown when that binding is absent. The archived-session signal requires its own predicate and is not covered by this first adapter.

The HTTP session GET was deliberately not used: current supervisor `getSession` invokes `HumanStopStore.observe`, and may also list models. Source checks use direct documented native archive/state reads instead.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tests/test_autostart_source_verifier.py -v
```

Fixtures create only isolated temporary JSON/SQLite/native files. One fixture runs the official installed SDK with synthetic transport and proves pull→fresh native read→POST, followed by exact UNKNOWN fencing without a second POST. No real session is resumed or messaged. Initial RED is the explicit absent adapter on the old source; do not describe that import failure as a reproduced runtime defect.
