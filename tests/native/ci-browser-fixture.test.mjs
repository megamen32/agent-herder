import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig, parseProcStat, assertProcessBindings, deriveGeneration, findAnchor,
  browserArguments, browserEnvironment, assertManagedState, inspectAnchorScript, BrowserFixtureManager, assertRecoveryReady} from '../../deploy/fleet/ci-browser-fixture.mjs';

const sha = 'a'.repeat(64);
const config = () => ({schema: 'agent-herder.ci-browser-fixture.v1', runtime_uid: 1000, runtime_gid: 1000,
  owner_home: '/home/roomhacker', state_dir: '/var/lib/agent-herder-ci-smoke/browser-fixture',
  ui_url: 'https://agent.bezrabotnyi.com/',
  browser: {executable: '/owned/agent-browser', executable_sha256: sha, chrome_executable: '/owned/chrome',
    chrome_sha256: sha, profile_path: '/owned/ci-profile', extensions_path: '/owned/vibe-extension',
    session: 'herderci1109', namespace: 'herderci1109', idle_timeout_ms: 0},
  relay: {systemd_unit: 'agent-herder-ci-vibe.service', agent_port: 19898, extension_port: 19899,
    state_dir: '/owned/ci-relay', session_id: 'session_1', node_executable: '/owned/node', node_sha256: sha,
    script_path: '/owned/relay-daemon.js', script_sha256: sha}});
const processes = c => ({
  daemon: {pid: 10, ppid: 1, uid: 1000, start_ticks: '100', executable: '/owned/agent-browser', executable_sha256: sha,
    argv: ['/owned/agent-browser'], env: {AGENT_BROWSER_PROFILE: c.browser.profile_path,
      AGENT_BROWSER_EXTENSIONS: c.browser.extensions_path, AGENT_BROWSER_SESSION: c.browser.session,
      AGENT_BROWSER_NAMESPACE: c.browser.namespace, AGENT_BROWSER_IDLE_TIMEOUT_MS: '0'}},
  browser: {pid: 11, ppid: 10, uid: 1000, start_ticks: '110', executable: '/owned/chrome', executable_sha256: sha,
    argv: ['/owned/chrome', '--user-data-dir=' + c.browser.profile_path, '--load-extension=' + c.browser.extensions_path]},
  relay: {pid: 12, ppid: 1, uid: 1000, start_ticks: '90', executable: '/owned/node', executable_sha256: sha,
    argv: ['/owned/node', c.relay.script_path], env: {VIBE_MCP_AGENT_PORT: '19898', VIBE_MCP_EXTENSION_PORT: '19899',
      VIBE_MCP_STATE_DIR: c.relay.state_dir}, listening_ports: [19898, 19899], loopback_only: true},
});

test('config requires dedicated exact profile, relay, and reviewed URL', () => {
  assert.equal(validateConfig(config()).browser.idle_timeout_ms, 0);
  for (const mutate of [c => {c.relay.agent_port = 19888;}, c => {c.browser.namespace = 'default';},
    c => {c.browser.profile_path = '/home/roomhacker/.config/google-chrome';},
    c => {c.ui_url = 'http://example.com/';}, c => {c.ui_url = 'https://user:pass@example.com/';},
    c => {c.browser.idle_timeout_ms = 1800000;}]) {
    const c = config(); mutate(c); assert.throws(() => validateConfig(c));
  }
  const local = config(); local.ui_url = 'http://127.0.0.1:18798/'; assert.equal(validateConfig(local).ui_url, local.ui_url);
});

