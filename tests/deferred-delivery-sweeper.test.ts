import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredDeliverySweeper } from '../src/deferred-delivery-sweeper.js';
import { deferredMessages } from '../src/deferred-messages.js';
import type { AgentSession, HarnessAdapter } from '../src/types/index.js';

// Focused unit tests for the deferred delivery sweeper.
// Expected <1s per case; no production MCP/model/session operations.
const idle = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'ses-idle',
  harness: 'opencode',
  title: 'idle session',
  cwd: '/tmp',
  status: 'idle',
  lastActivity: new Date(Date.now() - 600_000).toISOString(),
  needsPermission: false,
  ...overrides,
});

function adapterFor(session: AgentSession, sendMessage = vi.fn(async () => ({ ok: true }))): HarnessAdapter {
  const adapter: HarnessAdapter = {
    type: session.harness as HarnessAdapter['type'],
    name: 'isolated',
    async init() {},
    async listSessions() { return [session]; },
    async getSession() { return { ...session }; },
    sendMessage,
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return adapter;
}

const envKeys = [
  'AGENT_HERDER_DEFERRED_SWEEP_INTERVAL_MS',
  'AGENT_HERDER_DEFERRED_SWEEP_IDLE_GRACE_MS',
  'AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE',
  'AGENT_HERDER_DEFERRED_SWEEP_HARNESSES',
] as const;

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  process.env.AGENT_HERDER_DEFERRED_SWEEP_IDLE_GRACE_MS = '0';
  for (const message of await deferredMessages.listAll()) await deferredMessages.remove([message.id]);
});

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
  vi.restoreAllMocks();
});

describe('deferred delivery sweeper', () => {
  it('delivers a parked message to an idle session and clears it from the store', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const adapters = new Map<string, HarnessAdapter>([['opencode', adapterFor(idle(), send)]]);
    const parked = await deferredMessages.add('ses-idle', 'parked report', 'opencode');
    const outcome = await new DeferredDeliverySweeper(adapters).sweep();
    expect(outcome).toEqual({ delivered: 1, kept: 0, skipped: 0 });
    expect(send).toHaveBeenCalledWith('ses-idle', {
      message: 'parked report', queue: true, origin: 'automation', inputId: `deferred-${parked.id}`,
    });
    expect(await deferredMessages.list('ses-idle')).toHaveLength(0);
  });

  it('keeps a refused delivery parked for a later cycle', async () => {
    const send = vi.fn(async () => ({ ok: false, notSubmitted: true, error: 'quota' }));
    const adapters = new Map<string, HarnessAdapter>([['opencode', adapterFor(idle(), send)]]);
    await deferredMessages.add('ses-idle', 'parked report', 'opencode');
    const outcome = await new DeferredDeliverySweeper(adapters).sweep();
    expect(outcome).toEqual({ delivered: 0, kept: 1, skipped: 0 });
    expect(await deferredMessages.list('ses-idle')).toHaveLength(1);
  });

  it('never touches a busy, permission-blocked or freshly active target', async () => {
    for (const session of [
      idle({ status: 'running' }),
      idle({ status: 'needs_input' }),
      idle({ needsPermission: true }),
    ]) {
      const send = vi.fn(async () => ({ ok: true }));
      const adapters = new Map<string, HarnessAdapter>([['opencode', adapterFor(session, send)]]);
      await deferredMessages.add(session.id, 'parked report', 'opencode');
      const outcome = await new DeferredDeliverySweeper(adapters).sweep();
      expect(outcome).toEqual({ delivered: 0, kept: 0, skipped: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(await deferredMessages.list(session.id)).toHaveLength(1);
      for (const message of await deferredMessages.listAll()) await deferredMessages.remove([message.id]);
    }
  });

  it('never sweeps a legacy park that predates the harness tag', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const adapters = new Map<string, HarnessAdapter>([['opencode', adapterFor(idle(), send)]]);
    await deferredMessages.add('ses-idle', 'legacy park');
    const outcome = await new DeferredDeliverySweeper(adapters).sweep();
    expect(outcome).toEqual({ delivered: 0, kept: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(await deferredMessages.list('ses-idle')).toHaveLength(1);
  });

  it('never sweeps a harness the sweeper does not serve', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const session = idle({ harness: 'zcode' });
    const adapters = new Map<string, HarnessAdapter>([['zcode', adapterFor(session, send)]]);
    await deferredMessages.add(session.id, 'parked report', 'zcode');
    const outcome = await new DeferredDeliverySweeper(adapters).sweep();
    expect(outcome).toEqual({ delivered: 0, kept: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('spends the cycle budget only on eligible parks', async () => {
    process.env.AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE = '1';
    const first = vi.fn(async () => ({ ok: true }));
    const second = vi.fn(async () => ({ ok: true }));
    const adapters = new Map<string, HarnessAdapter>([
      ['opencode', adapterFor(idle({ id: 'ses-first' }), first)],
      ['codex', adapterFor(idle({ id: 'ses-second', harness: 'codex' }), second)],
    ]);
    // A legacy park without a harness tag must not consume the only slot.
    await deferredMessages.add('ses-legacy', 'legacy park');
    await deferredMessages.add('ses-first', 'first report', 'opencode');
    await deferredMessages.add('ses-second', 'second report', 'codex');
    const outcome = await new DeferredDeliverySweeper(adapters).sweep();
    expect(outcome.delivered).toBe(1);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    expect(await deferredMessages.list('ses-legacy')).toHaveLength(1);
  });

  it('never sends the same parked message twice', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const adapters = new Map<string, HarnessAdapter>([['opencode', adapterFor(idle(), send)]]);
    await deferredMessages.add('ses-idle', 'parked report', 'opencode');
    const sweeper = new DeferredDeliverySweeper(adapters);
    await sweeper.sweep();
    await sweeper.sweep();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
