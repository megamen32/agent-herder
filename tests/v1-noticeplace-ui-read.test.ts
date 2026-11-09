import { type Server } from 'node:http';
import type { AgentSession } from '../src/types/index.js';
import { createV1NativeUiRead, type V1UiReadPath } from '../src/automation/v1-noticeplace-ui-read.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createV1NoticePlaceServer, type V1NoticePlaceServerOptions } from '../src/v1-noticeplace-server.js';
import { parseActiveActivity, mergeActiveActivity } from '../src/web-ui/active-activity.js';

const nativeId = 'ses_native_unregistered_busy';
const observedAt = new Date().toISOString();
const session: AgentSession = { id: nativeId, harness: 'opencode', title: 'Native work', cwd: '/project', hostId: 'host-100', status: 'running', lastActivity: observedAt, needsPermission: false };
const active = { id: nativeId, harness: 'opencode', title: 'Native work', runtimeHostId: 'host-100', status: 'running', activity: { state: 'active', observedAt, evidence: 'opencode-native-active-status', expiresAt: new Date(Date.now() + 30_000).toISOString() }, workspaces: [{ hostId: 'host-100', absolutePath: '/project' }] };
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function serve(read?: (path: string, query: URLSearchParams) => Promise<{ status: number; body: unknown }>) {
  const mutating = vi.fn(async () => { throw new Error('Unexpected control/native effect'); });
  const identity = { toCoreRef: vi.fn(async () => null), toNativeId: vi.fn(async () => null) };
  const server = createV1NoticePlaceServer({
    policyStore: {}, attempts: {}, runner: { run: mutating }, ownerState: { read: mutating },
    identity, resume: { call: mutating, deliveryMode: 'queue' },
    ...(read ? { uiRead: { read } } : {}),
  } as unknown as V1NoticePlaceServerOptions);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { url: `http://127.0.0.1:${address.port}`, identity, mutating };
}

describe('V1 public UI read contract', () => {
  it('serves native session inventory without requiring a core registration', async () => {
    const read = vi.fn(async (_path: string, _query: URLSearchParams) => ({ status: 200, body: { sessions: [session], total: 1, limit: 25, truncated: false, warming: false, coverage: { scope: 'noticeplace-runtime', complete: false } } }));
    const fixture = await serve(read);
    const response = await fetch(fixture.url + '/api/sessions?harness=opencode&status=running&limit=25&quick=1');
    expect(response.status).toBe(200);
    expect((await response.json()).sessions[0]).toMatchObject({ id: nativeId, status: 'running' });
    expect(read).toHaveBeenCalledWith('/api/sessions', expect.any(URLSearchParams));
    expect(read.mock.calls[0]?.[1].get('status')).toBe('running');
    expect(fixture.identity.toCoreRef).not.toHaveBeenCalled();
    expect(fixture.mutating).not.toHaveBeenCalled();
  });

  it('makes an unregistered native running session visible through the real UI activity merge', async () => {
    const uiRead = createV1NativeUiRead({ providers: [{
      instanceRef: 'opencode-100', harness: 'opencode', hostId: 'host-100', source: 'opencode-native-api',
      adapter: {
        listSessions: async () => [],
        listActiveSessions: async () => [{ ...session, meta: {
          activityEvidence: active.activity.evidence, activityObservedAt: observedAt,
          activityExpiresAt: active.activity.expiresAt,
        } }],
        getActiveSessionSnapshotReceipt: () => ({ exhaustive: true, observedAt }),
      },
    }] });
    const fixture = await serve((path, query) => uiRead.read(path as V1UiReadPath, query));
    const inventory = await fetch(fixture.url + '/api/sessions?status=running');
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).sessions).toMatchObject([{ id: nativeId, status: 'running' }]);
    const response = await fetch(fixture.url + '/api/sessions/active?limit=25');
    expect(response.status).toBe(200);
    const snapshot = parseActiveActivity(await response.json());
    expect(snapshot.confirmed).toHaveLength(1);
    const visible = mergeActiveActivity([], snapshot.confirmed, { hostId: 'host-100' });
    expect(visible).toEqual(expect.arrayContaining([expect.objectContaining({ id: nativeId, harness: 'opencode', status: 'running' })]));
    expect(visible.some(row => row.id.startsWith('session:'))).toBe(false);
    expect(fixture.identity.toCoreRef).not.toHaveBeenCalled();
    expect(fixture.mutating).not.toHaveBeenCalled();
  });

  it.each(['/api/sessions', '/api/sessions/active', '/api/autopilot/choices', '/api/autopilot/overview', '/api/jobs'])('reports an unavailable read model explicitly for %s', async path => {
    const fixture = await serve();
    const response = await fetch(fixture.url + path);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: expect.any(String), coverage: { complete: false } });
    expect(body.sessions).toBeUndefined();
    expect(body.choices).toBeUndefined();
    expect(body.jobs).toBeUndefined();
    expect(fixture.mutating).not.toHaveBeenCalled();
  });
});
