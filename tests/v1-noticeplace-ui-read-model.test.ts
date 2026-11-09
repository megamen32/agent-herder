import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../src/types/index.js';
import type { PendingChoice } from '../src/autopilot/choice-registry.js';
import type { HerderJob } from '../src/herder-jobs.js';
import { createV1NativeUiRead, type V1NativeReadProvider } from '../src/automation/v1-noticeplace-ui-read.js';
import { parseActiveActivity, mergeActiveActivity } from '../src/web-ui/active-activity.js';

const now = new Date().toISOString();
const native: AgentSession = {
  id: 'ses_unregistered_running', harness: 'opencode', status: 'running', title: 'Native work',
  cwd: '/project', hostId: 'host-100', lastActivity: now, needsPermission: false,
  meta: { activityEvidence: 'opencode-native-active-status', activityObservedAt: now,
    activityExpiresAt: new Date(Date.now() + 30_000).toISOString() },
};
const query = (values = '') => new URLSearchParams(values);
function provider(input: { catalog?: AgentSession[]; active?: AgentSession[]; catalogComplete?: boolean; activeComplete?: boolean } = {}) {
  const adapter = {
    listSessions: vi.fn(async () => input.catalog ?? []),
    listActiveSessions: vi.fn(async () => input.active ?? [native]),
    getSessionSnapshotReceipt: vi.fn(() => ({ exhaustive: input.catalogComplete ?? false, observedAt: now, source: 'native-catalog', reason: 'window' })),
    getActiveSessionSnapshotReceipt: vi.fn(() => ({ exhaustive: input.activeComplete ?? true, observedAt: now, source: 'native-active' })),
  };
  const value: V1NativeReadProvider = { instanceRef: 'opencode-100', harness: 'opencode', hostId: 'host-100', source: 'opencode-native-api', adapter };
  return { value, adapter };
}
describe('V1 native UI read projection', () => {
  it('adds unregistered running native IDs to the catalog and actual UI activity merge', async () => {
    const { value, adapter } = provider();
    const read = createV1NativeUiRead({ providers: [value] });
    const catalog = await read.read('/api/sessions', query());
    expect(catalog.status).toBe(200);
    expect(catalog.body.sessions).toEqual([native]);
    expect(adapter.listSessions).toHaveBeenCalledWith({ limit: 500 });
    expect(catalog.body.coverage).toMatchObject({ complete: false, sources: [{ instanceRef: 'opencode-100', harness: 'opencode', source: 'opencode-native-api', state: 'partial', complete: false }] });
    const result = await read.read('/api/sessions/active', query());
    expect(result.status).toBe(200);
    const parsed = parseActiveActivity(result.body);
    expect(parsed.partial).toBe(true);
    const merged = mergeActiveActivity([], parsed.confirmed, { hostId: 'host-100' });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: native.id, harness: 'opencode', status: 'running' });
    expect(result.body.sessions).toMatchObject([{ id: native.id, runtimeHostId: native.hostId, activity: { evidence: native.meta!.activityEvidence, observedAt: now } }]);
  });

  it('does not label a known subset of owners as a complete total', async () => {
    const { value } = provider({ catalogComplete: true });
    const result = await createV1NativeUiRead({ providers: [value], completeScope: false }).read('/api/sessions', query());
    expect(result.body.coverage).toMatchObject({ complete: false });
    expect(result.body.totalIsLowerBound).toBe(true);
  });

  it('distinguishes a confirmed empty native result from a missing provider', async () => {
    const { value } = provider({ active: [], catalogComplete: true });
    const read = createV1NativeUiRead({ providers: [value], completeScope: true });
    const empty = await read.read('/api/sessions', query());
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ sessions: [], total: 0, totalIsLowerBound: false, coverage: { complete: true } });
    const missing = await read.read('/api/sessions', query('harness=chatgpt'));
    expect(missing.status).toBe(503);
    expect(missing.body).not.toHaveProperty('sessions');
    expect(missing.body).toMatchObject({ requestedHarness: 'chatgpt', coverage: { complete: false } });
  });

  it('reports a failed native read without fabricated empty sessions', async () => {
    const { value, adapter } = provider();
    adapter.listActiveSessions.mockRejectedValue(new Error('private upstream detail'));
    const result = await createV1NativeUiRead({ providers: [value] }).read('/api/sessions/active', query());
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('sessions');
    expect(result.body.coverage).toMatchObject({ complete: false, sources: [{ state: 'unavailable', reason: 'native_read_failed' }] });
    expect(JSON.stringify(result.body)).not.toContain('private upstream detail');
  });

  it.each(['session:core-reference', ''])('rejects a non-native identity %j', async id => {
    const { value } = provider({ active: [{ ...native, id }] });
    const result = await createV1NativeUiRead({ providers: [value] }).read('/api/sessions/active', query());
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('sessions');
  });

  it('keeps missing catalog receipts explicitly incomplete', async () => {
    const { value } = provider({ catalogComplete: true });
    delete value.adapter.getSessionSnapshotReceipt;
    const result = await createV1NativeUiRead({ providers: [value], completeScope: true }).read('/api/sessions', query());
    expect(result.body.coverage).toMatchObject({ complete: false, sources: [{ complete: false, reason: 'native_catalog_window' }] });
  });

  it('filters native scope without calling unrelated providers', async () => {
    const first = provider(), second = provider();
    second.value = { ...second.value, instanceRef: 'opencode-44', hostId: 'host-44' };
    const read = createV1NativeUiRead({ providers: [first.value, second.value] });
    await read.read('/api/sessions', query('runtimeHostId=host-100&cwd=/project&status=running'));
    expect(first.adapter.listSessions).toHaveBeenCalledOnce();
    expect(second.adapter.listSessions).not.toHaveBeenCalled();
    expect(second.adapter.listActiveSessions).not.toHaveBeenCalled();
  });

  it('unions active state over a stale catalog row, keeps native metadata and sorts active first', async () => {
    const old = { ...native, status: 'idle' as const, lastActivity: '2020-01-01T00:00:00.000Z' };
    const idle = { ...native, id: 'ses_idle', status: 'idle' as const, lastActivity: new Date(Date.now() + 5_000).toISOString() };
    const { value } = provider({ catalog: [idle, old] });
    const result = await createV1NativeUiRead({ providers: [value] }).read('/api/sessions', query('limit=1'));
    expect(result.body).toMatchObject({ sessions: [{ id: native.id, status: 'running' }], total: 2, truncated: true, limit: 1 });
  });

  it.each(['limit=0', 'limit=501', 'limit=1.5', 'limit=nope'])('validates bounds before native reads: %s', async input => {
    const { value, adapter } = provider();
    const result = await createV1NativeUiRead({ providers: [value] }).read('/api/sessions', query(input));
    expect(result.status).toBe(400);
    expect(adapter.listSessions).not.toHaveBeenCalled();
    expect(adapter.listActiveSessions).not.toHaveBeenCalled();
  });
});