test('every CLI call pins all launch settings and clears external auto-attach selectors', () => {
  const c = config(), args = browserArguments(c, ['tab', 'list']);
  assert.deepEqual(args, ['--session', 'herderci1109', '--namespace', 'herderci1109', '--auto-connect', 'false',
    '--headed', 'false', '--idle-timeout', '0', 'tab', 'list', '--json']);
  const env = browserEnvironment(c, {AGENT_BROWSER_CDP: 'foreign', AGENT_BROWSER_AUTO_CONNECT: 'true', PATH: '/untrusted',
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'});
  assert.equal(env.AGENT_BROWSER_PROFILE, '/owned/ci-profile');
  assert.equal(env.AGENT_BROWSER_EXTENSIONS, '/owned/vibe-extension');
  assert.equal(env.AGENT_BROWSER_CDP, undefined);
  assert.equal(env.AGENT_BROWSER_AUTO_CONNECT, 'false');
  assert.equal(env.PATH, '/usr/bin:/bin');
  // Agent-browser resolves its namespace PID/socket directory from XDG_RUNTIME_DIR.
  // The manager pins the original HOME-scoped directory, so the child must not move it.
  assert.equal(env.XDG_RUNTIME_DIR, undefined);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test('proc stat handles names with spaces and parentheses', () => {
  const fields = ['S', '10', ...Array(17).fill('0'), '12345', '0'];
  assert.deepEqual(parseProcStat('11 (chrome ) worker) ' + fields.join(' ')), {ppid: 10, start_ticks: '12345'});
});

test('relay readiness waits for the strict process proof without launching a browser', async () => {
  const c = config(), manager = new BrowserFixtureManager(c, sha), expected = processes(c).relay;
  let reads = 0; manager.relayReadyPollMs = 1;
  manager.relay = async () => {if (++reads === 1) throw Object.assign(Error('not listening yet'), {code: 'fixture_relay_binding_mismatch'}); return expected;};
  manager.cli = async () => {assert.fail('readiness must not launch or attach to a browser');};
  assert.equal(await manager.waitRelay(), expected); assert.equal(reads, 2);
});

test('relay readiness fails within its bound and never returns an unverified process', async () => {
  const manager = new BrowserFixtureManager(config(), sha);
  manager.relayReadyTimeoutMs = 0; let reads = 0;
  manager.relay = async () => {reads++; throw Object.assign(Error('wrong relay'), {code: 'fixture_relay_binding_mismatch'});};
  manager.cli = async () => {assert.fail('failed readiness must not launch a browser');};
  await assert.rejects(manager.waitRelay(), {code: 'fixture_relay_binding_mismatch'}); assert.equal(reads, 1);
});

test('process proof rejects wrong profile, parent, uid, binary, idle timeout, relay environment and ports', () => {
  const c = config(); assert.doesNotThrow(() => assertProcessBindings(c, processes(c)));
  for (const mutate of [p => {p.browser.ppid = 90;}, p => {p.daemon.uid = 0;},
    p => {p.browser.argv[1] = '--user-data-dir=/personal';}, p => {p.daemon.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '1800000';},
    p => {p.relay.env.VIBE_MCP_AGENT_PORT = '19888';}, p => {p.browser.executable_sha256 = 'b'.repeat(64);},
    p => {p.relay.listening_ports = [19898];}, p => {p.relay.loopback_only = false;},
    p => {p.browser.argv.push('--load-extension=/personal');}]) {
    const p = processes(c); mutate(p); assert.throws(() => assertProcessBindings(c, p));
  }
});

test('generation binds boot, exact source config and all three process start times', () => {
  const c = config(), p = processes(c), original = deriveGeneration(sha, 'boot-1', p);
  const state = {schema: 'agent-herder.ci-browser-state.v1', config_sha256: sha, generation: original,
    anchor_marker: 'herder-ci-fixture-123e4567-e89b-42d3-a456-426614174000', processes: p, boot_id: 'boot-1'};
  assert.doesNotThrow(() => assertManagedState(state, sha, original));
  p.browser.start_ticks = '111'; assert.notEqual(deriveGeneration(sha, 'boot-1', p), original);
  assert.notEqual(deriveGeneration(sha, 'boot-2', processes(c)), original);
  assert.notEqual(deriveGeneration('b'.repeat(64), 'boot-1', processes(c)), original);
  assert.throws(() => assertManagedState(state, sha, deriveGeneration(sha, 'boot-1', p)));
});

test('anchor matching scans only own CLI tab handles and restores original selection', async () => {
  let active = 't1'; const calls = [];
  const cli = async args => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'list') return {tabs: [{tabId: 't1', active: true}, {tabId: 't2', active: false}]};
    if (args[0] === 'tab') {active = args[1]; return {};}
    return {result: active === 't2' ? {match: true, origin: 'https://agent.bezrabotnyi.com', authenticated: true, api_status: 200, content_type: 'application/json'} : {match: false}};
  };
  const result = await findAnchor(cli, 'herder-ci-anchor-123e4567-e89b-42d3-a456-426614174000', config().ui_url);
  assert.equal(result.cli_tab_id, 't2'); assert.equal(active, 't1');
  assert(calls.filter(x => x[0] === 'eval').every(x => !x[1].includes('document.cookie')));
});

test('ambiguous and missing anchors fail after restoring tab selection', async () => {
  for (const match of [false, true]) {
    let active = 't1';
    const cli = async args => {
      if (args[0] === 'tab' && args[1] === 'list') return {tabs: [{tabId: 't1', active: true}, {tabId: 't2'}]};
      if (args[0] === 'tab') {active = args[1]; return {};}
      return {result: {match, authenticated: true, api_status: 200, content_type: 'application/json', origin: 'https://agent.bezrabotnyi.com'}};
    };
    await assert.rejects(findAnchor(cli, 'marker', config().ui_url)); assert.equal(active, 't1');
  }
});

test('failed read and failed restore cannot produce PASS', async () => {
  let active = 't1'; const calls = [];
  const cli = async args => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'list') return {tabs: [{tabId: 't1', active: true}, {tabId: 't2'}]};
    if (args[0] === 'tab') {active = args[1]; return {};}
    if (active === 't2') throw Error('read failure');
    return {result: {match: false}};
  };
  await assert.rejects(findAnchor(cli, 'marker', config().ui_url)); assert.equal(active, 't1');
  assert.deepEqual(calls.at(-2), ['tab', 't1']);
});

