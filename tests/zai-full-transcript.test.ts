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

it('exports a Z.ai virtual session through the regular transcript tool', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { BrowserChatAdapter } = await import('../src/adapters/browser-chat.js');
  const { TranscriptArchive } = await import('../src/transcript-archive.js');
  const { handleExportTranscript } = await import('../src/mcp-tools/handlers.js');
  const root = await mkdtemp(join(tmpdir(), 'herder-zai-export-'));
  try {
    const driver: any = { listChats: async () => [{ id: 'route:' + id, title: 'fixture', unread: false, working: false, updatedAt: new Date(0).toISOString() }], sendMessage: async () => ({}), getRawConversation: async () => ({ conversation_id: id, messages: { a: { id: 'a', role: 'user', content: 'question' } } }) };
    const adapter = new BrowserChatAdapter(driver, { id: 'zai', name: 'Z.ai', harness: 'zai', cwd: '/virtual/zai' });
    await adapter.listSessions();
    const result = await handleExportTranscript(new Map([['zai', adapter]]), { sessionId: 'route:' + id, harness: 'zai' }, new TranscriptArchive({ workspaceRoot: root }));
    expect(result).toContain('Transcript exported: ');
    const path = result.split('\n')[0]!.replace('Transcript exported: ', '');
    expect(JSON.parse(await readFile(path, 'utf8')).messages.a.content).toBe('question');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('pages an admitted Z.ai draft using its verified native export identity', async () => {
  const { createZaiTranscriptReader } = await import('../src/zai-transcript-reader.js');
  const scope = { hostId: 'host', harness: 'zai', nativeSessionId: 'zai::draft%3Afixture' };
  const reader = createZaiTranscriptReader({ scope, getRawTranscript: async () => ({ complete: true, source: { kind: 'native-api', format: 'json', location: 'https://chat.z.ai/c/' + id }, bytes: Buffer.from(JSON.stringify({ conversation_id: id, messages: { a: { id: 'a', role: 'user', content: 'question' } } })) }) });
  expect((await reader({ scope, cursor: null, limit: 10 })).events[0]).toMatchObject({ eventId: 'a', text: 'question' });
});

it('transfers large Z.ai history with bounded parallel chunks in order', async () => {
  const { createContext, runInContext } = await import('node:vm');
  const { ZaiCdpDriver } = await import('../src/adapters/zai-cdp-driver.js');
  const content = 'abcdefghij'.repeat(30000);
  const message = { id: 'a', role: 'user', content };
  const fetch = async (_url: string, init?: { body?: string }) => ({ ok: true, json: async () => init?.body
    ? { chat_id: id, data: { a: message } } : { id, chat: { history: { messages: { a: {} } } } } });
  const context = createContext({ location: { origin: 'https://chat.z.ai' }, fetch, JSON, Object, Array, Date, encodeURIComponent });
  let running = 0, peak = 0;
  const tools: any = { call: async (name: string, args: any) => {
    if (name === 'list_pages') return '1: Z.ai (https://chat.z.ai/)';
    const chunk = String(args.function).includes('entry.text.slice');
    if (chunk) { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 5)); }
    try { return '```json\n' + JSON.stringify(await runInContext('(' + args.function + ')()', context)) + '\n```'; }
    finally { if (chunk) running--; }
  } };
  const data: any = await new ZaiCdpDriver(tools).getRawConversation('route:' + id);
  expect(data.messages.a.content).toBe(content);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(runInContext('Object.keys(globalThis.__herderFullConversationTransfers).length', context)).toBe(0);
});

it('waits for in-flight chunks before cleaning up a failed transfer', async () => {
  const { createContext, runInContext } = await import('node:vm');
  const { ZaiCdpDriver } = await import('../src/adapters/zai-cdp-driver.js');
  const message = { id: 'a', role: 'user', content: 'x'.repeat(220000) };
  const fetch = async (_url: string, init?: { body?: string }) => ({ ok: true, json: async () => init?.body
    ? { chat_id: id, data: { a: message } } : { id, chat: { history: { messages: { a: {} } } } } });
  const context = createContext({ location: { origin: 'https://chat.z.ai' }, fetch, JSON, Object, Array, Date, encodeURIComponent });
  let active = 0, cleanedWhileActive = false, chunks = 0;
  const tools: any = { call: async (name: string, args: any) => {
    if (name === 'list_pages') return '1: Z.ai (https://chat.z.ai/)';
    const fn = String(args.function);
    if (fn.includes('delete globalThis.__herderFullConversationTransfers')) cleanedWhileActive ||= active > 0;
    if (fn.includes('entry.text.slice')) {
      const index = chunks++; active++;
      try { await new Promise(resolve => setTimeout(resolve, index === 0 ? 1 : 15));
        if (index === 0) return '```json\n' + JSON.stringify({ error: 'broken_chunk' }) + '\n```';
        return '```json\n' + JSON.stringify(await runInContext('(' + fn + ')()', context)) + '\n```';
      } finally { active--; }
    }
    return '```json\n' + JSON.stringify(await runInContext('(' + fn + ')()', context)) + '\n```';
  } };
  await expect(new ZaiCdpDriver(tools).getRawConversation('route:' + id)).rejects.toThrow(/incomplete/);
  expect(cleanedWhileActive).toBe(false);
  expect(active).toBe(0);
});
