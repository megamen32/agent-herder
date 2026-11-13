#!/usr/bin/env node
/** Managed, isolated Herder UI browser. This module never logs page text or credentials. */
import {readFile, open, lstat, stat, readlink, readdir, rename, unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const exec = promisify(execFile);
const CONFIG_PATH = '/etc/agent-herder-ci-smoke/browser-fixture.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => {throw Object.assign(new Error(code), {code});};
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
const absolute = value => text(value) && isAbsolute(value) && !value.split('/').includes('..');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileHashes = new Map();
async function hashFile(path) {
  const before = await stat(path), key = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':');
  if (fileHashes.has(key)) return fileHashes.get(key);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const after = await stat(path);
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== key) fail('fixture_executable_changed_during_read');
  const value = hash.digest('hex'); if (fileHashes.size >= 32) fileHashes.clear(); fileHashes.set(key, value); return value;
}
async function syncDirectory(path) {
  const directory = await open(path, 'r'); try {await directory.sync();} finally {await directory.close();}
}
async function durableWrite(path, value) {
  const file = await open(path, 'wx', 0o600);
  try {await file.writeFile(value); await file.sync();} finally {await file.close();}
  await syncDirectory(dirname(path));
}
async function durableRename(from, to) {await rename(from, to); await syncDirectory(dirname(to));}
async function durableUnlink(path) {await unlink(path); await syncDirectory(dirname(path));}

export function browserExtensionPaths(c) {
  return [c.browser.extensions_path, ...(c.browser.extra_extension_paths ?? [])];
}

export function validateConfig(c) {
  if (c?.schema !== 'agent-herder.ci-browser-fixture.v1' || !positive(c.runtime_uid) || !positive(c.runtime_gid)
      || !absolute(c.owner_home) || !absolute(c.state_dir) || !c.state_dir.startsWith('/var/lib/agent-herder-ci-smoke/')) fail('fixture_config_invalid');
  const b = c.browser, r = c.relay;
  if (!b || !r || !['executable', 'chrome_executable', 'profile_path', 'extensions_path'].every(k => absolute(b[k]))
      || !digest(b.executable_sha256) || !digest(b.chrome_sha256)
      || !/^ci-[a-zA-Z0-9_.-]+$/.test(basename(b.profile_path))
      || !/^herderci[a-zA-Z0-9_-]*$/.test(b.session) || !/^herderci[a-zA-Z0-9_-]*$/.test(b.namespace)
      || b.idle_timeout_ms !== 0) fail('dedicated_browser_config_required');
  if (b.extra_extension_paths !== undefined && !Array.isArray(b.extra_extension_paths)) fail('dedicated_browser_extensions_required');
  const extensionPaths = browserExtensionPaths(c);
  if (extensionPaths.some(value => !absolute(value) || value.includes(','))
      || new Set(extensionPaths).size !== extensionPaths.length) fail('dedicated_browser_extensions_required');
  if (r.systemd_unit !== 'agent-herder-ci-vibe.service'
      || !Number.isInteger(r.agent_port) || r.agent_port < 1024 || r.agent_port > 65534 || r.agent_port === 19888
      || r.extension_port !== r.agent_port + 1 || !/^session_[1-9][0-9]*$/.test(r.session_id)
      || !['state_dir', 'node_executable', 'script_path'].every(k => absolute(r[k]))
      || !/^ci-[a-zA-Z0-9_.-]+$/.test(basename(r.state_dir))
      || !digest(r.node_sha256) || !digest(r.script_sha256)) fail('dedicated_relay_config_required');
  let url;
  try {if (!text(c.ui_url)) fail('fixed_ui_url_required'); url = new URL(c.ui_url);} catch {fail('fixed_ui_url_required');}
  if (url.username || url.password || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port))) fail('fixed_ui_url_required');
  if (c.bootstrap) {
    const x = c.bootstrap;
    if (x.relay_systemd_unit !== 'agent-herder-ci-vibe-bootstrap.service' || x.idle_timeout_ms !== 1800000
        || !positive(x.page_id) || !uuid(x.nonce)
        || !['daemon', 'browser', 'relay'].every(k => positive(x[k]?.pid) && /^[0-9]+$/.test(x[k]?.start_ticks))) fail('bootstrap_identity_required');
  }
  return c;
}

