import { loadIncidentCallback } from '../autopilot/notice-incident.js';
import { AutopilotSessionStore, type AutopilotHarness } from '../autopilot/session-store.js';

/** Read the source-of-truth receipt, never infer completion from native idle/stopped. */
export function noticeplaceAttemptOutcome(store: AutopilotSessionStore | undefined) {
  return async (harness: string, sessionId: string): Promise<'work_finished' | null> => {
    if (!store) return null;
    const record = await store.get(harness as AutopilotHarness, sessionId);
    if (!record?.noticeIncident || !record.noticeAttempt) return null;
    const attempt = record.noticeAttempt;
    const callback = await loadIncidentCallback(record.noticeIncident.project);
    const response = await fetch(`${callback.url}/v1/incidents/${encodeURIComponent(attempt.incidentId)}`, {
      headers: { authorization: `Bearer ${callback.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const document = await response.json() as { id?: string; project?: string; lifecycle?: Record<string, unknown> };
    const lifecycle = document.lifecycle;
    if (document.id !== attempt.incidentId || document.project !== record.noticeIncident.project
      || lifecycle?.attempt_state !== 'work_finished' || lifecycle.attempt_id !== attempt.attemptId
      || lifecycle.session_id !== sessionId || lifecycle.harness !== harness) return null;
    return await store.finishNoticeAttempt(harness as AutopilotHarness, sessionId, attempt) ? 'work_finished' : null;
  };
}
