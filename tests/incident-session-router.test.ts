import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {IncidentSessionRouter, incidentLegacySourceKeys, incidentSourceKey} from '../src/automation/incident-session-router.js';
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

it('separates hosts and starts a new generation only after the bound incident is closed', async () => {
  const f = await fixture();
  const a = await f.router().run(request('one'), f.launch('one'));
  await f.router().run(request('two', 'vpn2'), f.launch('two'));
  f.sessions.get(a.sessionId!)!.status = 'stopped';
  const closedIncident = new IncidentSessionRouter(f.path, {
    readSession: async () => f.sessions.get(a.sessionId!) ?? null,
    unfinished: async session => session.status !== 'stopped',
    boundIncidentOpen: async () => false,
  });
  const c = await closedIncident.run(request('three'), f.launch('three'));
  expect(f.count()).toBe(3);
  expect(c.sessionId).not.toBe(a.sessionId);
  expect(incidentSourceKey(request('one').message)).toBe(incidentSourceKey(request('two').message));
  expect(incidentSourceKey(JSON.stringify({id: 'inc_missing', title: 'same'}))).toBeUndefined();
});

it('separates consumer and problem type while preserving the documented fallbacks', () => {
  const facts = {id: 'inc_one', project: 'fleet-health', source_id: 'fleet-load', consumer_id: 'node-pressure', host_id: 'vusa', signal_type: 'degraded', problem_type: 'cpu'};
  const key = (value: typeof facts) => incidentSourceKey(JSON.stringify(value));
  expect(key(facts)).not.toBe(key({...facts, problem_type: 'disk'}));
  expect(key(facts)).not.toBe(key({...facts, problem_type: 'CPU'}));
  expect(key(facts)).not.toBe(key({...facts, host_id: 'server-44'}));
  expect(key(facts)).not.toBe(key({...facts, consumer_id: 'other-consumer'}));
  expect(key(facts)).toBe(key({...facts, problem_type: '', signal_type: 'cpu'}));
  expect(key({...facts, consumer_id: ''})).toBe(key({...facts, consumer_id: '', source_id: 'fleet-load'}));
  expect(key({...facts, consumer_id: '', source_id: 'other-source'})).not.toBe(key({...facts, consumer_id: '', source_id: 'fleet-load'}));
  expect(key({...facts, problem_type: '', signal_type: 'other-signal'})).not.toBe(key({...facts, problem_type: '', signal_type: 'degraded'}));
  expect(key({...facts, consumer_id: 12 as unknown as string})).toBeUndefined();
  const load = request('load');
  const cpu = {...request('cpu'), message: request('cpu').message.replace('"signal_type":"load"', '"signal_type":"cpu"')};
  expect(incidentSourceKey(load.message)).toBe(incidentSourceKey(cpu.message));
  const disk = {...request('disk'), message: request('disk').message.replace('"signal_type":"load"', '"signal_type":"disk_space"')};
  expect(incidentSourceKey(load.message)).not.toBe(incidentSourceKey(disk.message));
});

it('adopts a legacy load group for a canonical CPU event', async () => {
  const f = await fixture();
  const session: AgentSession = {id: 'ses_legacy_load', harness: 'opencode', cwd: '/workspace', title: 'cpu repair', status: 'running', lastActivity: '', needsPermission: false};
  f.sessions.set(session.id, session);
  const source = createHash('sha256').update(JSON.stringify(['fleet-health', 'fleet-load', 'vusa', 'load'])).digest('hex');
  const oldKey = createHash('sha256').update(JSON.stringify(['opencode', '/workspace', source])).digest('hex');
  await writeFile(f.path, JSON.stringify({version: 1, groups: {[oldKey]: {sessionId: session.id}}}));
  const cpu = {...request('cpu'), message: request('cpu').message.replace('"signal_type":"load"', '"signal_type":"cpu"')};
  let resumed: string | undefined;
  const result = await f.router().run(cpu, async existing => {
    resumed = existing;
    return {ok: true, created: false, harness: 'opencode', cwd: '/workspace', name: 'cpu', sessionId: existing};
  });
  expect(incidentLegacySourceKeys(cpu.message)).toContain(source);
  expect(resumed).toBe(session.id);
  expect(result.sessionId).toBe(session.id);
  expect(result.coalesced).toBe(true);
  expect(f.count()).toBe(0);
});

it('uses the matching active session when old CPU aliases have held duplicates', async () => {
  const f = await fixture();
  const active: AgentSession = {id: 'ses_vusa_active', harness: 'opencode', cwd: '/workspace', title: 'cpu repair', status: 'running', lastActivity: '', needsPermission: false};
  const heldA: AgentSession = {...active, id: 'ses_held_load', status: 'stopped'};
  const heldB: AgentSession = {...active, id: 'ses_held_cpu', status: 'stopped'};
  for (const session of [active, heldA, heldB]) f.sessions.set(session.id, session);
  const oldKeys = ['load', 'cpu'].map(signal => {
    const source = createHash('sha256').update(JSON.stringify(['fleet-health', 'fleet-load', 'vusa', signal])).digest('hex');
    return createHash('sha256').update(JSON.stringify(['opencode', '/workspace', source])).digest('hex');
  });
  await writeFile(f.path, JSON.stringify({version: 1, groups: {
    [oldKeys[0]!]: {sessionId: heldA.id},
    [oldKeys[1]!]: {sessionId: heldB.id},
  }}));
  const router = new IncidentSessionRouter(f.path, {
    readSession: async (_harness, id) => f.sessions.get(id) ?? null,
    unfinished: async session => session.status === 'running',
    held: async session => session.id !== active.id,
    findExisting: async () => active,
  });
  let resumed: string | undefined;
  const cpu = {...request('cpu'), message: request('cpu').message.replace('"signal_type":"load"', '"signal_type":"cpu"')};
  await router.run(cpu, async existing => {
    resumed = existing;
    return {ok: true, created: false, harness: 'opencode', cwd: '/workspace', name: 'cpu', sessionId: existing};
  });
  expect(resumed).toBe(active.id);
  expect(f.count()).toBe(0);
});