describe('V1 real store read projections', () => {
  const pending: PendingChoice = { harness: 'opencode', requestId: 'request-native', sessionId: native.id, turnId: 'turn-1', cwd: '/project',
    choices: [{ choiceId: 'continue', label: 'Continue', nextGoal: 'private next goal' }], status: 'pending', createdAt: now };
  const job: HerderJob = { id: 'job-existing', kind: 'noticeplace', state: 'running', createdAt: now, updatedAt: now, ownerSessionId: native.id, resultRef: 'job:existing' };

  it('returns existing registry jobs and only public pending choice fields', async () => {
    const jobs = { list: vi.fn(() => [job]) };
    const choices = { list: vi.fn(async () => [pending, { ...pending, requestId: 'old', createdAt: '2020-01-01T00:00:00.000Z' }]) };
    const read = createV1NativeUiRead({ providers: [], jobs, choices });
    expect((await read.read('/api/jobs', query('limit=7'))).body).toMatchObject({ jobs: [job], coverage: { complete: false } });
    expect(jobs.list).toHaveBeenCalledWith(7);
    const result = await read.read('/api/autopilot/choices', query());
    expect(result.body.choices).toEqual([{ requestId: pending.requestId, sessionId: native.id, harness: 'opencode', cwd: '/project', status: 'pending', createdAt: now, choices: [{ choiceId: 'continue', label: 'Continue' }] }]);
    expect(choices.list).toHaveBeenCalledWith({ status: 'pending', limit: 100 });
    expect(JSON.stringify(result.body)).not.toContain('private next goal');
  });

  it('returns existing global policy and native enabled session overrides', async () => {
    const overrides = [
      { harness: 'opencode' as const, sessionId: native.id, cwd: '/project', enabled: true, updatedAt: now },
      { harness: 'opencode' as const, sessionId: 'ses_disabled', cwd: '/project', enabled: false, updatedAt: now },
    ];
    const read = createV1NativeUiRead({ providers: [], autopilot: { list: vi.fn(async () => overrides) }, readPolicy: async () => ({ enabled: true, harnesses: ['opencode', 'codex'] }) });
    expect((await read.read('/api/autopilot/overview', query())).body).toMatchObject({ global: true, harnesses: ['opencode', 'codex'], sessions: [{ harness: 'opencode', sessionId: native.id }], coverage: { complete: false } });
  });

  it.each(['/api/jobs', '/api/autopilot/choices', '/api/autopilot/overview'] as const)('reports missing store %s instead of an empty success', async path => {
    const result = await createV1NativeUiRead({ providers: [] }).read(path, query());
    expect(result.status).toBe(503);
    expect(result.body.coverage).toMatchObject({ complete: false });
    expect(Object.keys(result.body)).toEqual(['error', 'coverage']);
  });

  it('does not invent a harness for an old choice with no native identity', async () => {
    const result = await createV1NativeUiRead({ providers: [], choices: { list: async () => [{ ...pending, harness: undefined }] } }).read('/api/autopilot/choices', query());
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('choices');
  });

  it('does not invent global enable state when policy read fails', async () => {
    const result = await createV1NativeUiRead({ providers: [], autopilot: { list: async () => [] }, readPolicy: async () => { throw new Error('private file error'); } }).read('/api/autopilot/overview', query());
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('global');
    expect(JSON.stringify(result.body)).not.toContain('private file error');
  });
});

