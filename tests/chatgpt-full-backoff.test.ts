import { expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { chatgptFullConversationApiScript } from '../src/adapters/chatgpt-full-conversation.js';
const id = '6aa7e444-0ba4-83ed-992f-d2afaa3159e8';

it('respects passive browser cooldown before requesting full history', async () => {
  let calls = 0;
  const context = createContext({ location: { origin: 'https://chatgpt.com' }, __herderPassiveCooldownUntil: Date.now() + 300000,
    fetch: async () => { calls++; throw Error('must not fetch'); }, Date, JSON, encodeURIComponent });
  const result = await runInContext('(' + chatgptFullConversationApiScript(id) + ')()', context);
  expect(result.error).toBe('read_cooldown'); expect(calls).toBe(0);
});

it('honors Retry-After from full history 429 and blocks the next request', async () => {
  let calls = 0;
  const context = createContext({ location: { origin: 'https://chatgpt.com' }, Date, JSON, encodeURIComponent,
    fetch: async (url: string) => { calls++; return url === '/api/auth/session' ? { ok: true, json: async () => ({ accessToken: 'fixture' }) }
      : { ok: false, status: 429, headers: { get: () => '600' } }; } });
  const run = () => runInContext('(' + chatgptFullConversationApiScript(id) + ')()', context);
  expect((await run()).error).toBe('history_http_429');
  expect(runInContext('__herderChatGptReadCooldownUntil', context)).toBeGreaterThanOrEqual(Date.now() + 599000);
  expect((await run()).error).toBe('read_cooldown'); expect(calls).toBe(2);
});