function runAnchorProbe(fetch) {
  const marker = 'herder-ci-anchor-123e4567-e89b-42d3-a456-426614174000';
  const run = new Function('window', 'location', 'document', 'fetch', 'AbortSignal', 'return ' + inspectAnchorScript(marker, config().ui_url));
  return run({name: marker}, {origin: 'https://agent.bezrabotnyi.com', pathname: '/', search: ''},
    {querySelector: () => ({})}, fetch, {timeout: () => new AbortController().signal});
}

test('known JSON headers return without waiting for a body cancellation that never settles', async () => {
  let cancelled = false, timer;
  const probe = runAnchorProbe(async () => ({status: 200, headers: {get: () => 'application/json; charset=utf-8'},
    body: {cancel: () => {cancelled = true; return new Promise(() => {});}}}));
  try {
    const result = await Promise.race([probe, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('body cancellation blocked known headers')), 250);})]);
    assert.equal(cancelled, true); assert.equal(result.authenticated, true); assert.equal(result.api_status, 200);
    assert.equal(result.content_type, 'application/json; charset=utf-8');
  } finally {clearTimeout(timer);}
});

test('HTML responses and network timeouts cannot satisfy the UI API proof', async () => {
  const html = await runAnchorProbe(async () => ({status: 200, headers: {get: () => 'text/html'}, body: null}));
  assert.equal(html.authenticated, false); assert.equal(html.api_status, 200);
  const timeout = await runAnchorProbe(async () => {throw Object.assign(Error('bounded network timeout'), {name: 'TimeoutError'});});
  assert.equal(timeout.authenticated, false); assert.equal(timeout.api_status, 0); assert.equal(timeout.api_error, 'TimeoutError');
  const cli = async args => args[0] === 'tab' && args[1] === 'list' ? {tabs: [{tabId: 't1', active: true}]}
    : args[0] === 'tab' ? {} : {result: timeout};
  await assert.rejects(findAnchor(cli, 'marker', config().ui_url), {code: 'fixture_ui_api_unavailable'});
});

function stoppingManager() {
  const c = config(), p = processes(c), manager = new BrowserFixtureManager(c, sha);
  manager.locked = fn => fn();
  manager.generation = async value => deriveGeneration(sha, 'boot-1', value);
  manager.state = async () => ({schema: 'agent-herder.ci-browser-state.v1', config_sha256: sha,
    generation: deriveGeneration(sha, 'boot-1', p), processes: p, boot_id: 'boot-1',
    anchor_marker: 'herder-ci-fixture-123e4567-e89b-42d3-a456-426614174000'});
  manager.stopProcesses = async () => p;
  return manager;
}

test('a health tick defers a contended probe and validates the next available generation', async () => {
  const manager = stoppingManager(); let attempts = 0, processReads = 0;
  manager.locked = async operation => {if (++attempts === 1) throw Object.assign(Error('probe in progress'), {code: 'ELOCKED'}); return operation();};
  manager.processes = async () => {processReads++; return processes(manager.config);};
  manager.cli = async () => {assert.fail('health contention must not launch or close the browser');};
  assert.equal(await manager.healthCheck(), false); assert.equal(processReads, 0);
  assert.equal(await manager.healthCheck(), true); assert.equal(processReads, 1);
});

