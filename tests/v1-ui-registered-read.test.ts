import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../src/types/index.js';
import { createV1RegisteredUiRead, V1_UI_EXPECTED_HARNESSES, type V1CoreUiReadPort } from '../src/automation/v1-ui-registered-read.js';
import { createV1NativeUiRead, type V1NativeReadProvider } from '../src/automation/v1-noticeplace-ui-read.js';
import { createV1NativeSessionRead } from '../src/automation/v1-noticeplace-ui-session.js';

const now = new Date().toISOString();
function owner(harness: string, host = 'host-100', suffix = '100') {
  return { instance_ref: `${harness}-${suffix}`, node_ref: host, harness };
}
function row(instance: ReturnType<typeof owner>, id = `${instance.harness}-native-${instance.instance_ref}`) {
  return { session_ref: `session:${instance.instance_ref}:${id}`,
    address: { instance: { instance_id: instance.instance_ref, node: instance.node_ref }, native_session_id: id },
    native: { id, harness: instance.harness, hostId: instance.node_ref, status: 'running', title: 'Native registered work',
      cwd: '/project', needsPermission: false, lastActivity: now }, human_stop: { held: false }, source: 'registered_and_native' };
}
function fixture(initial = V1_UI_EXPECTED_HARNESSES.map(harness => owner(harness))) {
  const state = { owners: initial, rows: new Map(initial.map(instance => [instance.instance_ref, [row(instance)]])),
    failed: new Set<string>(), discoveryError: false, history: undefined as Record<string, unknown> | undefined };
  const call = vi.fn(async (tool: 'discover' | 'sessions' | 'session', args: Record<string, unknown>) => {
    if (tool === 'discover' && args.action === 'instances') {
      if (state.discoveryError) throw new Error('private discovery failure');
      return { scope: 'configured_owner_instances', complete: true, instances: state.owners };
    }
    if (tool === 'sessions' && args.action === 'list') {
      if (state.failed.has(String(args.instance_ref))) throw new Error('private native failure');
      return { scope: 'authorized_registered_sessions', complete: true, native_coverage_complete: true, sessions: state.rows.get(String(args.instance_ref)) ?? [] };
    }
    if (tool === 'session' && args.action === 'messages') return state.history ?? { session_ref: args.session_ref,
      page: { messages: [{ id: 'message-native', role: 'assistant', text: 'Visible native token', parts: [{ type: 'text', text: 'Visible native token' }] }], complete: false, next_cursor: null } };
    throw new Error('Unexpected control effect');
  });
  const port: V1CoreUiReadPort = { call };
  return { state, call, port, reader: createV1RegisteredUiRead({ port }) };
}
const query = (text = '') => new URLSearchParams(text);

