import {describe, it, expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeInstalledBrowserSmoke, validateSmokeRequest, SMOKE_HARNESSES, type SmokeBindings, type SmokeFixture} from './native/installed-browser-smoke.js';

const request = {run_id: 'ci-unit-42', expected_source_sha: 'a'.repeat(40)};
function stand(overrides: {hidden?: boolean; wrongHost?: boolean; unknownCreate?: boolean; partial?: boolean; staleIdentity?: boolean; cleanup?: boolean; stopped?: boolean} = {}) {
  let clock = Date.parse('2026-11-09T00:00:00Z');
  const timestamp = () => new Date(clock).toISOString();
  const calls: Array<{name: string; args: any}> = [];
  const texts = new Map<string, Array<{role: string; text: string}>>();
  const tasks = new Map<string, any>();
  const fixture: SmokeFixture = {version: 1, ui_url: 'https://herder.invalid/',
    qa: {isolated: true, human_delivery: false, browser_namespace: 'unit-qa', browser_session: 'unit-qa', profile_ref: 'unit-profile'},
    lanes: Object.fromEntries(SMOKE_HARNESSES.map(h => [h, {instance_ref: h + '-qa', host_id: 'owner-qa'}])) as any};
  const status = overrides.stopped ? 'stopped' : 'idle';
  const bindings: SmokeBindings = {
    core: {
      async callTool(name, args) {
        calls.push({name, args});
        if (name === 'create' || name === 'deliver') {
          if (overrides.unknownCreate && name === 'create') throw new Error('PRIVATE_TOKEN');
          const h = name === 'create' ? args.instance_ref.replace(/-qa$/, '') : args.session_ref.slice(8);
          const ref = 'session:' + h, prompt = args.prompt ?? args.message, token = prompt.split(': ').at(-1);
          const history = texts.get(ref) ?? []; history.push({role: 'user', text: prompt}, {role: 'assistant', text: token}); texts.set(ref, history);
          const id = 'task-' + calls.length;
          tasks.set(id, {status: 'completed', result: {structuredContent: {
            ...(name === 'create' ? {create: {session_ref: ref}} : {}), delivery: {native_receipt_id: 'receipt-' + id, outcome: 'confirmed'}}}});
          return {taskId: id};
        }
        if (name === 'sessions') {
          const h = args.instance_ref.replace(/-qa$/, '');
          return {structuredContent: {scope: 'authorized_registered_sessions', complete: true, next_cursor: null, sessions: [{
            session_ref: 'session:' + h, address: {instance: {instance_id: args.instance_ref, node: 'owner-qa'}, native_session_id: h + '-canary'}, native: {id: h + '-canary', harness: h, hostId: 'owner-qa', cwd: '/owned/project', status}}]}};
        }
        if (name === 'session' && args.action === 'messages') return {structuredContent: {messages: texts.get(args.session_ref)}};
        if (name === 'session' && args.action === 'archive') return {structuredContent: {archived: overrides.cleanup !== false}};
        if (name === 'stop') return {structuredContent: {session_ref: args.session_ref, hold: 'active', native_interrupt: 'not_attempted_no_known_handoff'}};
        throw new Error('unexpected call');
      },
      async request(_method, args) {return tasks.get(args.taskId);},
    },
    native: Object.fromEntries(SMOKE_HARNESSES.map(h => [h, {
      instanceRef: h + '-qa', harness: h, hostId: 'owner-qa',
      async preflight() {},
      async readSession(id: string) {return {complete: true, observedAt: timestamp(), session: {id, harness: h, hostId: 'owner-qa', status}, raw: {status}};},
      async readActive() {return {sessions: [{id: h + '-unregistered-active', harness: h, hostId: 'owner-qa', status: 'running'}],
        scope: 'authorized_owner_active_sessions', exhaustive: !overrides.partial, observedAt: timestamp(), source: 'existing-native-adapter', raw: {active: true}};},
      async readOwnedState(binding: any) {return {nativeId: binding.nativeId, harness: h, hostId: 'owner-qa', cwd: '/owned/project',
        observedAt: timestamp(), status, terminal: true, cancellation: 'unsupported', generation: 'own-generation', raw: {terminal: true}};},
      async cancelOwned() {throw Error('terminal canary must not be canceled');},
    }])) as any,
    browser: {
      transport: 'vibe-mcp',
      async openOwnPage() {return 42;},
      async readRows() {
        return {url: fixture.ui_url, herder: true, raw: {dom: true}, rows: SMOKE_HARNESSES.flatMap(h => [
          {nativeId: h + '-canary', harness: h, hostId: overrides.wrongHost ? 'other-owner' : 'owner-qa', status},
          ...(overrides.hidden ? [] : [{nativeId: h + '-unregistered-active', harness: h, hostId: 'owner-qa', status: 'running'}]),
        ])};
      },
      async capture() {return {snapshot: 'actual-port-receipt'};},
      async openDetails(_page, expected) {return {...expected, visibleAssistantTokens: expected.tokens, raw: {rendered: true}};},
      async closeOwnPage(id) {expect(id).toBe(42);},
    },
    async runtimeIdentity() {return {source_sha: request.expected_source_sha, artifact_sha256: 'b'.repeat(64),
      process_binding_verified: !overrides.staleIdentity, observedAt: timestamp(), raw: {pid: 123, executable_digest: 'b'.repeat(64)}};},
    async close() {},
  };
  return {fixture, bindings, calls, texts, timestamp, options: {now: () => clock, sleep: async (ms: number) => {clock += ms;}, deadlineMs: 2000}};
}
async function run(options: Parameters<typeof stand>[0] = {}, mutate?: (s: ReturnType<typeof stand>) => void) {
  const parent = await mkdtemp(join(tmpdir(), 'installed-browser-smoke-test-'));
  const s = stand(options); mutate?.(s);
  try {
    const report = await executeInstalledBrowserSmoke(s.fixture, request, s.bindings, join(parent, 'run'), s.options);
    return {report, calls: s.calls, raw: await readFile(join(parent, 'run/report.json'), 'utf8')};
  } finally {await rm(parent, {recursive: true, force: true});}
}
// Each case persists real fsync-backed intent/receipt files for all five lanes.
describe('installed browser smoke effect and evidence contract', {timeout: 30000}, () => {
  it('runs five lanes through native reply, same-session continuation, UI evidence and owned cleanup', async () => {
    const {report, calls} = await run({stopped: true});
    expect(report.status).toBe('PASS');
    expect(calls.filter(c => c.name === 'create')).toHaveLength(5);
    expect(calls.filter(c => c.name === 'deliver')).toHaveLength(5);
    expect(calls.filter(c => c.args.action === 'archive')).toHaveLength(5);
    for (const h of SMOKE_HARNESSES) {
      expect(report.lanes[h].browser_evidence.native_active_session_ids).toEqual([h + '-unregistered-active']);
      expect(report.lanes[h].browser_evidence.native_state).toBe('stopped');
    }
  });
  it.each([{hidden: true}, {wrongHost: true}, {partial: true}, {cleanup: false}])('fails actual native/UI coverage or cleanup gaps: %j', async options => {
    const {report} = await run(options); expect(report.status).toBe('FAIL');
  });
  it('never resends an UNKNOWN create and does not echo a private error', async () => {
    const {report, calls, raw} = await run({unknownCreate: true});
    expect(report.status).toBe('FAIL');
    expect(calls.filter(c => c.name === 'create')).toHaveLength(5);
    expect(calls.some(c => c.name === 'deliver' || c.args.action === 'archive')).toBe(false);
    expect(raw).not.toContain('PRIVATE_TOKEN');
  });
  it('requires installed process identity before native adapter preflight or the first native effect', async () => {
    let preflights = 0;
    const {report, calls} = await run({staleIdentity: true}, s => {
      for (const provider of Object.values(s.bindings.native)) provider.preflight = async () => {preflights++;};
    });
    expect(report.status).toBe('FAIL'); expect(calls).toHaveLength(0);
    expect(preflights).toBe(0);
  });
  it('requires every native provider before the first native effect', async () => {
    const {report, calls} = await run({}, s => {delete (s.bindings.native as any).zcode;});
    expect(report.status).toBe('FAIL'); expect(calls).toHaveLength(0);
  });
  it('rejects a visible list whose exact session details or rendered replies fail', async () => {
    const {report} = await run({}, s => {s.bindings.browser.openDetails = async (_page, expected) => ({...expected, visibleAssistantTokens: [], raw: {httpStatus: 400}});});
    expect(report.status).toBe('FAIL');
    expect(report.lanes.opencode.error_code).toBe('exact_native_details_or_rendered_turns_missing');
  });
  it('rejects page zero before creating native canaries', async () => {
    const {report, calls} = await run({}, s => {s.bindings.browser.openOwnPage = async () => 0; s.bindings.browser.closeOwnPage = async () => {};});
    expect(report.status).toBe('FAIL'); expect(calls).toHaveLength(0);
  });
  it('refuses an existing run root instead of replaying it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'installed-browser-smoke-replay-')), s = stand();
    try {
      await expect(executeInstalledBrowserSmoke(s.fixture, request, s.bindings, parent, s.options)).rejects.toThrow();
      expect(s.calls).toHaveLength(0);
    } finally {await rm(parent, {recursive: true, force: true});}
  });
  it('rejects a fresh controller-local inventory even when its receipt says exhaustive', async () => {
    const {report} = await run({}, s => {
      const original = s.bindings.native.codex.readActive;
      s.bindings.native.codex.readActive = async () => ({...await original(), scope: 'connected_native_controller'});
    });
    expect(report.status).toBe('FAIL');
    expect(report.lanes.codex.error_code).toBe('native_active_catalog_incomplete');
  });
  it('requires an explicitly requested bounded capability instead of silently downgrading owner scope', async () => {
    const {report, calls} = await run({}, s => {s.bindings.native.codex.coverageCapability = 'registered_canary_completed_turns';});
    expect(report.status).toBe('FAIL'); expect(calls).toHaveLength(0);
  });
  it('accepts exact independent Codex completed turns with global inventory explicitly unverified', async () => {
    const {report} = await run({}, s => {
      const native = s.bindings.native.codex;
      native.coverageCapability = s.fixture.lanes.codex.coverage_capability = 'registered_canary_completed_turns';
      native.readActive = async () => ({sessions: [], exhaustive: false, partial: true, observedAt: s.timestamp(),
        scope: 'registered_canary_completed_turns', source: 'native-global-active-inventory-unsupported', raw: {global: 'UNVERIFIED'}});
      native.readSession = async (id, expected) => {
        const pairs = expected!.pairs;
        const session = {id, harness: 'codex', hostId: 'owner-qa', cwd: '/owned/project', status: 'idle'};
        const turns = pairs.map((pair, i) => ({id: 'native-turn-' + i, status: 'completed', error: null, items: [
          {id: 'u-' + i, type: 'userMessage', content: [{type: 'text', text: pair.prompt}]},
          {id: 'a-' + i, type: 'agentMessage', phase: 'final_answer', text: pair.token},
        ]}));
        const transcriptTail = JSON.stringify(turns), messages = pairs.flatMap((pair, i) => [
          {role: 'user', text: pair.prompt, turnId: turns[i].id}, {role: 'assistant', text: pair.token, turnId: turns[i].id}]);
        return {session, complete: true, observedAt: s.timestamp(), expectedCwd: session.cwd, raw: {independent: true},
          proof: {capability: 'registered-canary-completed-turns', source: 'codex-native-thread-read-completion',
            native_session_id: id, cwd: session.cwd, canonical_status: 'idle', observed_at: s.timestamp(),
            completed_turn_ids: turns.map(turn => turn.id), latest_turn_id: turns[1].id, fingerprint: 'c'.repeat(64),
            canonical_transcript_sha256: createHash('sha256').update(transcriptTail).digest('hex'), native_messages_receipt: messages,
            canonical_completion_receipt: {session, turnId: turns[1].id, transcriptTail, fingerprint: 'c'.repeat(64)}}};
      };
    });
    expect(report.status).toBe('PASS'); expect(report.global_inventory_status).toBe('UNVERIFIED');
    expect(report.lanes.codex.browser_evidence.native_completed_turns_proof.native_delivery_receipt_refs).toHaveLength(2);
    expect(report.lanes.codex.browser_evidence.native_catalog_complete).toBe(false);
  });
  it('binds the owned browser view to the original control handle and actual conversation route', async () => {
    const {report}=await run({},s=>{
      const native=s.bindings.native.chatgpt;
      native.coverageCapability=s.fixture.lanes.chatgpt.coverage_capability='owned_current_conversations';
      native.readActive=async()=>({sessions:[],exhaustive:false,partial:true,observedAt:s.timestamp(),scope:'owned_current_conversations',source:'native-global-active-inventory-unsupported',raw:{global:'UNVERIFIED'}});
      native.readSession=async(id,expected)=>{
        const url='https://chatgpt.com/c/actual-provider-conversation',namespace='vibe-'+'e'.repeat(64);
        return {complete:true,observedAt:s.timestamp(),session:{id,harness:'chatgpt',hostId:'owner-qa',status:'idle'},raw:{independent:true},
          expectedAccountScope:'d'.repeat(64),expectedOwnedPageNamespace:namespace,
          proof:{capability:'owned-current-conversation',native_session_id:id,native_conversation_id:'actual-provider-conversation',account_scope_sha256:'d'.repeat(64),
            owned_page_namespace:namespace,owned_page_id:43,owned_page_url:url,canonical_status:'idle',
            owned_view_receipt:{native_session_id:id,native_conversation_id:'actual-provider-conversation',owned_page_id:43,owned_page_namespace:namespace,
              source_route:url,creation_receipt:{created:true},navigation_receipt:{navigated:true},observedAt:s.timestamp()},
            native_messages_receipt:{native_session_id:id,native_conversation_id:'actual-provider-conversation',observedAt:s.timestamp(),window_limit:200,
              messages:expected!.pairs.flatMap(pair=>[{role:'user',text:pair.prompt},{role:'assistant',text:pair.token}])},
            dom_generation_state_receipt:{observedAt:s.timestamp(),source:'owned-current-dom',raw:{origin:'https://chatgpt.com',path:'/c/actual-provider-conversation',url,phase:'idle',authenticated:true,composer:true,securityVerification:false}}}};
      };
    });
    expect(report.status).toBe('PASS');
    const proof=report.lanes.chatgpt.browser_evidence.native_owned_conversation_proof;
    expect(proof.native_session_id).toBe('chatgpt-canary');expect(proof.native_conversation_id).toBe('actual-provider-conversation');
    expect(proof.owned_view_ref).toBeTruthy();expect(report.global_inventory_status).toBe('UNVERIFIED');
  });
  it('proves complete ZCode replies within the pinned official server and keeps its other active session visible', async () => {
    const {report}=await run({},s=>{
      const native=s.bindings.native.zcode;
      native.coverageCapability=s.fixture.lanes.zcode.coverage_capability='pinned_official_server_owner';
      const snapshot=()=>({pid:1234,generation:3,observedAt:s.timestamp(),expiresAt:new Date(Date.parse(s.timestamp())+15000).toISOString(),
        tasks:[{sessionId:'zcode-unregistered-active',workspacePath:'/owned/project'}]});
      native.readActive=async()=>({sessions:[{id:'zcode-unregistered-active',harness:'zcode',hostId:'owner-qa',status:'running'}],
        exhaustive:false,partial:true,scopedComplete:true,scope:'pinned_official_server_owner',observedAt:s.timestamp(),
        source:'zcode-official-server-running-tasks',raw:{officialAfter:snapshot(),combinedAdapterReceipt:{exhaustive:false}}});
      native.readSession=async(id,expected)=>{
        const clock=Date.parse(s.timestamp()),pairs=expected!.pairs;
        const transcript={session:{sessionId:id,status:'idle',model:{providerId:'provider',modelId:'model'},workspace:{workspacePath:'/owned/project',workspaceIdentity:'/owned/project'}},
          settings:{model:{current:{providerId:'provider',modelId:'model',options:{reasoningLevel:'enabled'}}}},
          projection:{sessionId:id,status:'idle',currentTurnId:'turn-second',pendingPermissions:[],activeToolCalls:[],backgroundJobs:[]},
          runtime:{eventSeq:42,stateRevision:3,pendingRequestIds:[]},messages:pairs.flatMap((pair,i)=>[
            {info:{role:'user',messageId:'u'+i,sessionId:id},parts:[{type:'text',text:pair.prompt}]},
            {info:{role:'assistant',messageId:'a'+i,parentMessageId:'u'+i,sessionId:id,semantics:{origin:'agent_runtime',kind:'assistant_response'},finish:'stop',time:{created:clock-10,completed:clock-5}},parts:[{type:'text',text:pair.token}]}])};
        const text=JSON.stringify(transcript);
        return {complete:true,observedAt:s.timestamp(),session:{id,harness:'zcode',hostId:'owner-qa',status:'idle'},raw:{independent:true},expectedCwd:'/owned/project',expectedCreateModel:'provider/model$enabled',
          proof:{capability:'official-server-canary',source:'zcode-native-session-read+official-supervisor',native_session_id:id,cwd:'/owned/project',host_id:'owner-qa',
            canonical_status:'idle',create_model:'provider/model$enabled',observed_at:s.timestamp(),official_pid:1234,official_generation:3,official_before:snapshot(),official_after:snapshot(),
            completed_message_ids:['a0','a1'],user_message_ids:['u0','u1'],native_transcript_sha256:createHash('sha256').update(text).digest('hex'),
            native_transcript_receipt:{complete:true,source:{kind:'native-api',location:'zcode app-server session/read',format:'json'},timestampCoverage:'native',text}}};
      };
    });
    expect(report.status).toBe('PASS');expect(report.global_inventory_status).toBe('UNVERIFIED');
    expect(report.lanes.zcode.browser_evidence.native_catalog_complete).toBe(false);
    expect(report.lanes.zcode.browser_evidence.official_owner_coverage_complete).toBe(true);
    expect(report.lanes.zcode.browser_evidence.native_active_session_ids).toEqual(['zcode-unregistered-active']);
  });
  it('performs a public hold and one native cancel, then archives only after terminal native evidence', async () => {
    let cancelCount=0;
    const {report,calls}=await run({},s=>{
      let terminal=false;const native=s.bindings.native.opencode;
      native.readOwnedState=async binding=>({nativeId:binding.nativeId,harness:'opencode',hostId:'owner-qa',cwd:'/owned/project',observedAt:s.timestamp(),
        terminal,status:terminal?'idle':'running',cancellation:'supported',generation:'created-here-generation',raw:{terminal}});
      native.cancelOwned=async()=>{cancelCount++;terminal=true;throw Object.assign(Error('unknown native reply'),{receipt:{accepted:true}});};
    });
    expect(report.status).toBe('PASS');expect(cancelCount).toBe(1);
    expect(calls.filter(call=>call.name==='stop')).toHaveLength(1);
    expect(report.lanes.opencode.cleanup_receipts.map((row:any)=>row.kind)).toEqual(['state_before','cancel_intent','cancel_unknown','terminal_state']);
    expect(report.lanes.opencode.checks.owned_cleanup).toBe('PASS');
  });
  it('accepts only bounded caller identity, never commands, paths or prompts', () => {
    for (const bad of [{...request, prompt: 'run anything'}, {...request, run_id: '../escape'},
      {...request, expected_source_sha: 'unknown'}]) expect(() => validateSmokeRequest(bad)).toThrow();
  });
});