describe('V1 native snapshot scope and freshness', () => {
  it('rejects a native row explicitly bound to a different host', async () => {
    const { value } = provider({ active: [{ ...native, hostId: 'host-44' }] });
    const result = await createV1NativeUiRead({ providers: [value], completeScope: true }).read('/api/sessions/active', query());
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('sessions');
  });

  it('fills a missing native host from the exact configured provider', async () => {
    const { value } = provider({ active: [{ ...native, hostId: undefined } as unknown as AgentSession] });
    const result = await createV1NativeUiRead({ providers: [value], completeScope: true }).read('/api/sessions/active', query());
    expect(result.status).toBe(200);
    expect(result.body.sessions).toMatchObject([{ runtimeHostId: 'host-100' }]);
  });

  it.each([
    ['expired', () => new Date(Date.now() - 60_000).toISOString(), 'native_snapshot_expired'],
    ['invalid', () => 'not-a-timestamp', 'native_snapshot_time_invalid'],
    ['future', () => new Date(Date.now() + 60_000).toISOString(), 'native_snapshot_from_future'],
  ] as const)('does not confirm active rows from an %s aggregate receipt', async (_name, time, reason) => {
    const { value, adapter } = provider();
    adapter.getActiveSessionSnapshotReceipt.mockReturnValue({ exhaustive: true, observedAt: time(), source: 'native-active' });
    const result = await createV1NativeUiRead({ providers: [value], completeScope: true }).read('/api/sessions/active', query());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ sessions: [], partial: true, coverage: { complete: false, sources: [{ complete: false, state: 'partial', reason }] } });
  });

  it('does not revive an expired row with a fresh aggregate receipt', async () => {
    const { value } = provider({ active: [{ ...native, meta: { ...native.meta,
      activityExpiresAt: new Date(Date.now() - 1_000).toISOString() } }] });
    const result = await createV1NativeUiRead({ providers: [value], completeScope: true }).read('/api/sessions/active', query());
    expect(result.body).toMatchObject({ sessions: [], partial: true, coverage: { complete: false, sources: [{ reason: 'native_activity_expired' }] } });
  });

  it('bounds native activity expiry even if the provider returns an excessive TTL', async () => {
    const { value } = provider({ active: [{ ...native, meta: { ...native.meta,
      activityExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } }] });
    const result = await createV1NativeUiRead({ providers: [value] }).read('/api/sessions/active', query());
    const row = (result.body.sessions as { activity: { expiresAt: string } }[])[0]!;
    expect(Date.parse(row.activity.expiresAt)).toBeLessThanOrEqual(Date.parse(now) + 30_000);
  });
});