describe('V1 registered control catalog', () => {
  it('projects all five authorized owners with native IDs and separate core refs', async () => {
    const { reader, state, call } = fixture();
    const result = await reader.catalog(query());
    expect(result.sessions).toHaveLength(5);
    for (const instance of state.owners) {
      const expected = state.rows.get(instance.instance_ref)![0]!;
      expect(result.sessions).toContainEqual(expect.objectContaining({ id: expected.address.native_session_id,
        core_session_ref: expected.session_ref, harness: instance.harness, hostId: instance.node_ref }));
    }
    expect(result.sources).toHaveLength(5);
    expect(result.sources.every(source => source.complete === false && source.scope === 'authorized_registered_sessions' && source.registeredComplete === true)).toBe(true);
    expect(call.mock.calls.every(([tool, args]) => tool === 'discover' && args.action === 'instances' || tool === 'sessions' && args.action === 'list')).toBe(true);
  });

  it('retains working owners and makes one unavailable owner explicit', async () => {
    const { reader, state } = fixture();
    state.failed.add('zai-100');
    const result = await reader.catalog(query());
    expect(result.sessions).toHaveLength(4);
    expect(result.sources).toContainEqual(expect.objectContaining({ harness: 'zai', state: 'unavailable', complete: false, reason: 'registered_owner_read_unavailable' }));
    expect(JSON.stringify(result)).not.toContain('private native failure');
  });

  it('reports missing configured harnesses and reads new authoritative discovery on the next request', async () => {
    const { reader, state } = fixture([owner('opencode')]);
    const before = await reader.catalog(query());
    expect(before.sources.filter(source => source.reason === 'configured_owner_missing').map(source => source.harness).sort()).toEqual(['chatgpt', 'codex', 'zai', 'zcode']);
    const added = owner('zcode');
    state.owners.push(added); state.rows.set(added.instance_ref, [row(added)]);
    const after = await reader.catalog(query());
    expect(after.sessions.some(session => session.harness === 'zcode')).toBe(true);
    expect(after.sources.some(source => source.harness === 'zcode' && source.reason === 'configured_owner_missing')).toBe(false);
  });

  it('does not invent idle metadata for a registered identity with no native observation', async () => {
    const { reader, state } = fixture([owner('codex')]);
    const registered = state.rows.get('codex-100')![0]!;
    registered.native = null as unknown as typeof registered.native;
    const result = await reader.catalog(query('harness=codex'));
    expect(result.sessions).toEqual([]);
    expect(result.unresolvedSessions).toEqual([{ nativeId: registered.address.native_session_id, core_session_ref: registered.session_ref, harness: 'codex', hostId: 'host-100', reason: 'registered_native_metadata_unavailable' }]);
    expect(result.sources[0]).toMatchObject({ state: 'partial', nativeMetadataComplete: false });
  });

  it.each([{ id: 'wrong-native' }, { harness: 'zai' }, { hostId: 'host-44' }])('rejects mismatched native metadata %j', async mismatch => {
    const { reader, state } = fixture([owner('codex')]);
    Object.assign(state.rows.get('codex-100')![0]!.native, mismatch);
    const result = await reader.catalog(query('harness=codex'));
    expect(result.sessions).toEqual([]);
    expect(result.sources[0]).toMatchObject({ state: 'partial', reason: 'registered_binding_invalid', complete: false });
  });
});

describe('V1 registered exact native details', () => {
  it.each(V1_UI_EXPECTED_HARNESSES)('opens a registered %s native ID via the exact core reference', async harness => {
    const { reader, state, call } = fixture();
    const selected = state.rows.get(`${harness}-100`)![0]!;
    const result = await reader.read({ harness, hostId: 'host-100', nativeId: selected.address.native_session_id, kind: 'details', limit: 50 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ session: { id: selected.address.native_session_id, harness, hostId: 'host-100' },
      core_session_ref: selected.session_ref, messages: [{ text: 'Visible native token' }], history: { complete: false },
      coverage: { source: 'v1-authorized-registered-sessions', complete: false } });
    expect(call).toHaveBeenCalledWith('session', { action: 'messages', session_ref: selected.session_ref });
  });

  it('never echoes an unconfirmed selected host into the response', async () => {
    const { reader, state, call } = fixture([owner('codex')]);
    const nativeId = state.rows.get('codex-100')![0]!.address.native_session_id;
    const result = await reader.read({ harness: 'codex', nativeId, hostId: 'host-44', kind: 'details', limit: 50 });
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('session');
    expect(call.mock.calls.some(([tool]) => tool === 'session')).toBe(false);
  });

  it('requires a unique native/core/host binding and permits exact host selection', async () => {
    const one = owner('codex'), two = owner('codex', 'host-44', '44');
    const { reader, state, call } = fixture([one, two]);
    state.rows.set(one.instance_ref, [row(one, 'same-native')]); state.rows.set(two.instance_ref, [row(two, 'same-native')]);
    const input = { harness: 'codex', nativeId: 'same-native', kind: 'details' as const, limit: 50 };
    expect((await reader.read(input)).status).toBe(409);
    expect(call.mock.calls.some(([tool]) => tool === 'session')).toBe(false);
    const exact = await reader.read({ ...input, hostId: 'host-44' });
    expect(exact.status).toBe(200);
    expect(exact.body.session).toMatchObject({ id: 'same-native', hostId: 'host-44' });
  });

  it('rejects a history response bound to a different core session', async () => {
    const { reader, state } = fixture([owner('codex')]);
    state.history = { session_ref: 'session:wrong', page: { messages: [] } };
    const nativeId = state.rows.get('codex-100')![0]!.address.native_session_id;
    const result = await reader.read({ harness: 'codex', nativeId, kind: 'details', limit: 12 });
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('messages');
  });

  it('adds registered fallback without treating a core ref as a native ID', async () => {
    const { reader, state } = fixture([owner('codex')]);
    const nativeId = state.rows.get('codex-100')![0]!.address.native_session_id;
    const scoped = createV1NativeSessionRead([], reader);
    expect((await scoped.read({ harness: 'codex', nativeId, kind: 'details', limit: 50 })).status).toBe(200);
    expect((await scoped.read({ harness: 'codex', nativeId: 'session:unknown', kind: 'details', limit: 50 })).status).toBe(400);
  });
});

