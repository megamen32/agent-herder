import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { zaiFullConversationScript } from '../src/adapters/zai-full-conversation.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
async function run(missing = false) {
  const ids = Array.from({ length: 181 }, (_, i) => `m${i}`);
  const messages = Object.fromEntries(ids.map((key, i) => [key, { id: key, role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'a'.repeat(15001) : key }]));
  const calls: string[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    calls.push(url);
    if (!init?.body) return { ok: true, json: async () => ({ id, chat: { history: { messages } } }) };
    const requested: string[] = JSON.parse(init.body).ids;
    return { ok: true, json: async () => ({ chat_id: id, data: Object.fromEntries(requested.filter(key => !missing || key !== 'm0').map(key => [key, messages[key]])) }) };
  };
  const result = await runInNewContext(`(${zaiFullConversationScript(id)})()`, { location: { origin: 'https://chat.z.ai' }, fetch, JSON, Object, Array, encodeURIComponent });
  return { result, calls };
}

it('exports all native Z.ai messages without tail or content truncation', async () => {
  const { result, calls } = await run();
  expect(result.data.conversation_id).toBe(id);
  expect(Object.keys(result.data.messages)).toHaveLength(181);
  expect(result.data.messages.m0.content).toHaveLength(15001);
  expect(calls.filter(path => path.endsWith('/messages/batch'))).toHaveLength(4);
});

it('rejects a batch that silently omits a requested message', async () => {
  const { result } = await run(true);
  expect(result.error).toBe('batch_incomplete');
  expect(result.data).toBeUndefined();
});

it('exports and pages a complete Z.ai session through the regular adapter and HTTP route', async () => {
  const { createServer } = await import('node:http');
  const { BrowserChatAdapter } = await import('../src/adapters/browser-chat.js');
  const { handleIntegratorSessionTranscript } = await import('../src/integrator-session-route.js');
  const driver: any = { listChats: async () => [{ id: 'route:' + id, title: 'fixture', unread: false, working: false, updatedAt: new Date(0).toISOString() }],
    sendMessage: async () => ({}), getRawConversation: async () => ({ conversation_id: id, messages: {
      a: { id: 'a', role: 'user', content: 'question' }, b: { id: 'b', role: 'assistant', content: 'answer' },
    } }) };
  const adapter = new BrowserChatAdapter(driver, { id: 'zai', name: 'Z.ai', harness: 'zai', cwd: '/tmp/zai' });
  await adapter.listSessions();
  const sessionId = 'route:' + id;
  const raw = await adapter.getRawTranscript(sessionId);
  expect(raw?.source.location).toContain('chat.z.ai');
  const server = createServer((req, res) => { void handleIntegratorSessionTranscript(req, res, new URL(req.url!, 'http://localhost'), new Map([['zai', adapter]])); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no listener');
  const base = `http://127.0.0.1:${address.port}/api/sessions/zai/${encodeURIComponent(sessionId)}/transcript?limit=1`;
  try {
    const response = await fetch(base); expect(response.status).toBe(200);
    const first = (await response.json() as any).transcript;
    expect(first.events[0]).toMatchObject({ eventId: 'a', text: 'question' });
    const second = await fetch(`${base}&cursor=${encodeURIComponent(first.nextCursor)}`); expect(second.status).toBe(200);
    expect((await second.json() as any).transcript).toMatchObject({ complete: true, events: [{ eventId: 'b', text: 'answer' }] });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('retrieves the complete export through the real Z.ai driver in verified chunks', async () => {
  const { createContext, runInContext } = await import('node:vm');
  const { ZaiCdpDriver } = await import('../src/adapters/zai-cdp-driver.js');
  const message = { id: 'a', role: 'user', content: 'x'.repeat(70000) };
  const fetch = async (_url: string, init?: { body?: string }) => ({ ok: true, json: async () => init?.body
    ? { chat_id: id, data: { a: message } } : { id, chat: { history: { messages: { a: {} } } } } });
  const context = createContext({ location: { origin: 'https://chat.z.ai' }, fetch, JSON, Object, Array, Date, encodeURIComponent });
  let chunks = 0;
  const tools: any = { call: async (name: string, args: any) => {
    if (name === 'list_pages') return '1: Z.ai (https://chat.z.ai/)';
    if (String(args.function).includes('entry.text.slice')) chunks++;
    return '```json\n' + JSON.stringify(await runInContext('(' + args.function + ')()', context)) + '\n```';
  } };
  const data: any = await new ZaiCdpDriver(tools).getRawConversation('route:' + id);
  expect(data.messages.a.content).toHaveLength(70000);
  expect(chunks).toBeGreaterThan(1);
  expect(runInContext('Object.keys(globalThis.__herderFullConversationTransfers).length', context)).toBe(0);
});
