import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutopilotSessionStore } from '../src/autopilot/session-store.js';
import { IncidentSessionRouter } from '../src/automation/incident-session-router.js';
import { noticeplaceGroupContinuationPorts } from '../src/automation/noticeplace-group-continuation.js';
import type { AgentSession } from '../src/types/common.js';

let root: string;
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  await mkdir('.tmp', { recursive: true }); root = await mkdtemp('.tmp/group-continuation-');
  const callback = join(root, 'callback.json');
  await writeFile(callback, JSON.stringify({ url: 'http://127.0.0.1:19999', tokens: { qa: 'unit-only' } }), { mode: 0o600 });
  vi.stubEnv('GPTADMIN_HEALTH_CALLBACK_FILE', callback);
  const group = { project: 'qa', consumer_id: 'consumer_fleet', source_id: 'fleet', host_id: 'host', problem_type: 'cpu', signal_type: 'load' };
  const continuation = { incident_id: 'inc_A', session_id: 'ses_1', harness: 'opencode', attempt_id: 'old-attempt', request_id: 'authority_nonce', generation: 1 };
  const lifecycle = { group_key: 'group_1', group, session_id: 'ses_1', harness: 'opencode', attempt_id: 'old-attempt',
    request_id: 'rotated_pending_nonce', generation: 3, continuation };
  const documents: Record<string, any> = { inc_A: { id: 'inc_A', project: 'qa', state: 'open', lifecycle: structuredClone(lifecycle) },
    inc_B: { id: 'inc_B', project: 'qa', state: 'resolved', lifecycle: structuredClone(lifecycle) } };
  const fetcher = vi.fn(async (url: string) => Response.json(documents[decodeURIComponent(url.split('/').pop()!)]));
  vi.stubGlobal('fetch', fetcher);
  const store = new AutopilotSessionStore(join(root, 'sessions.json'));
  const session = { id: 'ses_1', harness: 'opencode', cwd: '/qa', status: 'stopped', title: 'repair', lastActivity: '', needsPermission: false } as AgentSession;
  const request = (id: string) => ({ harness: 'opencode', cwd: '/qa', inputId: id, message: JSON.stringify({ id, ...group }) });
  let created = 0;
  const launches: Array<string | undefined> = [];
  const launch = async (existing?: string) => { launches.push(existing); if (!existing) created++;
    return { ok: true, created: !existing, harness: 'opencode', cwd: '/qa', name: 'unit', sessionId: existing ?? 'ses_1' }; };
  const path = join(root, 'router.json');
  await new IncidentSessionRouter(path, { readSession: async () => session, unfinished: async () => true }).run(request('inc_B'), launch);
  launches.length = 0;
  await store.set({ harness: 'opencode', sessionId: session.id, cwd: '/qa', noticeIncident: { incidentId: 'inc_A', project: 'qa' },
    noticeAttempt: { incidentId: 'inc_B', attemptId: 'old-attempt' } }, false);
  const ports = noticeplaceGroupContinuationPorts(store);
  const router = (held = false) => new IncidentSessionRouter(path, { readSession: async () => session, unfinished: async () => false,
    held: async () => held, ...ports });
  return { documents, request, router, launch, launches, fetcher, created: () => created };
}

it('production ports reuse the same session for open A after latest B resolved, despite rotated pending nonces', async () => {
  const f = await fixture();
  const result = await f.router().run(f.request('inc_A'), f.launch);
  expect(result).toMatchObject({ ok: true, created: false, sessionId: 'ses_1', coalesced: true });
  expect(f.launches).toEqual(['ses_1']); expect(f.created()).toBe(1);
});

it.each(['closed-origin', 'missing-ledger', 'wrong-group', 'wrong-session', 'wrong-harness', 'wrong-attempt', 'new-current-attempt'])('fences %s authority without launching a replacement', async kind => {
  const f = await fixture();
  if (kind === 'closed-origin') f.documents.inc_A.state = 'resolved';
  if (kind === 'missing-ledger') delete f.documents.inc_A.lifecycle.continuation;
  if (kind === 'wrong-group') f.documents.inc_A.lifecycle.group_key = 'other';
  if (kind === 'wrong-session') f.documents.inc_B.lifecycle.continuation.session_id = 'ses_other';
  if (kind === 'wrong-harness') f.documents.inc_B.lifecycle.continuation.harness = 'codex';
  if (kind === 'wrong-attempt') f.documents.inc_B.lifecycle.continuation.attempt_id = 'different';
  if (kind === 'new-current-attempt') f.documents.inc_B.lifecycle.attempt_id = 'successor';
  const result = await f.router().run(f.request('inc_A'), f.launch);
  expect(result).toMatchObject({ ok: false, created: false, delivery: 'not_attempted', sessionId: 'ses_1' });
  expect(f.launches).toEqual([]); expect(f.created()).toBe(1);
});

it('preserves a legitimate new generation after the entire old group is healthy', async () => {
  const f = await fixture();
  delete f.documents.inc_B.lifecycle.continuation;
  f.documents.inc_A.state = 'resolved';
  f.documents.inc_new = { id: 'inc_new', project: 'qa', state: 'open', lifecycle: {
    group_key: 'group_1', group: f.documents.inc_B.lifecycle.group, attempt_id: null, session_id: null } };
  expect(await f.router().run(f.request('inc_new'), f.launch)).toMatchObject({ ok: true, created: true });
  expect(f.launches).toEqual([undefined]);
});

it('does not escape HumanStop through the sibling origin or a new session', async () => {
  const f = await fixture();
  await f.router(true).run(f.request('inc_A'), async existing => {
    expect(existing).toBe('ses_1'); // The unchanged native admission gate sees and rejects the held session.
    return { ok: false, created: false, harness: 'opencode', cwd: '/qa', name: 'held', sessionId: existing, delivery: 'not_attempted', nonRetryable: true };
  });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.created()).toBe(1);
});

it('an unreachable authority is not retried through a new native session', async () => {
  const f = await fixture(); f.fetcher.mockRejectedValue(new Error('isolated unavailable'));
  await expect(f.router().run(f.request('inc_A'), f.launch)).rejects.toThrow('isolated unavailable');
  expect(f.launches).toEqual([]); expect(f.created()).toBe(1);
});
