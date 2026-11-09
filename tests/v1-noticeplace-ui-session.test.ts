import type { AgentSession, SessionMessageView } from '../src/types/index.js';
import { createV1NativeSessionRead, type V1NativeSessionReadPort, type V1NativeSessionReadProvider, type V1NativeSessionReadRequest } from '../src/automation/v1-noticeplace-ui-session.js';
import { type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createV1NoticePlaceServer, type V1NoticePlaceServerOptions } from '../src/v1-noticeplace-server.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
const nativeId = 'ses_unregistered_active';
const details = {
  session: { id: nativeId, harness: 'opencode', status: 'running' },
  lineage: { kind: 'unknown' }, children: [],
  messages: [{ id: 'message-1', role: 'assistant', text: 'Visible native result', parts: [{ type: 'text', text: 'Visible native result' }] }],
  history: { source: 'live-cache', complete: false },
  coverage: { complete: false, source: 'opencode-native-api' },
};
async function serve(nativePort?: V1NativeSessionReadPort) {
  const effect = vi.fn(async () => { throw new Error('Unexpected control effect'); });
  const nativeRead = vi.fn(async (input: V1NativeSessionReadRequest) => nativePort ? nativePort.read(input) : ({ status: 200, body: details }));
  const coreRead = vi.fn(effect);
  const identity = { toCoreRef: vi.fn(async () => null), toNativeId: vi.fn(async () => null) };
  const server = createV1NoticePlaceServer({
    policyStore: {}, attempts: {}, runner: { run: effect }, ownerState: { read: effect },
    resume: { call: effect, deliveryMode: 'queue' }, identity,
    sessionRead: { read: coreRead }, nativeSessionRead: { read: nativeRead },
  } as unknown as V1NoticePlaceServerOptions);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { url: `http://127.0.0.1:${address.port}`, nativeRead, coreRead, identity, effect };
}