it('continues a finished attempt in its original session while the incident remains open', async () => {
  const f = await fixture();
  const first = await f.router().run(request('one'), f.launch('one'));
  const session = f.sessions.get(first.sessionId!)!;
  session.status = 'stopped';
  const router = new IncidentSessionRouter(f.path, {
    readSession: async () => session,
    unfinished: async () => false,
    boundIncidentOpen: async () => true,
    continuationReady: async () => true,
  });
  let resumed: string | undefined;
  const next = await router.run(request('degraded-again'), async existing => {
    resumed = existing;
    return {ok: true, created: false, harness: 'opencode', cwd: '/workspace', name: 'resume', sessionId: existing};
  });
  expect(resumed).toBe(first.sessionId);
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.created).toBe(false);
  expect(f.count()).toBe(1);
});

it('retains the same native session when its latest episode closed but an authoritative sibling continuation exists', async () => {
  const f = await fixture();
  const first = await f.router().run(request('one'), f.launch('one'));
  const router = new IncidentSessionRouter(f.path, {
    readSession: async () => f.sessions.get(first.sessionId!)!,
    unfinished: async () => false,
    boundIncidentOpen: async () => false,
    continuationReady: async () => true,
  });
  const next = await router.run(request('sibling-degraded'), f.launch('sibling-degraded'));
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.created).toBe(false);
  expect(f.count()).toBe(1);
});

it('blocks a missing or closed bound session without creating a replacement', async () => {
  const f = await fixture();
  const first = await f.router().run(request('one'), f.launch('one'));
  const missing = new IncidentSessionRouter(f.path, {
    readSession: async () => null,
    unfinished: async () => false,
  });
  const absent = await missing.run(request('two'), f.launch('two'));
  expect(absent).toMatchObject({ok: false, created: false, delivery: 'not_attempted', sessionId: first.sessionId});
  expect(absent.error).toContain('недоступна');
  const closed = new IncidentSessionRouter(f.path, {
    readSession: async () => f.sessions.get(first.sessionId!)!,
    unfinished: async () => false,
    boundIncidentOpen: async () => false,
  });
  const nextIncident = await closed.run(request('three'), f.launch('three'));
  expect(nextIncident).toMatchObject({ok: true, created: true});
  expect(nextIncident.sessionId).not.toBe(first.sessionId);
  expect(f.count()).toBe(2);
});

it('does not reuse a stopped attempt without a durable continuation receipt', async () => {
  const f = await fixture();
  const first = await f.router().run(request('one'), f.launch('one'));
  f.sessions.get(first.sessionId!)!.status = 'stopped';
  const open = new IncidentSessionRouter(f.path, {
    readSession: async () => f.sessions.get(first.sessionId!)!,
    unfinished: async () => false,
    boundIncidentOpen: async () => true,
    continuationReady: async () => false,
  });
  const result = await open.run(request('two'), f.launch('two'));
  expect(result).toMatchObject({ok: false, created: false, delivery: 'not_attempted', sessionId: first.sessionId});
  expect(result.error).toContain('квитанция продолжения');
  expect(f.count()).toBe(1);
});

it('fences an unknown creation across restart instead of launching another session', async () => {
  const f = await fixture();
  await expect(f.router().run(request('one'), async () => {throw new Error('transport lost');})).rejects.toThrow('transport lost');
  const b = await f.router().run(request('two'), f.launch('two'));
  expect(b.admissionUnknown).toBe(true);
  expect(f.count()).toBe(0);
});

it('keeps an unknown resumed input fenced even when the native session ID is known', async () => {
  const f = await fixture();
  const first = await f.router().run(request('one'), f.launch('one'));
  const unknown = await f.router().run(request('two'), async () => ({
    ok: false, created: false, harness: 'opencode', cwd: '/workspace', name: 'two',
    sessionId: first.sessionId, admissionUnknown: true, nonRetryable: true, delivery: 'admission_unknown',
  }));
  expect(unknown.admissionUnknown).toBe(true);
  let launchedAgain = false;
  const retry = await f.router().run(request('three'), async () => {
    launchedAgain = true;
    return {ok: true, created: false, harness: 'opencode', cwd: '/workspace', name: 'three', sessionId: first.sessionId};
  });
  expect(retry.admissionUnknown).toBe(true);
  expect(launchedAgain).toBe(false);
  expect(f.count()).toBe(1);
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
