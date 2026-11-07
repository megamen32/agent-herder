import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { handleIntegratorSessionTranscript } from '../src/integrator-session-route.js';
import type { HarnessAdapter } from '../src/types/index.js';

it('pages a complete ChatGPT conversation through the transcript route', async () => {
  const id = '6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
  const mapping = {
    a: { message: { id: 'a', author: { role: 'user' }, create_time: 1, content: { parts: ['question'] } }, parent: null, children: ['b'] },
    b: { message: { id: 'b', author: { role: 'assistant' }, create_time: 2, content: { parts: ['answer'] } }, parent: 'a', children: [] },
  };
  const adapter = { type: 'chatgpt', async getSession() { return { id, harness: 'chatgpt', status: 'idle' }; },
    async getRawTranscript() { return { complete: true, source: { kind: 'native-api', format: 'json' }, bytes: Buffer.from(JSON.stringify({ conversation_id: id, mapping })) }; },
  } as unknown as HarnessAdapter;
  const server = createServer((req, res) => { void handleIntegratorSessionTranscript(req, res, new URL(req.url!, 'http://localhost'), new Map([['chatgpt', adapter]])); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener');
  const base = `http://127.0.0.1:${address.port}/api/sessions/chatgpt/${id}/transcript?limit=1`;
  try {
    const response = await fetch(base); expect(response.status).toBe(200);
    const first = (await response.json() as any).transcript;
    expect(first.events[0]).toMatchObject({ eventId: 'a', text: 'question' });
    const next = await fetch(`${base}&cursor=${encodeURIComponent(first.nextCursor)}`); expect(next.status).toBe(200);
    expect((await next.json() as any).transcript).toMatchObject({ complete: true, events: [{ eventId: 'b', text: 'answer' }] });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('rejects a transcript from a different ChatGPT session', async () => {
  const { createChatgptTranscriptReader } = await import('../src/chatgpt-transcript-reader.js');
  const scope = { hostId: 'host', harness: 'chatgpt', nativeSessionId: 'chatgpt::expected' };
  const reader = createChatgptTranscriptReader({ scope, getRawTranscript: async () => ({ complete: true, source: { kind: 'native-api', format: 'json' }, bytes: Buffer.from(JSON.stringify({ conversation_id: 'other', mapping: {} })) }) });
  await expect(reader({ scope, cursor: null, limit: 2 })).rejects.toThrow(/session/i);
});

it('preserves alternate and non-text native messages in a frozen snapshot', async () => {
  const { createChatgptTranscriptReader } = await import('../src/chatgpt-transcript-reader.js');
  const scope = { hostId: 'host', harness: 'chatgpt', nativeSessionId: 'chatgpt::abc' };
  const data = { conversation_id: 'abc', mapping: {
    a: { message: { id: 'a', author: { role: 'user' }, create_time: 1, content: { parts: ['first'] } } },
    b: { message: { id: 'b', author: { role: 'assistant' }, create_time: 2, content: { parts: [{ asset_pointer: 'file' }] } } },
    c: { message: { id: 'c', author: { role: 'assistant' }, create_time: 3, content: { parts: ['alternate'] } } },
  } };
  const reader = createChatgptTranscriptReader({ scope, getRawTranscript: async () => ({ complete: true, source: { kind: 'native-api', format: 'json' }, bytes: Buffer.from(JSON.stringify(data)) }) });
  const first = await reader({ scope, cursor: null, limit: 1 });
  const second = await reader({ scope, cursor: first.nextCursor, limit: 1 });
  expect(second.events[0]).toMatchObject({ eventId: 'b', payload: { message: { content: { parts: [{ asset_pointer: 'file' }] } } } });
  const third = await reader({ scope, cursor: second.nextCursor, limit: 1 });
  expect(third.events[0]).toMatchObject({ eventId: 'c', text: 'alternate' });
  data.mapping.b.message.content.parts[0].asset_pointer = 'changed';
  expect((await reader({ scope, cursor: first.nextCursor, limit: 1 })).events[0]).toMatchObject({ payload: { message: { content: { parts: [{ asset_pointer: 'file' }] } } } });
});

it('keeps an existing cursor usable when another consumer starts reading', async () => {
  const { createChatgptTranscriptReader } = await import('../src/chatgpt-transcript-reader.js');
  const scope = { hostId: 'host', harness: 'chatgpt', nativeSessionId: 'abc' };
  const mapping = Object.fromEntries(['a', 'b'].map(id => [id, { message: { id, author: { role: 'user' }, content: { parts: [id] } } }]));
  const reader = createChatgptTranscriptReader({ scope, getRawTranscript: async () => ({ complete: true, source: { kind: 'native-api', format: 'json' }, bytes: Buffer.from(JSON.stringify({ conversation_id: 'abc', mapping })) }) });
  const first = await reader({ scope, cursor: null, limit: 1 });
  await reader({ scope, cursor: null, limit: 1 });
  expect((await reader({ scope, cursor: first.nextCursor, limit: 1 })).events[0].eventId).toBe('b');
});