describe('V1 native session click routes', () => {
  it.each(['codex', 'chatgpt', 'zai', 'zcode'])('routes an authorized %s UI read through the scoped read port', async harness => {
    const fixture = await serve();
    const response = await fetch(`${fixture.url}/api/sessions/${harness}/${nativeId}/details?limit=50&runtimeHostId=host-100`);
    expect(response.status).toBe(200);
    expect(fixture.nativeRead).toHaveBeenCalledWith({ harness, nativeId, kind: 'details', limit: 50, hostId: 'host-100' });
    expect(fixture.coreRead).not.toHaveBeenCalled();
    expect(fixture.identity.toCoreRef).not.toHaveBeenCalled();
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it.each([['limit=12&quick=1', 12], ['limit=50', 50]] as const)('serves the actual UI details loader query %s without adopting native identity', async (query, limit) => {
    const fixture = await serve();
    const response = await fetch(`${fixture.url}/api/sessions/opencode/${nativeId}/details?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(details);
    expect(fixture.nativeRead).toHaveBeenCalledWith({ harness: 'opencode', nativeId, kind: 'details', limit });
    expect(fixture.coreRead).not.toHaveBeenCalled();
    expect(fixture.identity.toCoreRef).not.toHaveBeenCalled();
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it('uses a native fallback for unregistered progress while retaining the established query', async () => {
    const fixture = await serve();
    const response = await fetch(`${fixture.url}/api/sessions/opencode/${nativeId}/progress?limit=5&history=auto`);
    expect(response.status).toBe(200);
    expect(fixture.nativeRead).toHaveBeenCalledWith({ harness: 'opencode', nativeId, kind: 'progress', limit: 5 });
    expect(fixture.coreRead).not.toHaveBeenCalled();
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it('does not pass an unknown core reference to a native adapter', async () => {
    const fixture = await serve();
    const response = await fetch(`${fixture.url}/api/sessions/opencode/session%3Aunknown/details?limit=50`);
    expect(response.status).toBe(404);
    expect(fixture.nativeRead).not.toHaveBeenCalled();
    expect(fixture.effect).not.toHaveBeenCalled();
  });
});

describe('V1 exact native session reader', () => {
  const now = new Date().toISOString();
  const session: AgentSession = { id: nativeId, harness: 'opencode', status: 'running', title: 'Native work',
    cwd: '/project', hostId: 'host-100', lastActivity: now, needsPermission: false };
  const message: SessionMessageView = { id: 'native-message', role: 'assistant', text: 'Visible native result',
    parts: [{ type: 'text', text: 'Visible native result' }] };
  function fixture() {
    const adapter = { getSession: vi.fn(async (): Promise<AgentSession | null> => session),
      getSessionMessages: vi.fn(async (): Promise<SessionMessageView[] | null> => [message]),
      listChildren: vi.fn(async (): Promise<AgentSession[]> => []),
    };
    const provider: V1NativeSessionReadProvider = { instanceRef: 'opencode-100', harness: 'opencode',
      hostId: 'host-100', source: 'opencode-native-api', adapter };
    return { adapter, provider, reader: createV1NativeSessionRead([provider]) };
  }
  const input = { harness: 'opencode', nativeId, kind: 'details' as const, limit: 12 };

  it('serves both real click requests through native metadata/history and preserves exact native identity', async () => {
    const source = fixture();
    const http = await serve(source.reader);
    for (const [query, limit] of [['limit=12&quick=1', 12], ['limit=50', 50]] as const) {
      const response = await fetch(`${http.url}/api/sessions/opencode/${nativeId}/details?${query}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ session, messages: [message], children: [], history: { complete: false },
        nativeSessionId: nativeId, coverage: { instanceRef: 'opencode-100', source: 'opencode-native-api',
          complete: false, sections: { session: 'observed', messages: 'bounded', children: 'observed' } } });
      expect(source.adapter.getSessionMessages).toHaveBeenLastCalledWith(nativeId, limit);
    }
    expect(http.identity.toCoreRef).not.toHaveBeenCalled();
    expect(http.effect).not.toHaveBeenCalled();
    expect(http.coreRead).not.toHaveBeenCalled();
  });

  it('uses the existing progress builder over the native message tail', async () => {
    const { reader } = fixture();
    const result = await reader.read({ ...input, kind: 'progress', limit: 5 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ session: { id: nativeId, status: 'running' }, activity: { hasMessageActivity: true }, fingerprint: expect.any(String), nativeSessionId: nativeId });
  });

  it.each([{ id: 'other-native' }, { hostId: 'host-44' }, { harness: 'codex' }])('refuses metadata from another native binding %j', async override => {
    const { reader, adapter } = fixture();
    adapter.getSession.mockResolvedValue({ ...session, ...override } as AgentSession);
    const result = await reader.read(input);
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('session');
    expect(adapter.getSessionMessages).not.toHaveBeenCalled();
    expect(adapter.listChildren).not.toHaveBeenCalled();
  });

  it('does not read messages for a native ID the configured instance cannot confirm', async () => {
    const { reader, adapter } = fixture();
    adapter.getSession.mockResolvedValue(null);
    expect((await reader.read(input)).status).toBe(404);
    expect(adapter.getSessionMessages).not.toHaveBeenCalled();
  });

  it('does not return empty successful history when native messages are unavailable', async () => {
    const { reader, adapter } = fixture();
    adapter.getSessionMessages.mockResolvedValue(null);
    const result = await reader.read(input);
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('messages');
    expect(result.body).toMatchObject({ error: 'native_history_unavailable', coverage: { complete: false } });
  });

  it('keeps child discovery uncertainty explicit while confirmed messages remain readable', async () => {
    const { reader, adapter } = fixture();
    adapter.listChildren.mockRejectedValue(new Error('private upstream detail'));
    const result = await reader.read(input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ messages: [message], coverage: { complete: false, sections: { children: 'unavailable' } } });
    expect(JSON.stringify(result.body)).not.toContain('private upstream detail');
  });

  it('bounds returned messages even when a provider ignores the requested limit', async () => {
    const { reader, adapter } = fixture();
    adapter.getSessionMessages.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({ ...message, id: 'message-' + index })));
    const result = await reader.read({ ...input, limit: 12 });
    expect(result.body.messages).toHaveLength(12);
    expect((result.body.messages as SessionMessageView[])[0]?.id).toBe('message-48');
    expect(result.body.history).toMatchObject({ complete: false });
  });

  it('fails closed on ambiguous configured instances and can select a specific host', async () => {
    const first = fixture(), second = fixture();
    second.provider = { ...second.provider, instanceRef: 'opencode-44', hostId: 'host-44' };
    const reader = createV1NativeSessionRead([first.provider, second.provider]);
    expect((await reader.read(input)).status).toBe(409);
    expect(first.adapter.getSession).not.toHaveBeenCalled();
    expect(second.adapter.getSession).not.toHaveBeenCalled();
    expect((await reader.read({ ...input, hostId: 'host-100' })).status).toBe(200);
    expect(second.adapter.getSession).not.toHaveBeenCalled();
  });

  it('never passes a core ref to native reads', async () => {
    const { reader, adapter } = fixture();
    expect((await reader.read({ ...input, nativeId: 'session:unregistered-core' })).status).toBe(400);
    expect(adapter.getSession).not.toHaveBeenCalled();
  });
});