export function browserArguments(c, args, idle = c.browser.idle_timeout_ms) {
  return ['--session', c.browser.session, '--namespace', c.browser.namespace, '--auto-connect', 'false',
    '--headed', 'false', '--idle-timeout', String(idle), ...args, '--json'];
}
export function browserEnvironment(c, _inherited = {}) {
  // Do not inherit CDP, profile, proxy, remote-debugging or credential selectors.
  // Keep the CLI's runtime sockets under HOME/.agent-browser, as daemonPidFile
  // and the original isolated namespace require. XDG_RUNTIME_DIR relocates them.
  return {HOME: c.owner_home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    AGENT_BROWSER_PROFILE: c.browser.profile_path, AGENT_BROWSER_EXTENSIONS: browserExtensionPaths(c).join(','),
    AGENT_BROWSER_SESSION: c.browser.session, AGENT_BROWSER_NAMESPACE: c.browser.namespace,
    AGENT_BROWSER_AUTO_CONNECT: 'false', AGENT_BROWSER_HEADED: 'false', AGENT_BROWSER_IDLE_TIMEOUT_MS: String(c.browser.idle_timeout_ms)};
}

export function parseProcStat(value) {
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!positive(Number(fields[1])) || !/^[0-9]+$/.test(fields[19] || '')) fail('process_stat_invalid');
  return {ppid: Number(fields[1]), start_ticks: fields[19]};
}
async function processInfo(pid, withEnv = false) {
  if (!positive(pid)) fail('process_missing');
  const root = '/proc/' + pid;
  const [info, status, raw, executable, executableHash] = await Promise.all([
    readFile(root + '/stat', 'utf8'), stat(root), readFile(root + '/cmdline'), readlink(root + '/exe'), hashFile(root + '/exe'),
  ]);
  const result = {pid, ...parseProcStat(info), uid: status.uid, executable,
    executable_sha256: executableHash, argv: raw.toString().split('\0').filter(Boolean)};
  if (withEnv) result.env = Object.fromEntries((await readFile(root + '/environ', 'utf8')).split('\0')
    .filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  return result;
}
function argumentValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) values.push(argv[i + 1]);
    if (argv[i].startsWith(flag + '=')) values.push(argv[i].slice(flag.length + 1));
  }
  return values;
}
function assertOwner(c, process) {
  if (!positive(process?.pid) || process.uid !== c.runtime_uid || !/^[0-9]+$/.test(process.start_ticks || '')) fail('fixture_process_owner_mismatch');
}
function assertDaemon(c, process, idle) {
  assertOwner(c, process);
  const b = c.browser, denv = process.env || {};
  if (process.executable_sha256 !== b.executable_sha256) fail('fixture_process_binding_mismatch');
  if (denv.AGENT_BROWSER_PROFILE !== b.profile_path || denv.AGENT_BROWSER_EXTENSIONS !== browserExtensionPaths(c).join(',')
      || denv.AGENT_BROWSER_SESSION !== b.session || denv.AGENT_BROWSER_NAMESPACE !== b.namespace
      || denv.AGENT_BROWSER_IDLE_TIMEOUT_MS !== String(idle)) fail('fixture_daemon_environment_mismatch');
}
function assertBrowser(c, process, daemonPid) {
  assertOwner(c, process);
  const b = c.browser;
  if (process.executable_sha256 !== b.chrome_sha256 || process.ppid !== daemonPid) fail('fixture_process_binding_mismatch');
  const profiles = argumentValues(process.argv, '--user-data-dir');
  const extensions = argumentValues(process.argv, '--load-extension').flatMap(x => String(x).split(','));
  const expectedExtensions = browserExtensionPaths(c);
  if (profiles.length !== 1 || profiles[0] !== b.profile_path
      || extensions.length !== expectedExtensions.length || new Set(extensions).size !== extensions.length
      || extensions.some(x => !expectedExtensions.includes(x)) || argumentValues(process.argv, '--type').length) fail('fixture_browser_profile_mismatch');
}
export function assertProcessBindings(c, p, idle = 0) {
  assertDaemon(c, p.daemon, idle); assertBrowser(c, p.browser, p.daemon.pid); assertRelay(c, p.relay);
}
function assertRelay(c, relay) {
  const r = c.relay; assertOwner(c, relay);
  if (relay.executable_sha256 !== r.node_sha256) fail('fixture_process_binding_mismatch');
  const env = relay.env || {};
  if (!relay.argv.includes(r.script_path) || env.VIBE_MCP_AGENT_PORT !== String(r.agent_port)
      || env.VIBE_MCP_EXTENSION_PORT !== String(r.extension_port) || env.VIBE_MCP_STATE_DIR !== r.state_dir
      || (env.VIBE_MCP_PID_FILE && env.VIBE_MCP_PID_FILE !== join(r.state_dir, 'vibebrowser-relay.pid'))
      || env.VIBE_REMOTE_URL || env.VIBE_EXTENSION_UUID || env.VIBE_RELAY_UUID
      || !relay.listening_ports?.includes(r.agent_port) || !relay.listening_ports?.includes(r.extension_port)
      || relay.loopback_only !== true) fail('fixture_relay_binding_mismatch');
}
export function deriveGeneration(configSha, bootId, p) {
  return sha(JSON.stringify([configSha, bootId, ...['daemon', 'browser', 'relay'].map(k => [p[k].pid, p[k].start_ticks])]));
}
export function assertManagedState(state, configSha, generation, currentProcesses) {
  if (state?.schema !== 'agent-herder.ci-browser-state.v1' || state.config_sha256 !== configSha
      || state.generation !== generation || !/^herder-ci-fixture-[a-f0-9-]{36}$/.test(state.anchor_marker || '')
      || !text(state.boot_id)
      || !['daemon', 'browser', 'relay'].every(k => positive(state.processes?.[k]?.pid)
        && /^[0-9]+$/.test(state.processes?.[k]?.start_ticks || ''))) fail('managed_fixture_generation_mismatch');
  if (currentProcesses && !['daemon', 'browser', 'relay'].every(k => currentProcesses[k].pid === state.processes[k].pid
      && currentProcesses[k].start_ticks === state.processes[k].start_ticks)) fail('managed_fixture_state_process_mismatch');
}
export function assertRecoveryReady(state, configSha, currentBoot, observed) {
  if (!text(currentBoot)) fail('fixture_boot_identity_missing');
  assertManagedState(state, configSha, deriveGeneration(configSha, state.boot_id, state.processes));
  if (observed.old_daemon_same === true || observed.old_browser_same === true) fail('managed_fixture_process_still_live');
  if (observed.old_daemon_same !== false || observed.old_browser_same !== false) fail('managed_fixture_death_unconfirmed');
  if (observed.namespace_daemon_live !== false || observed.profile_roots !== 0) fail('unmanaged_fixture_present');
  if (observed.relay_verified !== true) fail('managed_relay_missing');
}

