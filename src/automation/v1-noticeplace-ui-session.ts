import type { AgentSession, SessionDetails, SessionMessageView } from '../types/index.js';
import { buildSessionProgress } from '../health-progress.js';
import type { V1UiReadResult } from './v1-noticeplace-ui-read.js';

export type V1NativeSessionReadRequest = {
  harness: string; nativeId: string; kind: 'details' | 'progress'; limit: number; hostId?: string;
};
export interface V1NativeSessionReadPort {
  read(input: V1NativeSessionReadRequest): Promise<V1UiReadResult>;
}
export type V1NativeSessionReadProvider = {
  instanceRef: string; harness: string; hostId: string; source: string;
  adapter: {
    getSession(id: string): Promise<AgentSession | null>;
    getSessionMessages(id: string, limit?: number): Promise<SessionMessageView[] | null>;
    listChildren?(id: string): Promise<AgentSession[]>;
  };
};

/** A bounded native reader. It never adopts a session or calls its control operations. */
export function createV1NativeSessionRead(providers: V1NativeSessionReadProvider[], registered?: V1NativeSessionReadPort): V1NativeSessionReadPort {
  return { async read(input) {
    const observedAt = new Date().toISOString();
    const source = { scope: 'native-session', complete: false, observedAt };
    const failure = (status: number, reason: string, extra: Record<string, unknown> = {}): V1UiReadResult => ({
      status, body: { error: reason, coverage: { ...source, ...extra } },
    });
    if (!input.nativeId || input.nativeId.startsWith('session:') || input.nativeId.length > 512
      || /[\/\r\n\0]/u.test(input.nativeId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      return failure(400, 'invalid_native_session_read');
    }
    const matches = providers.filter(provider => provider.harness === input.harness && (!input.hostId || provider.hostId === input.hostId));
    if (!matches.length) return registered ? registered.read(input) : failure(503, 'native_session_provider_unavailable');
    if (matches.length !== 1) return registered ? registered.read(input) : failure(409, 'native_session_provider_ambiguous');
    const provider = matches[0]!;
    const receipt = { instanceRef: provider.instanceRef, harness: provider.harness, hostId: provider.hostId, source: provider.source };
    function bound(session: AgentSession): boolean {
      return Boolean(session && session.id && !session.id.startsWith('session:')
        && session.harness === provider.harness && session.hostId === provider.hostId);
    }
    try {
      const session = await provider.adapter.getSession(input.nativeId);
      if (!session) return failure(404, 'native_session_not_found', receipt);
      if (!bound(session) || session.id !== input.nativeId) return failure(503, 'native_session_binding_mismatch', receipt);
      const [messagesRead, childrenRead] = await Promise.allSettled([
        provider.adapter.getSessionMessages(input.nativeId, input.limit),
        provider.adapter.listChildren ? provider.adapter.listChildren(input.nativeId) : Promise.resolve(undefined),
      ]);
      if (messagesRead.status !== 'fulfilled' || !Array.isArray(messagesRead.value)) return failure(503, 'native_history_unavailable', receipt);
      const messages = messagesRead.value.slice(-input.limit);
      if (messages.some(message => !message || typeof message.id !== 'string' || !message.id
        || !['user', 'assistant', 'tool', 'system'].includes(message.role) || !Array.isArray(message.parts))) {
        return failure(503, 'native_history_invalid', receipt);
      }
      const childrenAvailable = childrenRead.status === 'fulfilled' && Array.isArray(childrenRead.value) && childrenRead.value.every(bound);
      const children = childrenAvailable && childrenRead.status === 'fulfilled' ? childrenRead.value! : [];
      const warning = 'Bounded native message tail; full transcript completeness is not claimed.'
        + (childrenAvailable ? '' : ' Child-session discovery is unavailable.');
      const details: SessionDetails = {
        session, lineage: { kind: 'unknown' }, children, messages,
        history: { source: 'live-cache', complete: false, warning },
      };
      const coverage = { ...source, ...receipt, reason: 'native_bounded_history',
        sections: { session: 'observed', messages: 'bounded', children: childrenAvailable ? 'observed' : 'unavailable', lineage: 'unknown' } };
      return { status: 200, body: {
        ...(input.kind === 'progress' ? buildSessionProgress(details, input.limit) : details),
        nativeSessionId: input.nativeId, coverage,
      } };
    } catch { return failure(503, 'native_session_read_failed', receipt); }
  } };
}
