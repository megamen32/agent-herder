# noticeplace-source-stuck-intent-silence

Description: The independent Agent Herder source verifier fell silent for good after one lost submission. The official SDK reconciles a pending submission only against an exact receipt, so a submission that never reached the notification center left the intent of the verifier in the state `submitting` and every later tick raised `VerificationPending` without answering anything. The server then expired the checks, re-armed the incident and delivered it to an executor again with the health of the source still unknown.
Evidence: `deploy/noticeplace/autostart_source_verifier.py --tick` on the live node raised `notification_center.consumer_lifecycle.VerificationPending: source check submission requires exact receipt reconciliation` (`/opt/noticeplace/notification_center/consumer_lifecycle.py:117`). The notification center had restarted at 2026-11-11 23:32:08 and the intent of the verifier was written at 23:32:09. The source answered nothing for more than eight minutes while 13 due checks waited; the deferred recovery incident was expired, re-armed (generation 4) and delivered again.
Cases:
- a submission lost while the notification center restarts > retires the intent and the source answers the whole due page again
- a submission the server still holds > keeps the fail-closed fence of the SDK and is never retired
Observed first errors:
- AssertionError: notification_center.consumer_lifecycle.VerificationPending: source check submission requires exact receipt reconciliation
Blocks: nothing further; the fix is merged and live. The incident of the deferred recovery stays open until the native turn resumes.
Status: fixed
History:
- 2026-11-11: Confirmed on the live node before any change. The defect was found while the incident `inc_e87153dfaf244831bd45a20a40b1d962` was delivered again with the health of the source unknown. The LhcPlan MCP was not available in this session, so the record is kept here.
- 2026-11-11: TDD. RED: `tests/test_autostart_source_verifier.py` failed with the live error above (1 failed, 17 passed). Fix: `retire_superseded_intent` retires a pending intent only when the server names a different request for that incident, so the proof that the submission is superseded is explicit. GREEN: 18 passed, `tests/autostart-source-integration.test.ts` 4 passed, `tsc --noEmit` clean.
- 2026-11-11: Live on release 68932ea2 (PR #63): the repaired tick answered the whole due queue in one tick (13 receipts in 1.6 s), the state of the verifier returned to `confirmed`, and the deferred recovery incident was answered with its deadline refreshed.
