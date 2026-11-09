import {describe, it, expect} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InstalledVibeBrowser, PublicCorePort, createInstalledSmokeBindings, nativeLaunchContext, readProcessArtifactSource, stopOwnedChild, verifyBrowserFixtureProof} from './native/installed-browser-bindings.js';

const result = (value: unknown) => ({content: [{type: 'text', text: JSON.stringify({success: true, result: value})}]});
async function releaseArtifact(format: 'fleet-build' | 'noticeplace-build', source = 'a'.repeat(40)) {
  const directory = await mkdtemp(join(tmpdir(), 'installed-source-proof-'));
  const sha256 = 'b'.repeat(64);
  const relative = format === 'fleet-build' ? 'dist/index.js' : 'deploy/fleet/launch-v1-noticeplace.mjs';
  const manifestPath = join(directory, format === 'fleet-build' ? 'build-manifest.json' : 'noticeplace-manifest.json');
  const manifest = format === 'fleet-build'
    ? {sourceSha: source, artifacts: {dist: {indexSha256: sha256}}}
    : {source_commit: source, files: {[relative]: sha256}};
  const raw = JSON.stringify(manifest);
  await writeFile(manifestPath, raw, {mode: 0o644});
  return {directory, manifestPath, artifact: {path: join(directory, relative), sha256,
    source_manifest: {format, path: manifestPath, sha256: createHash('sha256').update(raw).digest('hex')}}};
}
describe('installed bindings use actual owned process and browser boundaries', () => {
  it.each(['fleet-build', 'noticeplace-build'] as const)('binds each process artifact to its actual %s source manifest', async format => {
    const proof = await releaseArtifact(format);
    try {
      expect(await readProcessArtifactSource(proof.artifact, 'a'.repeat(40))).toMatchObject({
        source_sha: 'a'.repeat(40), manifest_path: proof.manifestPath,
        manifest_sha256: proof.artifact.source_manifest.sha256, artifact_sha256: proof.artifact.sha256,
      });
      await expect(readProcessArtifactSource(proof.artifact, 'c'.repeat(40))).rejects.toThrow('running_component_source_mismatch');
      await expect(readProcessArtifactSource({...proof.artifact, path: join(proof.directory, 'other.js')}, 'a'.repeat(40)))
        .rejects.toThrow('running_component_artifact_unbound');
      await expect(readProcessArtifactSource({...proof.artifact, sha256: 'd'.repeat(64)}, 'a'.repeat(40)))
        .rejects.toThrow('running_component_artifact_unbound');
    } finally {await rm(proof.directory, {recursive: true, force: true});}
  });
  it('refuses missing, changed or unsupported process source metadata', async () => {
    const proof = await releaseArtifact('fleet-build');
    try {
      await expect(readProcessArtifactSource({path: proof.artifact.path, sha256: proof.artifact.sha256}, 'a'.repeat(40)))
        .rejects.toThrow('process_artifact_source_manifest_required');
      await expect(readProcessArtifactSource({...proof.artifact, source_manifest: {...proof.artifact.source_manifest, format: 'caller-assertion'}}, 'a'.repeat(40)))
        .rejects.toThrow('process_artifact_source_manifest_required');
      await writeFile(proof.manifestPath, JSON.stringify({sourceSha: 'a'.repeat(40)}));
      await expect(readProcessArtifactSource(proof.artifact, 'a'.repeat(40))).rejects.toThrow('protected_source_digest_mismatch');
    } finally {await rm(proof.directory, {recursive: true, force: true});}
  });
  it('reports absent native profiles before opening any file, worker, service or browser', async () => {
    await expect(createInstalledSmokeBindings({fixture_path:'/not-read/private-fixture.json',bindings:{native_profiles:{codex:{},opencode:{}}}}))
      .rejects.toMatchObject({code:'native_profiles_missing',receipt:{missing_harnesses:['chatgpt','zai','zcode'],model_effects:'NOT_SUBMITTED'}});
  });
  it('mirrors the owner launcher HOME, PATH, base URL, profile overrides and cwd', () => {
    const value = nativeLaunchContext({kind: 'codex', code_home: '/native/home', cwd: '/project',
      ahap_base_url: 'http://127.0.0.1:1234', ahap_env: {CODEX_HOME: '/exact/codex', AHAP_CODEX_CWD: '/exact/project'}},
      {HOME: '/wrong', CODEX_HOME: '/wrong', PRIVATE_OTHER_ENV: 'not inherited'});
    expect(value).toEqual({cwd: '/project', env: {HOME: '/native/home', PATH: '/usr/bin:/bin',
      AHAP_OPENCODE_BASE_URL: 'http://127.0.0.1:1234', CODEX_HOME: '/exact/codex', AHAP_CODEX_CWD: '/exact/project', AHAP_VERSION: '0.1', AHAP_HARNESS: 'codex'}});
    expect(nativeLaunchContext({kind: 'opencode', code_home: '/home', cwd: '/project', ahap_env: {}},
      {AHAP_OPENCODE_PASSWORD: 'unrelated-host-credential'}).env.AHAP_OPENCODE_PASSWORD).toBeUndefined();
    expect(() => nativeLaunchContext({code_home: 'relative', cwd: '/project', ahap_env: {}})).toThrow();
    expect(() => nativeLaunchContext({code_home: '/home', cwd: '/project', ahap_env: {INVALID: 2}})).toThrow();
  });
  it('requires the managed config, exact process generations, QA auth and a correlated owned page', () => {
    const fixture = {ui_url: 'https://herder.invalid/', qa: {profile_ref: '/qa/profile', browser_namespace: 'qa', browser_session: 'qa'},
      bindings: {browser_manager: {config_sha256: 'd'.repeat(64)}, vibe: {relayPort: 19898, relayStateDir: '/qa/relay', sessionId: 'session_1'}}};
    const expected = {generation: 'managed-generation', pageId: 42, nonce: 'unique-nonce'};
    const proof = {schema: 'agent-herder.ci-browser-proof.v1', status: 'PASS', managed: true,
      profile_path: '/qa/profile', namespace: 'qa', session: 'qa', generation: expected.generation,
      config_sha256: 'd'.repeat(64), observed_at: new Date().toISOString(), authenticated: true, api_status: 200,
      api_content_type: 'application/json; charset=utf-8',
      daemon_pid: 111, daemon_start_ticks: '123', browser_pid: 123, browser_start_ticks: '234', relay_pid: 456, relay_start_ticks: '345',
      relay: {agent_port: 19898, extension_port: 19899, state_dir: '/qa/relay', session_id: 'session_1'},
      cli_tab_id: 't2', vibe_page_correlated: true, page_id: 42, marker: 'herder-ci-anchor-' + expected.nonce, origin: 'https://herder.invalid'};
    expect(verifyBrowserFixtureProof(proof, fixture, expected)).toBe(proof);
    expect(verifyBrowserFixtureProof({...proof, vibe_page_correlated: false}, fixture).status).toBe('PASS');
    for (const change of [{profile_path: '/personal/profile'}, {generation: 'restarted'}, {page_id: 43},
      {marker: 'other-marker'}, {origin: 'https://login.invalid'}, {browser_pid: 0}, {browser_start_ticks: '0'},
      {managed: false}, {authenticated: false}, {api_status: 401}, {api_content_type: 'text/html'}, {api_content_type: undefined}, {config_sha256: 'e'.repeat(64)},
      {session: 'personal'}, {vibe_page_correlated: false}, {observed_at: new Date(Date.now() - 31000).toISOString()},
      {relay: {...proof.relay, agent_port: 19888}}])
      expect(() => verifyBrowserFixtureProof({...proof, ...change}, fixture, expected)).toThrow();
  });
  it('waits for a real exit and escalates only its unresponsive own child', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
      {stdio: ['pipe', 'pipe', 'pipe']});
    await once(child.stdout!, 'data');
    await stopOwnedChild(child, 20);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
  });
  it('bounds public auth preflight before any request and reaps the private consumer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'installed-public-test-'));
    const script = join(directory, 'quiet.py');
    await writeFile(script, 'import time\ntime.sleep(60)\n');
    const port = new PublicCorePort(script, 'unused', 30, 20);
    try {await expect(port.callTool('create', {})).rejects.toThrow('public_auth_preflight_timeout');}
    finally {await port.close(); await rm(directory, {recursive: true, force: true});}
  });
  it('keeps the original public UNKNOWN task receipt without replaying it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'installed-public-receipt-'));
    const script = join(directory, 'consumer.py');
    await writeFile(script, 'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n x=json.loads(line)\n print(json.dumps({"id":x["id"],"error":{"receipt":{"taskId":"original-accepted-task"}}}),flush=True)\n');
    const port = new PublicCorePort(script, 'unused', 1000, 100);
    try {await expect(port.callTool('create', {})).rejects.toMatchObject({receipt: {taskId: 'original-accepted-task'}});}
    finally {await port.close(); await rm(directory, {recursive: true, force: true});}
  });
  it('closes only its own Vibe page and keeps ownership through initialization failure', async () => {
    const calls: Array<{name: string; args: any}> = [];
    const browser = new InstalledVibeBrowser({async callTool(name, args) {
      calls.push({name, args});
      if (name === 'new_page') return {content: [{type: 'text', text: 'Successfully created new background page (ID: 42), ready'}]};
      if (name === 'evaluate_script') return result('wrong-marker');
      if (name === 'close_page') return result(true);
      if (name === 'list_pages') return {content:[{type:'text',text:'Found 0 page(s):'}]};
      throw Error('unexpected');
    }}, 'https://herder.invalid/');
    await expect(browser.openOwnPage('https://herder.invalid/')).rejects.toThrow('browser_ownership_marker_missing');
    await expect(browser.closeOwnPage(123)).rejects.toThrow('foreign_browser_page_refused');
    await browser.close();
    expect(calls.filter(call => call.name === 'close_page')).toEqual([{name: 'close_page', args: {pageId: 42}}]);
  });
  it('reconciles an UNKNOWN UI-page close without another close dispatch', async () => {
    let closes=0,absent=false;
    const browser=new InstalledVibeBrowser({async callTool(name) {
      if(name==='new_page')return {content:[{type:'text',text:'Successfully created new background page (ID: 42), ready'}]};
      if(name==='evaluate_script')return result('wrong-marker');
      if(name==='close_page'){closes++;throw Object.assign(Error('close response lost'),{receipt:{outcome:'UNKNOWN'}});}
      if(name==='list_pages')return {content:[{type:'text',text:absent?'Found 0 page(s):':'Found 1 page(s):\nPage 42: "CI" - https://herder.invalid/'}]};
      throw Error('unexpected');
    }},'https://herder.invalid/');
    await expect(browser.openOwnPage('https://herder.invalid/')).rejects.toThrow();
    await expect(browser.closeOwnPage(42)).rejects.toMatchObject({code:'owned_browser_cleanup_unconfirmed',receipt:{page_id:42,close_attempted:true}});
    absent=true;await browser.close();expect(closes).toBe(1);
  });
});
