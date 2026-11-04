import type { SessionMessageView } from '../types/index.js';

/** History adapters may return text-only messages without structured parts. */
export function normalizeSessionMessages(messages: readonly (Omit<SessionMessageView, 'parts'> & { parts?: SessionMessageView['parts'] })[]): SessionMessageView[] {
  return messages.map(message => ({ ...message, parts: Array.isArray(message.parts) ? message.parts : [] }));
}