test('health deferral does not swallow compromised locks or a real generation failure', async () => {
  const compromised = stoppingManager();
  compromised.locked = async () => {throw Object.assign(Error('compromised'), {code: 'ECOMPROMISED'});};
  await assert.rejects(compromised.healthCheck(), {code: 'ECOMPROMISED'});
  const changed = stoppingManager();
  changed.processes = async () => {const p = processes(changed.config); p.browser.start_ticks = '111'; return p;};
  await assert.rejects(changed.healthCheck(), {code: 'managed_fixture_generation_mismatch'});
});
test('UNKNOWN close is reconciled once, with no replay and only exact owned session', async () => {
  const manager = stoppingManager(), calls = []; let removed = false;
  manager.cli = async args => {calls.push(args); throw Error('accepted then timeout');};
  manager.sameProcess = async () => false;
  manager.removeState = async () => {removed = true;};
  const result = await manager.stop();
  assert.equal(result.status, 'STOPPED'); assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [['close']]); assert.equal(removed, true);
});
test('unconfirmed cleanup retains durable state and never retries close', async () => {
  const manager = stoppingManager(), calls = []; let removed = false;
  manager.stopTimeoutMs = 0;
  manager.cli = async args => {calls.push(args); return {closed: true};};
  manager.sameProcess = async () => true;
  manager.removeState = async () => {removed = true;};
  await assert.rejects(manager.stop(), /fixture_stop_outcome_unknown/);
  assert.deepEqual(calls, [['close']]); assert.equal(removed, false);
});
test('orphan browser cannot trigger a new daemon or an unbound close', async () => {
  const manager = stoppingManager(), calls = [];
  manager.stopProcesses = async () => ({daemon: null, browser: {pid: 11}});
  manager.cli = async args => {calls.push(args); return {};};
  await assert.rejects(manager.stop(), /orphan_requires_reconciliation/);
  assert.deepEqual(calls, []);
});

test('fixed inspection bounds auth GET and never includes caller JavaScript or session body', () => {
  const script = inspectAnchorScript('marker', config().ui_url);
  assert.match(script, /AbortSignal.timeout\(20000\)/);
  assert.match(script, /response.body\?\.cancel/);
  assert.doesNotMatch(script, /response\.json|document\.cookie|localStorage|sessionStorage/);
});

test('restore acknowledgement alone cannot hide a changed selected tab', async () => {
  let lists = 0;
  const cli = async args => {
    if (args[0] === 'tab' && args[1] === 'list') {
      lists++;
      return {tabs: [{tabId: 't1', active: lists === 1}, {tabId: 't2', active: lists > 1}]};
    }
    if (args[0] === 'eval') return {result: {match: false}};
    return {};
  };
  await assert.rejects(findAnchor(cli, 'marker', config().ui_url), /selection_restore_unconfirmed/);
});

test('a modified stored process tuple is rejected even with an unchanged generation label', () => {
  const p = processes(config()), generation = deriveGeneration(sha, 'boot-1', p);
  const state = {schema: 'agent-herder.ci-browser-state.v1', config_sha256: sha, generation,
    anchor_marker: 'herder-ci-fixture-123e4567-e89b-42d3-a456-426614174000', processes: structuredClone(p), boot_id: 'boot-1'};
  state.processes.browser.pid = 88;
  assert.throws(() => assertManagedState(state, sha, generation, p), /state_process_mismatch/);
});

test('crash and reboot recovery require proven disappearance plus a valid dedicated relay', async () => {
  const state = await stoppingManager().state();
  const observed = {old_daemon_same: false, old_browser_same: false, namespace_daemon_live: false, profile_roots: 0, relay_verified: true};
  assert.doesNotThrow(() => assertRecoveryReady(state, sha, 'boot-1', observed));
  assert.doesNotThrow(() => assertRecoveryReady(state, sha, 'boot-2', observed));
  for (const [key, value] of [['old_daemon_same', true], ['old_browser_same', true], ['old_daemon_same', undefined],
    ['namespace_daemon_live', true], ['profile_roots', 1], ['relay_verified', false]]) {
    assert.throws(() => assertRecoveryReady(state, sha, 'boot-1', {...observed, [key]: value}));
  }
  assert.throws(() => assertRecoveryReady(state, 'b'.repeat(64), 'boot-1', observed));
  assert.throws(() => assertRecoveryReady({...state, generation: 'b'.repeat(64)}, sha, 'boot-1', observed));
});

test('a healthy existing generation resumes without open or close effects', async () => {
  const manager = stoppingManager(), calls = [];
  manager.processes = async () => processes(config());
  manager.reconcileCompletedStart = async () => {calls.push('reconcile');};
  manager.cli = async args => {calls.push(args); return {};};
  const result = await manager.start();
  assert.equal(result.resumed, true); assert.deepEqual(calls, ['reconcile']);
});

test('failed recovery cannot reach a browser launch or erase the prior state', async () => {
  const manager = stoppingManager(), calls = [];
  manager.processes = async () => {throw Error('relay generation changed');};
  manager.prepareOwnedRecovery = async () => {calls.push('recovery-check'); throw Error('old browser is still live');};
  manager.cli = async args => {calls.push(args); return {};};
  await assert.rejects(manager.start(), /old browser is still live/);
  assert.deepEqual(calls, ['recovery-check']);
});
