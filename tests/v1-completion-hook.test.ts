import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_ENDPOINT, reconcileCompletion } from '../scripts/v1-completion-hook.mjs';

const input = { session_id: 'native-child-1', turn_id: 'turn-7', cwd: '/work/child' };

async function fixture(run: (path: string, calls: unknown[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'herder-v1-hook-'));
  const path = join(dir, 'config.json');
  const tokenPath = join(dir, 'bearer');
  const config = { endpoint: MCP_ENDPOINT, bearer_file: tokenPath, children: [
    { session_id: input.session_id, cwd: input.cwd, child_ref: 'child-ref', rule_ref: 'rule-ref' },
  ] };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await writeFile(tokenPath, 'test-token\n', { mode: 0o600 });
  await chmod(path, 0o600); await chmod(tokenPath, 0o600);
  try { await run(path, []); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('v1 Codex completion hook', () => {
  it('uses MCP initialize/initialized, discovery and one mapped call with stable native-turn event ID', async () => {
    await fixture(async (configPath, calls) => {
      await reconcileCompletion(input, { configPath, fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const req = JSON.parse(String(init?.body));
        const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' } }
          : req.method === 'tools/list' ? { tools: [{ name: 'automation', inputSchema: { oneOf: [{ properties: { action: { const: 'reconcile' } } }] } }] }
            : {};
        const sse = req.method === 'tools/list';
        return new Response(req.method === 'notifications/initialized' ? null : sse
          ? `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n\n`
          : JSON.stringify({ jsonrpc: '2.0', id: req.id, result }),
          { status: req.method === 'notifications/initialized' ? 204 : 200,
            headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'session-fixture' } });
      } });
      expect(calls).toHaveLength(4);
      const requests = (calls as Array<{ url: string; init: RequestInit }>).map(({ url, init }, index) => {
        expect(url).toBe(MCP_ENDPOINT);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
        expect((init.headers as Record<string, string>).accept).toBe('application/json, text/event-stream');
        if (index > 0) expect((init.headers as Record<string, string>)['mcp-session-id']).toBe('session-fixture');
        return JSON.parse(String(init.body));
      });
      expect(requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      const call = calls[3] as { url: string; init: RequestInit };
      const request = requests[3];
      expect(request.params).toEqual({ name: 'automation', arguments: {
        action: 'reconcile', child_ref: 'child-ref', rule_ref: 'rule-ref',
        event_id: expect.any(String),
      } });
      expect(request.params.arguments.event_id).toBe(input.turn_id);
      const again = await readFile(configPath, 'utf8');
      expect(JSON.parse(again).children[0].child_ref).toBe('child-ref');
    });
  });

  it('fails closed for missing native identity, foreign cwd/session and ambiguous mapping', async () => {
    await fixture(async (configPath, calls) => {
      const fetchImpl = async (...args: unknown[]) => { calls.push(args); return new Response('{}'); };
      await reconcileCompletion({ ...input, turn_id: '' }, { configPath, fetchImpl });
      await reconcileCompletion({ ...input, session_id: 'other' }, { configPath, fetchImpl });
      await reconcileCompletion({ ...input, cwd: '/other' }, { configPath, fetchImpl });
      expect(calls).toHaveLength(0);
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.children.push(config.children[0]);
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await chmod(configPath, 0o600);
      await reconcileCompletion(input, { configPath, fetchImpl });
      expect(calls).toHaveLength(0);
    });
  });

  it('preserves the exact native turn ID in event_id without deriving a replacement', async () => {
    const exact = { ...input, turn_id: 'native-turn/exact:01' };
    await fixture(async (configPath, calls) => {
      await reconcileCompletion(exact, { configPath, fetchImpl: async (_url, init) => {
        const req = JSON.parse(String(init?.body)); calls.push(req);
        const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' } }
          : req.method === 'tools/list' ? { tools: [{ name: 'automation', inputSchema: { oneOf: [{ properties: { action: { const: 'reconcile' } } }] } }] }
            : {};
        return new Response(req.method === 'notifications/initialized' ? null : JSON.stringify({ jsonrpc: '2.0', id: req.id, result }),
          { status: req.method === 'notifications/initialized' ? 204 : 200,
            headers: { 'content-type': 'application/json' } });
      } });
      expect((calls[3] as { params: { arguments: { event_id: string } } }).params.arguments.event_id).toBe(exact.turn_id);
    });
  });

  it('never retries or logs/returns transport errors', async () => {
    await fixture(async (configPath, calls) => {
      await expect(reconcileCompletion(input, { configPath, fetchImpl: async () => {
        calls.push(1); throw new Error('Bearer should-not-leak');
      } })).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });
  });

  it('discovers absent reconcile support and does not send tools/call', async () => {
    await fixture(async (configPath, calls) => {
      await reconcileCompletion(input, { configPath, fetchImpl: async (_url, init) => {
        const req = JSON.parse(String(init?.body)); calls.push(req.method);
        const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' } }
          : req.method === 'tools/list' ? { tools: [{ name: 'automation', inputSchema: { oneOf: [{ properties: { action: { const: 'list' } } }] } }] }
            : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200,
          headers: { 'content-type': 'application/json' } });
      } });
      expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    });
  });

  it('rejects unprotected mapping and bearer files', async () => {
    await fixture(async (configPath, calls) => {
      await chmod(configPath, 0o644);
      await reconcileCompletion(input, { configPath, fetchImpl: async () => { calls.push(1); return new Response(); } });
      expect(calls).toHaveLength(0);
      await chmod(configPath, 0o600);
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      await chmod(config.bearer_file, 0o644);
      await reconcileCompletion(input, { configPath, fetchImpl: async () => { calls.push(1); return new Response(); } });
      expect(calls).toHaveLength(0);
    });
  });
});