export function inspectAnchorScript(marker, uiUrl) {
  return `(async()=>{const marker=${JSON.stringify(marker)},expected=new URL(${JSON.stringify(uiUrl)});
    if(window.name!==marker||location.origin!==expected.origin||location.pathname!==expected.pathname||location.search!==expected.search)return {match:false};
    const herder=Boolean(document.querySelector('#herder-chat-list'));
    if(!herder)return {match:true,origin:location.origin,authenticated:false,api_status:0};
    try{const response=await fetch(new URL('/api/sessions',expected.origin),{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(20000)});
      const status=response.status,content_type=response.headers.get('content-type')||'';
      const json=content_type.split(';',1)[0].trim().toLowerCase()==='application/json';
      try{void response.body?.cancel().catch(()=>{});}catch{}
      return {match:true,origin:location.origin,authenticated:status===200&&json,api_status:status,content_type};
    }catch(error){return {match:true,origin:location.origin,authenticated:false,api_status:0,
      api_error:['AbortError','TimeoutError'].includes(error?.name)?error.name:'NetworkError'};}})()`;
}
export async function findAnchor(cli, marker, uiUrl) {
  const listed = await cli(['tab', 'list']);
  const tabs = listed.tabs;
  if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > 32
      || tabs.some(t => !/^t[1-9][0-9]*$/.test(t.tabId))) fail('fixture_tab_catalog_invalid');
  const selected = tabs.filter(t => t.active === true);
  if (selected.length !== 1) fail('fixture_selected_tab_ambiguous');
  const original = selected[0].tabId, matches = [];
  let readError; const deadline = Date.now() + 20000;
  try {
    for (const tab of tabs) {
      if (Date.now() > deadline) fail('fixture_anchor_scan_timeout');
      await cli(['tab', tab.tabId]);
      const value = (await cli(['eval', inspectAnchorScript(marker, uiUrl)])).result;
      if (value?.match === true) matches.push({...value, cli_tab_id: tab.tabId});
    }
  } catch (error) {readError = error;}
  try {
    await cli(['tab', original]);
    const restored = (await cli(['tab', 'list'])).tabs?.filter(t => t.active === true);
    if (restored?.length !== 1 || restored[0].tabId !== original) fail('fixture_selection_restore_unconfirmed');
  } catch {fail('fixture_selection_restore_unconfirmed');}
  if (readError) throw readError;
  if (matches.length !== 1) fail('fixture_anchor_not_unique');
  const result = matches[0];
  if (result.api_error) fail('fixture_ui_api_unavailable');
  if (result.api_status === 200 && String(result.content_type || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') fail('fixture_ui_api_content_type_invalid');
  if (result.origin !== new URL(uiUrl).origin || result.authenticated !== true || result.api_status !== 200) fail('fixture_ui_authentication_missing');
  return result;
}

async function privateFile(path, uid, modeMask) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & modeMask)) fail('protected_fixture_file_required');
  return readFile(path);
}
export async function loadConfig(path = CONFIG_PATH) {
  if (path !== CONFIG_PATH) fail('fixed_fixture_config_path_required');
  for (let p = dirname(path); p !== '/'; p = dirname(p)) {
    const info = await lstat(p);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) fail('protected_fixture_parent_required');
  }
  const info = await lstat(path), raw = await privateFile(path, 0, 0o037);
  const config = validateConfig(JSON.parse(raw));
  if (info.gid !== config.runtime_gid || process.getuid?.() !== config.runtime_uid) fail('fixture_runtime_principal_mismatch');
  const state = await lstat(config.state_dir);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== config.runtime_uid || (state.mode & 0o077)) fail('protected_fixture_state_required');
  for (const path of [config.browser.profile_path, config.relay.state_dir]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== config.runtime_uid || (info.mode & 0o077)) fail('private_fixture_directory_required');
  }
  for (const [path, expected] of [[config.browser.executable, config.browser.executable_sha256],
    [config.browser.chrome_executable, config.browser.chrome_sha256], [config.relay.node_executable, config.relay.node_sha256],
    [config.relay.script_path, config.relay.script_sha256]]) {
    if (await hashFile(path) !== expected) fail('fixture_executable_digest_mismatch');
  }
  return {config, configSha: sha(raw)};
}

