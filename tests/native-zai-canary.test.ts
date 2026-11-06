import { expect, it } from 'vitest';
import { runCanary } from '../scripts/native-zai-canary.mjs';

it('sends through Herder and the real ZAI driver in isolated Chrome', async () => {
  const result = await runCanary();
  expect(result.origin).toBe('https://chat.z.ai');
  expect(result.sent).toEqual({ ok: true });
  expect(result.submitted).toBe('fixture prompt');
  expect(result.requests.filter((path: string) => path === '/fixture/send')).toHaveLength(1);
  expect(result.sessions.some((session: {id: string}) => session.id.includes('11111111-1111-4111-8111-111111111111'))).toBe(true);
  expect(result.messages.map((m: {text: string}) => m.text)).toContain('fixture deterministic response');
  expect(result.requests).toContain('/api/v1/chats/11111111-1111-4111-8111-111111111111/messages/batch');
  expect(result.blocked).toContain('https://outside.invalid/probe');
}, 30000);
