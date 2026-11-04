import { describe, expect, it } from 'vitest';
import { groupSessionMessages, joinAssistantTurnMessages } from '../src/web-ui/message-groups.js';
import { normalizeSessionMessages } from '../src/web-ui/session-message-normalize.js';

describe('session messages from history readers', () => {
  it('preserves text-only messages and existing structured parts for rendering', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, turnId: 'turn', text: 'hello' },
      { id: '2', role: 'assistant' as const, turnId: 'turn', text: '', parts: [{ type: 'text' as const, text: 'answer' }] },
    ];
    const groups = groupSessionMessages(normalizeSessionMessages(messages));
    const joined = joinAssistantTurnMessages(groups[0].messages);
    expect(joined[0].parts).toEqual([{ type: 'text', text: 'hello' }, { type: 'text', text: 'answer' }]);
  });
});