async function relaySockets(pid, ports) {
  const sockets = new Set();
  for (const name of await readdir('/proc/' + pid + '/fd')) {
    try {const link = await readlink('/proc/' + pid + '/fd/' + name); const match = /^socket:\[([0-9]+)\]$/.exec(link); if (match) sockets.add(match[1]);} catch {}
  }
  const found = [], addresses = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (await readFile(file, 'utf8')).trim().split('\n').slice(1)) {
      const f = line.trim().split(/\s+/), [address, portHex] = f[1].split(':'), port = parseInt(portHex, 16);
      if (f[3] === '0A' && sockets.has(f[9]) && ports.includes(port)) {found.push(port); addresses.push(address);}
    }
  }
  return {listening_ports: found, loopback_only: addresses.length >= 2 && addresses.every(x => x === '0100007F' || x === '00000000000000000000000001000000')};
}
async function browserRoots(c) {
  const roots = [];
  for (const item of await readdir('/proc')) {
    if (!/^[1-9][0-9]*$/.test(item)) continue;
    try {
      const info = await stat('/proc/' + item); if (info.uid !== c.runtime_uid) continue;
      const argv = (await readFile('/proc/' + item + '/cmdline', 'utf8')).split('\0').filter(Boolean);
      if (argumentValues(argv, '--user-data-dir').includes(c.browser.profile_path) && !argumentValues(argv, '--type').length)
        roots.push(await processInfo(Number(item)));
    } catch (error) {if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;}
  }
  return roots;
}
function daemonPidFile(c) {return join(c.owner_home, '.agent-browser/namespaces', c.browser.namespace, 'run', c.browser.session + '.pid');}
async function readPid(path) {
  const value = Number((await readFile(path, 'utf8')).trim()); if (!positive(value)) fail('fixture_pid_invalid'); return value;
}
async function stillSameProcess(identity) {
  try {return parseProcStat(await readFile('/proc/' + identity.pid + '/stat', 'utf8')).start_ticks === identity.start_ticks;}
  catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error;}
}

