import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { chatgptPassiveHistoryScript } from '../src/adapters/chatgpt-passive-history.js';

it('counts one page request burst as one backoff episode, and backs off a later retry', async () => {
  let now = 1_000_000;
  let retryAfter: string | null = null;
  const context: any = {
    location: { origin: 'https://chatgpt.com', pathname: '/' }, URL,
    Date: { now: () => now, parse: Date.parse },
    window: { fetch: async () => ({ status: 429, ok: false, headers: { get: () => retryAfter } }) },
  };
  runInNewContext('(' + chatgptPassiveHistoryScript() + ')()', context);
  await Promise.all(Array.from({ length: 10 }, () => context.window.fetch('/backend-api/conversations')));
  expect(context.__herderPassive429Strikes).toBe(1);
  expect(context.__herderPassiveCooldownUntil).toBe(now + 300_000);
  const episode = context.__herderPassiveLast429;
  retryAfter = '900';
  await context.window.fetch('/backend-api/conversations');
  expect(context.__herderPassiveLast429).toBe(episode);
  expect(context.__herderPassiveCooldownUntil).toBe(now + 900_000);
  now += 900_000;
  retryAfter = null;
  await context.window.fetch('/backend-api/conversations');
  expect(context.__herderPassive429Strikes).toBe(2);
  expect(context.__herderPassiveCooldownUntil).toBe(now + 600_000);
});