describe('V1 partial UI merge with independent native activity', () => {
  function nativeProvider(): V1NativeReadProvider {
    const running: AgentSession = { id: 'ses_unregistered_active', harness: 'opencode', hostId: 'host-100', status: 'running',
      title: 'Unregistered native work', cwd: '/project', lastActivity: now, needsPermission: false };
    return { instanceRef: 'opencode-100', harness: 'opencode', hostId: 'host-100', source: 'opencode-native-api', adapter: {
      listSessions: async () => [], listActiveSessions: async () => [running],
      getActiveSessionSnapshotReceipt: () => ({ exhaustive: true, observedAt: new Date().toISOString() }),
    } };
  }
  it('shows registered rows for all five while only native evidence enters active activity', async () => {
    const { reader } = fixture();
    const ui = createV1NativeUiRead({ providers: [nativeProvider()], registered: reader, completeScope: true });
    const catalog = await ui.read('/api/sessions', query());
    expect(catalog.status).toBe(200);
    expect(catalog.body.sessions).toHaveLength(6);
    expect(catalog.body).toMatchObject({ totalIsLowerBound: true, coverage: { complete: false } });
    const active = await ui.read('/api/sessions/active', query());
    expect(active.status).toBe(200);
    expect(active.body.sessions).toMatchObject([{ id: 'ses_unregistered_active', harness: 'opencode' }]);
    expect(active.body.coverage).toMatchObject({ complete: false, sources: expect.arrayContaining([expect.objectContaining({ harness: 'codex', source: 'native-provider', reason: 'native_read_provider_unavailable' })]) });
  });

  it('preserves a healthy native source when registered discovery fails', async () => {
    const { reader, state } = fixture(); state.discoveryError = true;
    const result = await createV1NativeUiRead({ providers: [nativeProvider()], registered: reader }).read('/api/sessions', query());
    expect(result.status).toBe(200);
    expect(result.body.sessions).toMatchObject([{ id: 'ses_unregistered_active' }]);
    expect(result.body.coverage).toMatchObject({ complete: false, sources: expect.arrayContaining([expect.objectContaining({ reason: 'configured_owner_discovery_unavailable' })]) });
  });

  it('keeps surviving registered owners when a native source is unavailable', async () => {
    const { reader } = fixture(); const failing = nativeProvider();
    failing.adapter.listSessions = async () => { throw new Error('unavailable'); };
    failing.adapter.listActiveSessions = async () => { throw new Error('unavailable'); };
    const result = await createV1NativeUiRead({ providers: [failing], registered: reader }).read('/api/sessions', query());
    expect(result.status).toBe(200);
    expect(result.body.sessions).toHaveLength(5);
    expect(result.body.coverage).toMatchObject({ complete: false });
  });

  it('keeps a registered owner error partial even when connected native sources report complete snapshots', async () => {
    const { state } = fixture([owner('opencode')]);
    const native = nativeProvider();
    native.adapter.getSessionSnapshotReceipt = () => ({ exhaustive: true, observedAt: new Date().toISOString(), source: 'native-catalog' });
    const scopedRegistry = createV1RegisteredUiRead({ port: { call: async tool => {
      if (tool === 'discover') return { scope: 'configured_owner_instances', complete: true, instances: state.owners };
      throw new Error('owner unavailable');
    } }, expectedHarnesses: ['opencode'] });
    const result = await createV1NativeUiRead({ providers: [native], registered: scopedRegistry, completeScope: true }).read('/api/sessions', query());
    expect(result.status).toBe(200);
    expect(result.body.sessions).toMatchObject([{ id: 'ses_unregistered_active' }]);
    expect(result.body.coverage).toMatchObject({ complete: false });
  });
});