export class BrowserFixtureManager {
  constructor(config, configSha) {
    this.config = validateConfig(config); this.configSha = configSha; this.stopTimeoutMs = 15000;
    this.relayReadyTimeoutMs = 10000; this.relayReadyPollMs = 100;
  }
  async locked(operation) {
    const {default: lockfile} = await import('proper-lockfile');
    const release = await lockfile.lock(this.config.state_dir, {realpath: true, stale: 120000, update: 2000,
      retries: {retries: 40, factor: 1, minTimeout: 100, maxTimeout: 100}});
    try {return await operation();} finally {await release();}
  }
  async cli(args, idle = 0) {
    const c = this.config, env = browserEnvironment(c); env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(idle);
    let value;
    try {
      const result = await exec(c.browser.executable, browserArguments(c, args, idle), {env, cwd: c.owner_home,
        timeout: args[0] === 'open' ? 30000 : args[0] === 'eval' ? 25000 : 6000, maxBuffer: 262144});
      value = JSON.parse(result.stdout);
    } catch {fail('fixture_cli_outcome_unknown');}
    if (value?.success !== true) fail('fixture_cli_failed');
    const data = value.data;
    if (!data || typeof data !== 'object') fail('fixture_cli_receipt_invalid');
    // Reads and tab selection must not reconfigure, restart or launch a browser.
    if (args[0] !== 'open' && ['launched', 'relaunchedBrowser', 'restartedBackground'].some(k => data.lifecycle?.[k] === true)) fail('fixture_cli_unexpected_relaunch');
    return data;
  }
  async relay(bootstrap = false) {
    const c = this.config;
    const unit = bootstrap ? c.bootstrap?.relay_systemd_unit : c.relay.systemd_unit;
    if (!unit) fail('bootstrap_identity_required');
    let relayPid;
    try {relayPid = Number((await exec('/bin/systemctl', ['show', '--property=MainPID', '--value', unit],
      {env: browserEnvironment(c), timeout: 5000, maxBuffer: 4096})).stdout.trim());} catch {fail('managed_relay_missing');}
    if (relayPid !== await readPid(join(c.relay.state_dir, 'vibebrowser-relay.pid'))) fail('relay_pidfile_binding_mismatch');
    const relay = {...await processInfo(relayPid, true), ...await relaySockets(relayPid, [c.relay.agent_port, c.relay.extension_port])};
    const ticks = Number((await exec('/usr/bin/getconf', ['CLK_TCK'], {timeout: 5000, maxBuffer: 4096})).stdout.trim());
    const boot = Number((await readFile('/proc/stat', 'utf8')).match(/^btime ([0-9]+)$/m)?.[1]);
    if (!(ticks > 0) || !(boot > 0) || (await stat(c.relay.script_path)).mtimeMs > (boot + Number(relay.start_ticks) / ticks) * 1000 + 1000)
      fail('relay_script_changed_after_start');
    assertRelay(c, relay); return relay;
  }
  async processes(bootstrap = false) {
    const c = this.config, pid = await readPid(daemonPidFile(c));
    const daemon = await processInfo(pid, true), browsers = await browserRoots(c);
    if (browsers.length !== 1) fail('fixture_browser_process_ambiguous');
    const relay = await this.relay(bootstrap);
    const p = {daemon, browser: browsers[0], relay};
    assertProcessBindings(c, p, bootstrap ? c.bootstrap.idle_timeout_ms : 0);
    if (bootstrap && !['daemon', 'browser', 'relay'].every(k => p[k].pid === c.bootstrap[k].pid && p[k].start_ticks === c.bootstrap[k].start_ticks)) fail('bootstrap_process_changed');
    return p;
  }
  async waitRelay() {
    const deadline = Date.now() + this.relayReadyTimeoutMs;
    for (;;) {
      try {return await this.relay();}
      catch (error) {if (Date.now() >= deadline) throw error;}
      await sleep(this.relayReadyPollMs);
    }
  }
  async bootId() {return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();}
  async generation(p) {return deriveGeneration(this.configSha, await this.bootId(), p);}
  async state() {return JSON.parse(await privateFile(join(this.config.state_dir, 'state.json'), this.config.runtime_uid, 0o077));}
  async writeState(value) {
    const path = join(this.config.state_dir, 'state.json'), temporary = path + '.' + randomUUID();
    await durableWrite(temporary, JSON.stringify(value) + '\n'); await durableRename(temporary, path);
  }
  receipt(p, generation, anchor, extra = {}) {
    const c = this.config;
    return {schema: 'agent-herder.ci-browser-proof.v1', status: 'PASS', managed: true,
      profile_path: c.browser.profile_path, namespace: c.browser.namespace, session: c.browser.session,
      config_sha256: this.configSha, generation, daemon_pid: p.daemon.pid, daemon_start_ticks: p.daemon.start_ticks,
      browser_pid: p.browser.pid, browser_start_ticks: p.browser.start_ticks,
      relay_pid: p.relay.pid, relay_start_ticks: p.relay.start_ticks,
      relay: {agent_port: c.relay.agent_port, extension_port: c.relay.extension_port, state_dir: c.relay.state_dir, session_id: c.relay.session_id},
      authenticated: anchor.authenticated, api_status: anchor.api_status, api_content_type: anchor.content_type,
      origin: anchor.origin, cli_tab_id: anchor.cli_tab_id,
      vibe_page_correlated: false,
      observed_at: new Date().toISOString(), ...extra};
  }
  async verify(pageId, nonce) {
    return this.locked(async () => {
      const state = await this.state(), p = await this.processes(), generation = await this.generation(p);
      assertManagedState(state, this.configSha, generation, p);
      const info = await this.cli(['session', 'info']);
      if (info.active !== true || info.pid !== p.daemon.pid || info.session !== this.config.browser.session
          || info.namespace !== this.config.browser.namespace) fail('fixture_cli_process_mismatch');
      const marker = nonce === undefined ? state.anchor_marker : 'herder-ci-anchor-' + nonce;
      if (nonce !== undefined && (!uuid(nonce) || !positive(pageId))) fail('owned_page_attestation_identity_invalid');
      const anchor = await findAnchor(args => this.cli(args), marker, this.config.ui_url);
      const after = await this.processes();
      if (await this.generation(after) !== generation) fail('fixture_process_changed_during_read');
      return this.receipt(after, generation, anchor, nonce === undefined ? {} : {page_id: pageId, marker, vibe_page_correlated: true});
    });
  }
  async bootstrapAttest(pageId, nonce) {
    return this.locked(async () => {
      const c = this.config;
      if (!c.bootstrap || pageId !== c.bootstrap.page_id || nonce !== c.bootstrap.nonce) fail('bootstrap_anchor_changed');
      const p = await this.processes(true), generation = await this.generation(p);
      const anchor = await findAnchor(args => this.cli(args, c.bootstrap.idle_timeout_ms), 'herder-ci-anchor-' + nonce, c.ui_url);
      if (await this.generation(await this.processes(true)) !== generation) fail('bootstrap_process_changed');
      return this.receipt(p, generation, anchor, {managed: false, page_id: pageId, marker: 'herder-ci-anchor-' + nonce, bootstrap_only: true, vibe_page_correlated: true});
    });
  }
  async namespaceDaemonLive() {
    try {await stat('/proc/' + await readPid(daemonPidFile(this.config))); return true;}
    catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error;}
  }
  async startIntent(state) {
    let intent;
    try {intent = JSON.parse(await privateFile(join(this.config.state_dir, 'start-intent.json'), this.config.runtime_uid, 0o077));}
    catch (error) {if (error.code === 'ENOENT') return null; throw error;}
    if (intent.schema !== 'agent-herder.ci-browser-start.v1' || intent.config_sha256 !== this.configSha
        || intent.marker !== state.anchor_marker) fail('unreconciled_fixture_start_intent');
    return intent;
  }
  async reconcileCompletedStart(state) {
    if (await this.startIntent(state)) await durableUnlink(join(this.config.state_dir, 'start-intent.json'));
  }
  async prepareOwnedRecovery(state) {
    const currentBoot = await this.bootId();
    assertManagedState(state, this.configSha, deriveGeneration(this.configSha, state.boot_id, state.processes));
    const observed = {
      old_daemon_same: state.boot_id === currentBoot && await this.sameProcess(state.processes.daemon),
      old_browser_same: state.boot_id === currentBoot && await this.sameProcess(state.processes.browser),
      namespace_daemon_live: await this.namespaceDaemonLive(), profile_roots: (await browserRoots(this.config)).length,
      relay_verified: false,
    };
    const relay = await this.relay(); observed.relay_verified = true;
    assertRecoveryReady(state, this.configSha, currentBoot, observed);
    const intent = await this.startIntent(state), suffix = randomUUID();
    const receipt = {schema: 'agent-herder.ci-browser-recovery.v1', observed_at: new Date().toISOString(),
      config_sha256: this.configSha, previous_generation: state.generation, previous_boot_id: state.boot_id,
      current_boot_id: currentBoot, observed, relay: {pid: relay.pid, start_ticks: relay.start_ticks},
      outcome: 'old_processes_gone_no_unmanaged_fixture'};
    await durableWrite(join(this.config.state_dir, 'recovery.' + suffix + '.json'), JSON.stringify(receipt) + '\n');
    // Archival happens only after all ownership and absence checks have passed.
    if (intent) await durableRename(join(this.config.state_dir, 'start-intent.json'), join(this.config.state_dir, 'start-intent.recovered.' + suffix + '.json'));
    await durableRename(join(this.config.state_dir, 'state.json'), join(this.config.state_dir, 'state.recovered.' + suffix + '.json'));
    return receipt;
  }
  async start() {
    return this.locked(async () => {
      let prior;
      try {prior = await this.state();} catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (prior) {
        let verified = false;
        try {const p = await this.processes(); assertManagedState(prior, this.configSha, await this.generation(p), p); verified = true;} catch {}
        if (verified) {
          await this.reconcileCompletedStart(prior);
          return {status: 'RUNNING', generation: prior.generation, resumed: true};
        }
        await this.prepareOwnedRecovery(prior);
      }
      // Never change launch settings on a pre-existing unmanaged session.
      if (await this.namespaceDaemonLive()) fail('unmanaged_fixture_present');
      if ((await browserRoots(this.config)).length) fail('unmanaged_fixture_browser_present');
      await this.relay();
      const intentPath = join(this.config.state_dir, 'start-intent.json');
      const marker = 'herder-ci-fixture-' + randomUUID();
      await durableWrite(intentPath, JSON.stringify({schema: 'agent-herder.ci-browser-start.v1', config_sha256: this.configSha,
        marker, started_at: new Date().toISOString()}) + '\n');
      // An interrupted start leaves its intent for reconciliation. It is never blindly replayed.
      await this.cli(['open', this.config.ui_url]);
      const p = await this.processes(), generation = await this.generation(p);
      const info = await this.cli(['session', 'info']);
      if (info.pid !== p.daemon.pid || info.namespace !== this.config.browser.namespace || info.session !== this.config.browser.session) fail('fixture_start_process_mismatch');
      const result = await this.cli(['eval', `(window.name=${JSON.stringify(marker)},window.name)`]);
      if (result.result !== marker) fail('fixture_anchor_creation_unconfirmed');
      await this.writeState({schema: 'agent-herder.ci-browser-state.v1', config_sha256: this.configSha, generation,
        anchor_marker: marker, started_at: new Date().toISOString(), boot_id: await this.bootId(),
        processes: Object.fromEntries(['daemon', 'browser', 'relay'].map(k => [k, {pid: p[k].pid, start_ticks: p[k].start_ticks}]))});
      await durableUnlink(intentPath);
      return {status: 'RUNNING', generation, resumed: false};
    });
  }
  async stopProcesses(state) {
    const result = {};
    for (const key of ['daemon', 'browser']) result[key] = await stillSameProcess(state.processes[key])
      ? await processInfo(state.processes[key].pid, key === 'daemon') : null;
    if (result.daemon) assertDaemon(this.config, result.daemon, 0);
    if (result.browser) assertBrowser(this.config, result.browser, state.processes.daemon.pid);
    return result;
  }
  async sameProcess(identity) {return stillSameProcess(identity);}
  async removeState() {await durableUnlink(join(this.config.state_dir, 'state.json'));}
  async stop() {
    return this.locked(async () => {
      const state = await this.state();
      assertManagedState(state, this.configSha, await this.generation(state.processes));
      // Cleanup remains available if the dedicated relay has already stopped.
      const p = await this.stopProcesses(state);
      if (!p.daemon && !p.browser) {await this.removeState(); return {status: 'STOPPED', generation: state.generation, already_stopped: true};}
      if (!p.daemon) fail('fixture_browser_orphan_requires_reconciliation');
      let commandFailed = false;
      try {await this.cli(['close']);} catch {commandFailed = true;}
      const deadline = Date.now() + this.stopTimeoutMs;
      while (Date.now() < deadline) {
        if (!(await this.sameProcess(state.processes.daemon)) && !(await this.sameProcess(state.processes.browser))) {
          await this.removeState();
          return {status: 'STOPPED', generation: state.generation, reconciled: commandFailed};
        }
        await sleep(100);
      }
      fail('fixture_stop_outcome_unknown');
    });
  }
  async healthCheck() {
    try {
      await this.locked(async () => {
        const state = await this.state(), p = await this.processes();
        assertManagedState(state, this.configSha, await this.generation(p), p);
      });
      return true;
    } catch (error) {
      // A bounded attestation can legitimately hold this lock longer than a
      // health tick's acquisition budget. Defer only that contention.
      if (error.code === 'ELOCKED') return false;
      throw error;
    }
  }
  async serve() {
    const started = await this.start();
    process.stdout.write(JSON.stringify(started) + '\n');
    let stopped = false, signal;
    const done = new Promise(resolve => {signal = resolve;});
    const onStop = () => {stopped = true; signal();};
    process.once('SIGTERM', onStop); process.once('SIGINT', onStop);
    try {
      while (!stopped) {
        await Promise.race([done, sleep(10000)]); if (stopped) break;
        await this.healthCheck();
      }
    } finally {
      process.removeListener('SIGTERM', onStop); process.removeListener('SIGINT', onStop);
      if (stopped) process.stdout.write(JSON.stringify(await this.stop()) + '\n');
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== '--config' || argv[1] !== CONFIG_PATH) fail('fixed_fixture_config_path_required');
  const verb = argv[2];
  if (!['verify', 'attest', 'bootstrap-attest', 'serve', 'stop', 'wait-relay'].includes(verb)) fail('fixture_command_invalid');
  const withPage = ['attest', 'bootstrap-attest'].includes(verb);
  if (withPage ? (argv.length !== 7 || argv[3] !== '--page-id' || argv[5] !== '--nonce') : argv.length !== 3) fail('fixture_arguments_invalid');
  const pageId = withPage ? Number(argv[4]) : undefined, nonce = withPage ? argv[6] : undefined;
  if (withPage && (!positive(pageId) || !uuid(nonce))) fail('owned_page_attestation_identity_invalid');
  const {config, configSha} = await loadConfig(), manager = new BrowserFixtureManager(config, configSha);
  if (verb === 'serve') {await manager.serve(); return;}
  if (verb === 'wait-relay') {
    const relay = await manager.waitRelay();
    process.stdout.write(JSON.stringify({status: 'READY', config_sha256: configSha, relay_pid: relay.pid, relay_start_ticks: relay.start_ticks}) + '\n');
    return;
  }
  const value = verb === 'stop' ? await manager.stop() : verb === 'bootstrap-attest' ? await manager.bootstrapAttest(pageId, nonce) : await manager.verify(pageId, nonce);
  process.stdout.write(JSON.stringify(value) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {process.stdout.write(JSON.stringify({status: 'FAIL', code: /^[a-z0-9_]+$/.test(error.code || '') ? error.code : 'fixture_operation_failed'}) + '\n'); process.exitCode = 1;});
}
