import { loadIncidentCallback } from '../autopilot/notice-incident.js';
import type { AutopilotHarness, AutopilotSessionStore } from '../autopilot/session-store.js';
import type { IncidentSessionRouterPorts } from './incident-session-router.js';
import { incidentRequestId, incidentSourceKey } from './incident-session-router.js';

type Document = { id: string; project: string; state: string; lifecycle?: {
  group_key?: string; group?: Record<string, unknown>; attempt_id?: string; session_id?: string; harness?: string;
  continuation?: Record<string, unknown>;
} };
const OPEN = ['open', 'acknowledged', 'snoozed'];

/** Production continuation gate: a closed latest card never substitutes for the group's source authority. */
export function noticeplaceGroupContinuationPorts(store: AutopilotSessionStore): Pick<IncidentSessionRouterPorts, 'boundIncidentOpen' | 'continuationReady'> {
  async function context(session: { harness: string; id: string }) {
    const record = await store.get(session.harness as AutopilotHarness, session.id);
    if (!record?.noticeIncident) return null;
    const callback = await loadIncidentCallback(record.noticeIncident.project);
    const read = async (id: string): Promise<Document> => {
      const response = await fetch(`${callback.url}/v1/incidents/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${callback.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Notice continuation read failed with HTTP ${response.status}`);
      const document = await response.json() as Document;
      if (document.id !== id || document.project !== record.noticeIncident!.project) throw new Error('Notice continuation identity mismatch');
      return document;
    };
    return { record, read, current: await read(record.noticeAttempt?.incidentId ?? record.noticeIncident.incidentId) };
  }
  return {
    boundIncidentOpen: async session => {
      const ctx = await context(session);
      return Boolean(ctx && OPEN.includes(ctx.current.state));
    },
    continuationReady: async (session, request) => {
      const ctx = await context(session);
      if (!ctx) return 'blocked';
      const { record, current, read } = ctx;
      const attempt = record.noticeAttempt;
      if (!attempt || !request) return 'blocked';
      if (current.lifecycle?.attempt_id !== attempt.attemptId || current.lifecycle?.session_id !== session.id
        || current.lifecycle?.harness !== session.harness) return 'blocked';
      const requestedId = incidentRequestId(request.message);
      if (!requestedId) return 'blocked';
      const incoming = requestedId === current.id ? current : await read(requestedId);
      const sameGroup = (a: Document, b: Document) => Boolean(a.lifecycle?.group_key && a.lifecycle.group_key === b.lifecycle?.group_key);
      const requestGroup = incidentSourceKey(request.message);
      const incomingGroup = incoming.lifecycle?.group && incidentSourceKey(JSON.stringify({ ...incoming.lifecycle.group, id: incoming.id, project: incoming.project }));
      if (!sameGroup(current, incoming) || !requestGroup || requestGroup !== incomingGroup) return 'blocked';
      const continuation = current.lifecycle?.continuation;
      if (!continuation) {
        // An ordinary new episode has never belonged to this finished attempt.
        return incoming.lifecycle?.attempt_id || incoming.lifecycle?.session_id ? 'blocked' : false;
      }
      const keys = ['incident_id', 'session_id', 'harness', 'attempt_id', 'request_id', 'generation'] as const;
      if (continuation.session_id !== session.id || continuation.harness !== session.harness
        || continuation.attempt_id !== attempt.attemptId || typeof continuation.incident_id !== 'string'
        || typeof continuation.request_id !== 'string' || !continuation.request_id
        || !Number.isInteger(continuation.generation)) return 'blocked';
      const origin = continuation.incident_id === current.id ? current : await read(continuation.incident_id);
      const authority = origin.lifecycle?.continuation;
      if (!OPEN.includes(origin.state) || !sameGroup(current, origin) || !authority
        || keys.some(key => authority[key] !== continuation[key])
        || origin.lifecycle?.attempt_id !== attempt.attemptId || origin.lifecycle?.session_id !== session.id
        || origin.lifecycle?.harness !== session.harness) return 'blocked';
      return true;
    },
  };
}
