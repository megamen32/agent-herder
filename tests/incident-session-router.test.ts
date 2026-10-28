import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {IncidentSessionRouter, incidentSourceKey} from '../src/automation/incident-session-router.js';
import type {AgentSession} from '../src/types/common.js';

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
function request(id: string, host = 'vusa') {
  return {harness: 'opencode', cwd: '/workspace', inputId: id,
    message: JSON.stringify({id: `inc_${id}`, project: 'fleet-health', source_id: 'fleet-load', host_id: host, signal_type: 'load', correlation_id: id, source_fingerprint: id})};
}
async function fixture() {
  await mkdir('.tmp', {recursive: true});
  const dir = await mkdtemp('.tmp/incident-router-'); roots.push(dir);
  const path = join(dir, 'groups.json');
  const sessions = new Map<string, AgentSession>();
  const deliveries: Array<{id: string; input: string}> = [];
  let created = 0;
  const ports = {readSession: async (_: string, id: string) => sessions.get(id) ?? null,
    unfinished: async (session: AgentSession) => session.status !== 'stopped'};
  const router = () => new IncidentSessionRouter(path, ports);
  const launch = (input: string) => async (existing?: string) => {
    const id = existing ?? `ses_${++created}`;
    if (!existing) sessions.set(id, {id, cwd: '/workspace', harness: 'opencode', status: 'running', title: 'repair', lastActivity: '', needsPermission: false});
    await new Promise(resolve => setTimeout(resolve, 15));
    deliveries.push({id, input});
    return {ok: true, created: !existing, harness: 'opencode', cwd: '/workspace', name: input, sessionId: id};
  };
  return {router, launch, sessions, deliveries, count: () => created, path};
}

it('serializes concurrent new incidents and retains one executor after restart', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all(['one', 'two'].map(id => f.router().run(request(id), f.launch(id))));
  const c = await f.router().run(request('three'), f.launch('three'));
  expect(f.count()).toBe(1);
  expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(1);
  expect(f.deliveries.map(x => x.input).sort()).toEqual(['one', 'three', 'two']);
  expect(c.coalesced).toBe(true);
});

it('separates hosts/signals and starts a new generation after completion', async () => {
  const f = await fixture();
  const a = await f.router().run(request('one'), f.launch('one'));
  await f.router().run(request('two', 'vpn2'), f.launch('two'));
  f.sessions.get(a.sessionId!)!.status = 'stopped';
  const c = await f.router().run(request('three'), f.launch('three'));
  expect(f.count()).toBe(3);
  expect(c.sessionId).not.toBe(a.sessionId);
  expect(incidentSourceKey(request('one').message)).toBe(incidentSourceKey(request('two').message));
  expect(incidentSourceKey(JSON.stringify({id: 'inc_missing', title: 'same'}))).toBeUndefined();
});

it('fences an unknown creation across restart instead of launching another session', async () => {
  const f = await fixture();
  await expect(f.router().run(request('one'), async () => {throw new Error('transport lost');})).rejects.toThrow('transport lost');
  const b = await f.router().run(request('two'), f.launch('two'));
  expect(b.admissionUnknown).toBe(true);
  expect(f.count()).toBe(0);
});

it('adopts a proven existing executor without a new native create', async () => {
  const f = await fixture();
  const old: AgentSession = {id: 'ses_legacy', harness: 'opencode', cwd: '/workspace', title: 'old', status: 'running', lastActivity: '', needsPermission: false};
  f.sessions.set(old.id, old);
  const router = new IncidentSessionRouter(f.path, {readSession: async () => old, unfinished: async () => true, findExisting: async () => old});
  const result = await router.run(request('new'), f.launch('new'));
  expect(result.sessionId).toBe(old.id);
  expect(result.coalesced).toBe(true);
  expect(f.count()).toBe(0);
});

it('keeps a held executor attached even when it is stopped', async () => {
  const f = await fixture();
  const a = await f.router().run(request('one'), f.launch('one'));
  f.sessions.get(a.sessionId!)!.status = 'stopped';
  const router = new IncidentSessionRouter(f.path, {
    readSession: async () => f.sessions.get(a.sessionId!)!, unfinished: async () => false, held: async () => true,
  });
  let target: string | undefined;
  const b = await router.run(request('two'), async existing => {
    target = existing;
    return {ok: false, created: false, harness: 'opencode', cwd: '/workspace', name: 'held', delivery: 'not_attempted', error: 'HumanStop'};
  });
  expect(target).toBe(a.sessionId);
  expect(b.created).toBe(false);
  expect(f.count()).toBe(1);
});
