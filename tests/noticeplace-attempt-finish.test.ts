import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutopilotSessionStore } from '../src/autopilot/session-store.js';
import { createWebServer } from '../src/web/server.js';
import { noticeplaceAttemptOutcome } from '../src/automation/noticeplace-attempt-outcome.js';

let root: string;
let server: ReturnType<typeof createWebServer> | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; }
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('the production factory pauses only the exact explicitly finished attempt and allows same-session rearming', async () => {
  await mkdir('.tmp', { recursive: true }); root = await mkdtemp('.tmp/attempt-finish-');
  const callback = join(root, 'callback.json');
  await writeFile(callback, JSON.stringify({ url: 'http://127.0.0.1:19999', tokens: { qa: 'unit-only' } }), { mode: 0o600 });
  vi.stubEnv('GPTADMIN_HEALTH_CALLBACK_FILE', callback);
  vi.stubEnv('AGENT_HERDER_AUTOPILOT_STATE_DIR', root);
  let attempt = 'old';
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    if (!String(input).startsWith('http://127.0.0.1:19999')) return nativeFetch(input, init);
    return Response.json({ id: 'inc_new', project: 'qa', state: 'open', lifecycle: {
      attempt_state: 'work_finished', attempt_id: attempt, session_id: 'ses_1', harness: 'opencode',
    } });
  }));
  const store = new AutopilotSessionStore(join(root, 'sessions.json'));
  const details = { session: { id: 'ses_1', harness: 'opencode', cwd: '/qa', status: 'running',
    lastActivity: new Date().toISOString(), messageCount: 0 }, messages: [], children: [], lineage: { kind: 'root' },
    history: { complete: true, source: 'live-cache' } };
  server = createWebServer({ adapters: new Map(), converter: {} as any,
    supervisor: { getSessionDetails: async () => details } as any, autopilotSessionStore: store,
    sessionObservationManagedExternally: true, noticeplaceHealthObservationIntervalMs: 10 });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/autopilot/sessions/opencode/ses_1`;
  const arm = (attemptId: string, first = false) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, cwd: '/qa', ...(first ? { noticeIncident: { incidentId: 'inc_first', project: 'qa', planId: 'repair' } } : {}),
      noticeAttempt: { incidentId: 'inc_new', attemptId } }) });
  expect((await arm('current', true)).status).toBe(200);
  await new Promise(r => setTimeout(r, 40));
  expect((await store.get('opencode', 'ses_1'))?.enabled).toBe(true); // Old finish cannot pause the new attempt.
  attempt = 'current';
  // The already-running production observer must see the receipt without a new arming request.
  await vi.waitFor(async () => expect((await store.get('opencode', 'ses_1'))?.enabled).toBe(false));
  expect(await new AutopilotSessionStore(join(root, 'sessions.json')).get('opencode', 'ses_1')).toMatchObject({
    noticeIncident: { incidentId: 'inc_first' }, noticeAttempt: { incidentId: 'inc_new', attemptId: 'current' },
  });
  expect((await arm('next')).status).toBe(200);
  await new Promise(r => setTimeout(r, 40));
  expect((await store.get('opencode', 'ses_1'))?.enabled).toBe(true);
});

it('rejects unavailable, wrong native identity and stale in-flight receipts without changing a successor', async () => {
  await mkdir('.tmp', { recursive: true }); root = await mkdtemp('.tmp/attempt-fence-');
  const callback = join(root, 'callback.json');
  await writeFile(callback, JSON.stringify({ url: 'http://127.0.0.1:19999', tokens: { qa: 'unit-only' } }), { mode: 0o600 });
  vi.stubEnv('GPTADMIN_HEALTH_CALLBACK_FILE', callback);
  const store = new AutopilotSessionStore(join(root, 'sessions.json'));
  const target = { harness: 'opencode' as const, sessionId: 'ses_1', cwd: '/qa',
    noticeIncident: { incidentId: 'inc_1', project: 'qa' }, noticeAttempt: { incidentId: 'inc_1', attemptId: 'a' } };
  await store.set(target, true);
  const read = noticeplaceAttemptOutcome(store);
  for (const response of [new Response('', { status: 503 }), Response.json({ id: 'inc_1', project: 'qa', lifecycle: {
    attempt_state: 'work_finished', attempt_id: 'a', session_id: 'other', harness: 'opencode',
  } }), Response.json({ id: 'inc_1', project: 'qa', lifecycle: {
    attempt_state: 'work_finished', attempt_id: 'a', session_id: 'ses_1', harness: 'codex',
  } })]) {
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await read('opencode', 'ses_1')).toBeNull();
    expect((await store.get('opencode', 'ses_1'))?.enabled).toBe(true);
  }
  vi.stubGlobal('fetch', vi.fn(async () => {
    await store.set({ ...target, noticeAttempt: { incidentId: 'inc_1', attemptId: 'b' } }, true);
    return Response.json({ id: 'inc_1', project: 'qa', lifecycle: {
      attempt_state: 'work_finished', attempt_id: 'a', session_id: 'ses_1', harness: 'opencode',
    } });
  }));
  expect(await read('opencode', 'ses_1')).toBeNull();
  expect((await store.get('opencode', 'ses_1'))?.enabled).toBe(true);
});
