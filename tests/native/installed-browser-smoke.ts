import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {validateCodexCanaryProof} from './installed-codex-proof.js';
import {validateZcodeCanaryProof} from './installed-zcode-proof.js';
import {cleanupOwnedCanary, type OwnedCanaryBinding, type OwnedCanaryState} from './installed-owned-cleanup.js';

export const SMOKE_HARNESSES = ['chatgpt', 'zai', 'opencode', 'codex', 'zcode'] as const;
export const SMOKE_CHECKS = ['create', 'reply', 'continue_same_session', 'read_both', 'vibe_session_visibility', 'open_details', 'owned_cleanup'] as const;
type Harness = typeof SMOKE_HARNESSES[number];
type Json = Record<string, any>;
export interface NativeSession {id: string; harness: string; hostId: string; status: string}
export interface NativeRead {session: NativeSession; complete: boolean; observedAt: string; raw: unknown; proof?: Json; expectedAccountScope?: string; expectedOwnedPageNamespace?: string; expectedCwd?: string; expectedCreateModel?: string}
export interface NativeCatalog {sessions: NativeSession[]; exhaustive: boolean; observedAt: string; source: string; scope: string; partial?: boolean; scopedComplete?: boolean; raw: unknown}
export type NativeCoverageCapability = 'owner_active_catalog' | 'owned_current_conversations' | 'registered_canary_completed_turns' | 'pinned_official_server_owner';
export interface CorePort {
  callTool(name: string, args: Json): Promise<any>;
  request(method: 'tasks/get' | 'tasks/result', args: Json): Promise<any>;
}
export interface NativePort {
  instanceRef: string; harness: string; hostId: string;
  coverageCapability?: NativeCoverageCapability;
  preflight(): Promise<unknown>;
  readSession(nativeId: string, expected?: {pairs: Array<{prompt: string; token: string}>}): Promise<NativeRead>;
  readActive(): Promise<NativeCatalog>;
  readOwnedState(binding: OwnedCanaryBinding, expected?: {pairs: Array<{prompt: string; token: string}>}): Promise<OwnedCanaryState>;
  cancelOwned(binding: OwnedCanaryBinding, guard: OwnedCanaryState, expected?: {pairs: Array<{prompt: string; token: string}>}): Promise<{accepted: boolean; raw: unknown}>;
}
export interface BrowserRows {url: string; herder: boolean; rows: Array<{nativeId: string; harness: string; hostId: string; status: string}>; raw: unknown}
export interface BrowserPort {
  transport: 'vibe-mcp';
  openOwnPage(url: string): Promise<number>;
  readRows(pageId: number): Promise<BrowserRows>;
  capture(pageId: number, nativeId: string, harness: string, hostId: string): Promise<unknown>;
  openDetails(pageId: number, expected: {nativeId: string; harness: string; hostId: string; tokens: string[]}): Promise<{nativeId: string; harness: string; hostId: string; visibleAssistantTokens: string[]; raw: unknown}>;
  closeOwnPage(pageId: number): Promise<unknown>;
}
export interface SmokeBindings {
  core: CorePort; browser: BrowserPort; native: Record<Harness, NativePort>;
  runtimeIdentity(): Promise<{source_sha: string; artifact_sha256: string; process_binding_verified: boolean; observedAt: string; raw: unknown}>;
  close(): Promise<unknown>;
}
export interface SmokeFixture {
  version: 1; ui_url: string;
  qa: {isolated: true; human_delivery: false; browser_namespace: string; browser_session: string; profile_ref: string};
  lanes: Record<Harness, {instance_ref: string; host_id: string; project_ref?: string; coverage_capability?: NativeCoverageCapability}>;
}
export interface SmokeRequest {run_id: string; expected_source_sha: string}
export class SmokeFailure extends Error {
  constructor(public code: string) {super(code); this.name = 'SmokeFailure';}
}
const fail = (code: string): never => {throw new SmokeFailure(code);};
const object = (v: any): Json => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const content = (v: any): Json => object(object(v).structuredContent ?? v);
const goodText = (v: any, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\x00-\x1f]/.test(v);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const age = (at: any, now: number) => typeof at === 'string' ? now - Date.parse(at) : NaN;
const fresh = (at: any, now: number) => Number.isFinite(age(at, now)) && age(at, now) >= -5000 && age(at, now) <= 30000;
const resultCode = (error: unknown) => error instanceof SmokeFailure ? error.code
  : typeof object(error).code === 'string' && /^owned_cleanup_[a-z_]+$/.test(object(error).code) ? object(error).code
  : 'transport_or_provider_failure';
export function validateSmokeRequest(request: SmokeRequest) {
  if (!request || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(request.run_id)
      || !/^[0-9a-f]{40}$/.test(request.expected_source_sha)
      || Object.keys(request).some(k => !['run_id', 'expected_source_sha'].includes(k))) fail('invalid_smoke_request');
}
export function validateSmokeFixture(f: SmokeFixture) {
  if (f?.version !== 1 || f.qa?.isolated !== true || f.qa?.human_delivery !== false
      || !goodText(f.qa.browser_namespace, 128) || !goodText(f.qa.browser_session, 128) || !goodText(f.qa.profile_ref)) fail('isolated_qa_fixture_required');
  const url = new URL(f.ui_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('explicit_ui_origin_required');
  if (Object.keys(object(f.lanes)).sort().join(',') !== [...SMOKE_HARNESSES].sort().join(',')) fail('five_native_lanes_required');
  for (const name of SMOKE_HARNESSES) {
    const lane = f.lanes[name];
    const coverage = lane.coverage_capability ?? 'owner_active_catalog';
    if (!['owner_active_catalog', 'owned_current_conversations', 'registered_canary_completed_turns', 'pinned_official_server_owner'].includes(coverage)
        || (coverage === 'owned_current_conversations' && !['chatgpt', 'zai'].includes(name))
        || (coverage === 'registered_canary_completed_turns' && name !== 'codex')
        || (coverage === 'pinned_official_server_owner' && name !== 'zcode')) fail('explicit_native_coverage_capability_required');
    if (!goodText(lane.instance_ref) || !goodText(lane.host_id)
        || (lane.project_ref !== undefined && !goodText(lane.project_ref))) fail('exact_lane_binding_required');
  }
}
function messages(value: any, found: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(value)) for (const child of value) messages(child, found);
  else if (value && typeof value === 'object') {
    if (['user', 'assistant'].includes(value.role)) {
      for (const key of ['text', 'content']) if (typeof value[key] === 'string') found.push([value.role, value[key]]);
    }
    for (const child of Object.values(value)) messages(child, found);
  }
  return found;
}
function nativeReceipts(value: any, found: Json[] = []): Json[] {
  if (Array.isArray(value)) for (const child of value) nativeReceipts(child, found);
  else if (value && typeof value === 'object') {
    if (typeof value.native_receipt_id === 'string' && value.outcome === 'confirmed') found.push(value);
    for (const child of Object.values(value)) nativeReceipts(child, found);
  }
  return found;
}
export async function executeInstalledBrowserSmoke(
  fixture: SmokeFixture, request: SmokeRequest, bindings: SmokeBindings, runRoot: string,
  options: {now?: () => number; sleep?: (ms: number) => Promise<void>; deadlineMs?: number} = {},
): Promise<Json> {
  validateSmokeRequest(request); validateSmokeFixture(fixture);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadlineMs = options.deadlineMs ?? 150000;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 180000) fail('bounded_deadline_required');
  // Exclusive directory is the durable no-replay boundary, including UNKNOWN.
  try {await mkdir(runRoot, {mode: 0o700});}
  catch (error) {try {await bindings.close();} catch {} throw error;}
  let sequence = 0, page: number | undefined;
  const report: Json = {mode: 'installed-browser', stage: 'installed', run_id: request.run_id,
    source_sha: request.expected_source_sha, status: 'UNKNOWN', identity: 'UNKNOWN',
    model_effects: 'NOT_SUBMITTED',
    functional_status: 'UNKNOWN', global_inventory_status: 'UNKNOWN',
    browser_cleanup: 'UNKNOWN', lanes: Object.fromEntries(SMOKE_HARNESSES.map(h => [h, {
      checks: Object.fromEntries(SMOKE_CHECKS.map(c => [c, 'UNKNOWN'])), effects: [],
    }]))};
  async function persist(name: string, value: unknown) {
    const path = join(runRoot, name), tmp = path + '.tmp';
    const stream = await open(tmp, 'w', 0o600);
    try {await stream.writeFile(JSON.stringify(value, null, 2) + '\n'); await stream.sync();} finally {await stream.close();}
    await rename(tmp, path);
    const directory = await open(runRoot, 'r');
    try {await directory.sync();} finally {await directory.close();}
    return path;
  }
  const save = () => persist('report.json', report);
  const receipt = (prefix: string, raw: unknown) => persist(String(++sequence).padStart(4, '0') + '-' + prefix + '.json', raw);
  async function effect(harness: Harness, tool: string, args: Json) {
    const lane = report.lanes[harness];
    if (tool === 'create' || tool === 'deliver') report.model_effects = 'SUBMITTED_OR_UNKNOWN';
    const item: Json = {tool, request_key: args.request_key, arguments_sha256: sha(JSON.stringify(args)), outcome: 'UNKNOWN'};
    lane.effects.push(item); await save();
    try {
      const raw = await bindings.core.callTool(tool, args);
      item.receipt_ref = await receipt(harness + '-' + tool, raw); item.outcome = 'RECEIVED'; await save();
      return raw;
    } catch (error) {
      const raw = object(error).receipt;
      if (raw !== undefined) item.unknown_receipt_ref = await receipt(harness + '-unknown-effect', raw);
      item.error_code = resultCode(error); await save(); fail('effect_outcome_unknown_no_replay');
    }
  }
  async function waitTask(harness: Harness, reply: any) {
    const lane = report.lanes[harness], id = object(reply).taskId;
    if (!goodText(id)) fail('missing_task_receipt_no_replay');
    lane.task_ids = [...(lane.task_ids ?? []), id]; await save();
    const end = now() + deadlineMs;
    while (now() < end) {
      const task = await bindings.core.request('tasks/get', {taskId: id});
      const created = content(object(task).result).create?.session_ref;
      if (created !== undefined) {
        if (!goodText(created) || !created.startsWith('session:') || created === 'session:'
            || (lane.core_session_ref && lane.core_session_ref !== created)) fail('create_session_identity_mismatch');
        lane.core_session_ref = created; await save();
      }
      if (['completed', 'failed', 'cancelled'].includes(task?.status)) {
        lane.last_task_ref = await receipt(harness + '-task', task);
        const deliveryReceipts = nativeReceipts(task.result);
        if (task.status !== 'completed' || deliveryReceipts.length !== 1) fail('native_delivery_not_confirmed');
        lane.native_delivery_receipt_refs = [...(lane.native_delivery_receipt_refs ?? []),
          await receipt(harness + '-confirmed-native-delivery', deliveryReceipts[0])];
        lane.native_delivery_receipt_ids = [...(lane.native_delivery_receipt_ids ?? []), deliveryReceipts[0].native_receipt_id];
        await save(); return;
      }
      await sleep(500);
    }
    fail('task_unknown_after_deadline_no_replay');
  }
  async function readTurns(harness: Harness, pairs: Array<{prompt: string; token: string}>) {
    const lane = report.lanes[harness], end = now() + deadlineMs;
    while (now() < end) {
      const raw = await bindings.core.callTool('session', {action: 'messages', session_ref: lane.core_session_ref});
      const rows = messages(raw);
      if (pairs.every(p => rows.some(([role, text]) => role === 'user' && text === p.prompt)
          && rows.some(([role, text]) => role === 'assistant' && text === p.token))) {
        lane.messages_ref = await receipt(harness + '-messages', raw); return;
      }
      await sleep(750);
    }
    fail('exact_native_reply_missing');
  }
  async function findNative(harness: Harness) {
    const lane = report.lanes[harness], config = fixture.lanes[harness], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const value = content(await bindings.core.callTool('sessions', {action: 'list', instance_ref: config.instance_ref, ...(cursor ? {cursor} : {})}));
      if (value.scope !== 'authorized_registered_sessions' || value.complete !== true || !Array.isArray(value.sessions)) fail('registered_session_read_incomplete');
      const rows = value.sessions.filter((s: any) => s?.session_ref === lane.core_session_ref);
      if (rows.length > 1) fail('duplicate_native_binding');
      if (rows.length === 1) {
        const row = rows[0], id = row.address?.native_session_id;
        if (row.address?.instance?.instance_id !== config.instance_ref || !goodText(id)
            || id.startsWith('session:') || row.native?.id !== id || row.native?.harness !== harness
            || row.native?.hostId !== config.host_id || !goodText(row.native?.cwd) || !row.native.cwd.startsWith('/')
            || (lane.native_cwd && lane.native_cwd !== row.native.cwd)
            || (lane.native_session_id && lane.native_session_id !== id)) fail('exact_native_binding_missing_or_changed');
        lane.native_session_id = id; lane.native_cwd = row.native.cwd;
        lane.registry_ref = await receipt(harness + '-registry', {
          scope: value.scope, complete: value.complete, session_ref: row.session_ref,
          address: row.address, human_stop: row.human_stop,
          native: {id: row.native.id, harness: row.native.harness, hostId: row.native.hostId, cwd: row.native.cwd, status: row.native.status},
        });
        await save(); return id;
      }
      if (value.next_cursor == null) break;
      if (!goodText(value.next_cursor) || seen.has(value.next_cursor)) fail('registered_session_cursor_invalid');
      cursor = value.next_cursor; seen.add(cursor);
    }
    fail('exact_native_binding_missing');
  }
  async function visible(harness: Harness, pairs: Array<{prompt: string; token: string}>) {
    const tokens = pairs.map(pair => pair.token);
    const lane = report.lanes[harness], config = fixture.lanes[harness], provider = bindings.native[harness];
    const nativeId = await findNative(harness), end = now() + deadlineMs;
    while (now() < end) {
      const observed = await provider.readSession(nativeId, {pairs}), active = await provider.readActive();
      const ownedBrowser = ['chatgpt', 'zai'].includes(harness) && provider.coverageCapability === 'owned_current_conversations';
      const completedCodex = harness === 'codex' && provider.coverageCapability === 'registered_canary_completed_turns';
      const officialZcode = harness === 'zcode' && provider.coverageCapability === 'pinned_official_server_owner';
      const bounded = ownedBrowser || completedCodex || officialZcode;
      const coverageScope = ownedBrowser ? 'owned_current_conversations' : completedCodex ? 'registered_canary_completed_turns' : officialZcode ? 'pinned_official_server_owner' : 'authorized_owner_active_sessions';
      if (observed.complete !== true || !fresh(observed.observedAt, now()) || observed.raw == null
          || observed.session?.id !== nativeId || observed.session.harness !== harness || observed.session.hostId !== config.host_id
          || !['idle', 'running', 'stopped'].includes(observed.session.status)) fail('canary_native_observation_incomplete');
      if ((!bounded && (active.exhaustive !== true || active.partial === true))
          || (bounded && (active.exhaustive !== false || active.partial !== true)) || !fresh(active.observedAt, now())
          || active.scope !== coverageScope || !goodText(active.source) || active.raw == null || !Array.isArray(active.sessions)) fail('native_active_catalog_incomplete');
      let ownedProof: Json | undefined, completedProof: Json | undefined, officialProof: Json | undefined;
      if (ownedBrowser) {
        const proof = observed.proof;
        const rows = messages(proof?.native_messages_receipt);
        const view = proof?.owned_view_receipt, transcript = proof?.native_messages_receipt;
        const dom = proof?.dom_generation_state_receipt;
        if (proof?.capability !== 'owned-current-conversation' || proof.native_session_id !== nativeId
            || !goodText(proof.native_conversation_id) || proof.native_conversation_id.includes('/')
            || !/^[a-f0-9]{64}$/.test(proof.account_scope_sha256) || proof.account_scope_sha256 !== observed.expectedAccountScope
            || !/^vibe-[a-f0-9]{64}$/.test(proof.owned_page_namespace) || proof.owned_page_namespace !== observed.expectedOwnedPageNamespace
            || !Number.isSafeInteger(proof.owned_page_id) || proof.owned_page_id < 1
            || !goodText(proof.owned_page_url) || proof.canonical_status !== observed.session.status
            || transcript?.native_session_id !== nativeId || transcript.native_conversation_id !== proof.native_conversation_id
            || transcript.window_limit !== 200 || !Array.isArray(transcript.messages) || transcript.messages.length >= 200
            || !fresh(transcript.observedAt, now())
            || dom?.source !== 'owned-current-dom' || dom.observedAt !== observed.observedAt || !fresh(dom.observedAt, now())
            || dom.raw?.authenticated !== true || dom.raw.composer !== true || dom.raw.securityVerification !== false
            || !['generating', 'idle'].includes(dom.raw.phase)
            || (dom.raw.phase === 'idle' ? 'idle' : 'running') !== proof.canonical_status
            || view?.native_session_id !== nativeId || view.native_conversation_id !== proof.native_conversation_id
            || view.owned_page_id !== proof.owned_page_id || view.owned_page_namespace !== proof.owned_page_namespace
            || view.creation_receipt == null || view.navigation_receipt == null
            || !Number.isFinite(Date.parse(view.observedAt)) || Date.parse(view.observedAt) > now() + 5000
            || !pairs.every(pair => rows.some(([role, text]) => role === 'user' && text === pair.prompt)
              && rows.some(([role, text]) => role === 'assistant' && text === pair.token))) fail('owned_current_conversation_proof_missing');
        const pageUrl = new URL(proof.owned_page_url);
        if (pageUrl.protocol !== 'https:' || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash
            || pageUrl.origin !== (harness === 'chatgpt' ? 'https://chatgpt.com' : 'https://chat.z.ai')
            || pageUrl.pathname !== '/c/' + proof.native_conversation_id || view.source_route !== pageUrl.href
            || dom.raw.url !== pageUrl.href || dom.raw.origin !== pageUrl.origin || dom.raw.path !== pageUrl.pathname) fail('native_owned_page_origin_mismatch');
        ownedProof = {capability: proof.capability, account_scope_sha256: proof.account_scope_sha256,
          owned_page_namespace: proof.owned_page_namespace,
          native_session_id: nativeId, native_conversation_id: proof.native_conversation_id,
          owned_page_id: proof.owned_page_id, owned_page_url: proof.owned_page_url, source_route: view.source_route,
          canonical_status: proof.canonical_status, observed_at: observed.observedAt,
          owned_view_ref: await receipt(harness + '-owned-native-view', view),
          native_messages_ref: await receipt(harness + '-owned-native-messages', proof.native_messages_receipt),
          dom_generation_state_ref: await receipt(harness + '-owned-native-dom', proof.dom_generation_state_receipt)};
        // This is an exact owned conversation observation, never an account census.
        active.sessions = observed.session.status === 'running' ? [observed.session] : [];
      }
      if (completedCodex) {
        if (!goodText(observed.expectedCwd) || observed.expectedCwd !== lane.native_cwd || !Array.isArray(lane.native_delivery_receipt_refs)
            || lane.native_delivery_receipt_refs.length !== 2 || !Array.isArray(lane.native_delivery_receipt_ids)
            || new Set(lane.native_delivery_receipt_ids).size !== 2) fail('codex_original_native_receipts_missing');
        let proof: Json;
        try {proof = validateCodexCanaryProof(observed.proof, {nativeId, cwd: observed.expectedCwd,
          hostId: config.host_id, pairs, now: now()}, sha);} catch {fail('codex_canary_completion_unproven');}
        if (observed.session.status !== 'idle' || proof.observed_at !== observed.observedAt) fail('codex_canary_completion_state_mismatch');
        completedProof = {capability: proof.capability, source: proof.source, native_session_id: nativeId,
          core_session_ref: lane.core_session_ref, cwd: proof.cwd, canonical_status: proof.canonical_status,
          observed_at: proof.observed_at, completed_turn_ids: proof.completed_turn_ids, latest_turn_id: proof.latest_turn_id,
          canonical_transcript_sha256: proof.canonical_transcript_sha256, fingerprint: proof.fingerprint,
          native_delivery_receipt_refs: lane.native_delivery_receipt_refs, native_delivery_receipt_ids: lane.native_delivery_receipt_ids,
          native_messages_ref: await receipt(harness + '-completed-native-messages', proof.native_messages_receipt),
          canonical_completion_ref: await receipt(harness + '-canonical-native-completion', proof.canonical_completion_receipt)};
        active.sessions = [];
      }
      if (officialZcode) {
        if (!goodText(observed.expectedCwd) || observed.expectedCwd !== lane.native_cwd || !goodText(observed.expectedCreateModel, 512) || active.scopedComplete !== true
            || !Array.isArray(lane.native_delivery_receipt_refs) || lane.native_delivery_receipt_refs.length !== 2
            || new Set(lane.native_delivery_receipt_ids ?? []).size !== 2) fail('zcode_official_original_binding_missing');
        let proof: Json;
        try {proof = validateZcodeCanaryProof(observed.proof, {nativeId, cwd: observed.expectedCwd,
          hostId: config.host_id, createModel: observed.expectedCreateModel, pairs, now: now()}, sha);} catch {fail('zcode_official_canary_unproven');}
        const catalog = object(active.raw).officialAfter;
        if (proof.canonical_status !== observed.session.status || proof.observed_at !== observed.observedAt
            || catalog?.pid !== proof.official_pid || catalog?.generation !== proof.official_generation
            || !Array.isArray(catalog.tasks) || !fresh(catalog.observedAt, now())
            || Date.parse(catalog.expiresAt) <= now() || active.source !== 'zcode-official-server-running-tasks'
            || catalog.tasks.length !== active.sessions.length
            || catalog.tasks.some((task: any) => !active.sessions.some(row => row.id === task.sessionId))) fail('zcode_official_inventory_binding_missing');
        officialProof = {capability: proof.capability, source: proof.source, native_session_id: nativeId,
          core_session_ref: lane.core_session_ref, cwd: proof.cwd, host_id: proof.host_id, canonical_status: proof.canonical_status,
          observed_at: proof.observed_at, create_model: proof.create_model, official_pid: proof.official_pid, official_generation: proof.official_generation,
          completed_message_ids: proof.completed_message_ids, user_message_ids: proof.user_message_ids,
          native_transcript_sha256: proof.native_transcript_sha256,
          native_delivery_receipt_refs: lane.native_delivery_receipt_refs, native_delivery_receipt_ids: lane.native_delivery_receipt_ids,
          native_transcript_ref: await receipt(harness + '-official-native-transcript', proof.native_transcript_receipt),
          official_before_ref: await receipt(harness + '-official-before', proof.official_before),
          official_after_ref: await receipt(harness + '-official-after', proof.official_after)};
      }
      const ids = active.sessions.map(s => s.id);
      if (new Set(ids).size !== ids.length || active.sessions.some(s => !goodText(s.id)
          || s.harness !== harness || s.hostId !== config.host_id || !['running', 'needs_input'].includes(s.status))) fail('native_active_catalog_identity_or_state_invalid');
      const view = await bindings.browser.readRows(page!);
      const base = new URL(fixture.ui_url), url = new URL(view.url);
      if (!view.herder || url.origin !== base.origin || url.pathname !== base.pathname) fail('authenticated_herder_ui_missing');
      const rows = view.rows.filter(r => r.harness === harness && r.hostId === config.host_id);
      const states = Object.fromEntries(rows.map(r => [r.nativeId, r.status]));
      const expected = new Map(active.sessions.map(s => [s.id, s.status])); expected.set(nativeId, observed.session.status);
      if (new Set(rows.map(r => r.nativeId)).size === rows.length
          && [...expected].every(([id, status]) => states[id] === status)) {
        const nativeRef = await receipt(harness + '-native-state', observed);
        const catalogRef = await receipt(harness + '-native-active', active);
        const snapshot = await bindings.browser.capture(page!, nativeId, harness, config.host_id);
        const snapshotRef = await receipt(harness + '-vibe-visible', {view, snapshot});
        const details = await bindings.browser.openDetails(page!, {nativeId, harness, hostId: config.host_id, tokens});
        lane.details_receipt_ref = await receipt(harness + '-vibe-details', details);
        if (details.nativeId !== nativeId || details.harness !== harness || details.hostId !== config.host_id
            || !Array.isArray(details.visibleAssistantTokens) || !tokens.every(token => details.visibleAssistantTokens.includes(token))) fail('exact_native_details_or_rendered_turns_missing');
        if (!fresh(observed.observedAt, now()) || !fresh(active.observedAt, now())
            || (officialZcode && (age(observed.observedAt, now()) > 15000 || age(active.observedAt, now()) > 15000
              || Date.parse(object(active.raw).officialAfter.expiresAt) <= now()
              || Date.parse(observed.proof!.official_before.expiresAt) <= now()
              || Date.parse(observed.proof!.official_after.expiresAt) <= now()))) {await sleep(250); continue;}
        lane.checks.open_details = 'PASS';
        lane.browser_evidence = {transport: 'vibe-mcp', run_id: request.run_id, harness,
          instance_ref: config.instance_ref, host_id: config.host_id, core_session_ref: lane.core_session_ref,
          native_session_id: nativeId, ui_native_session_id: nativeId,
          native_state: observed.session.status, ui_state: states[nativeId],
          native_observed_at: observed.observedAt, native_observed_age_ms: age(observed.observedAt, now()),
          native_state_contract: 'AgentSession.status', native_raw_state_ref: nativeRef,
          control_scope: 'authorized_registered_sessions', native_catalog_scope: coverageScope,
          observation_phase: 'before_cleanup', native_catalog_ref: catalogRef,
          native_catalog_complete: !bounded, native_coverage_complete: !bounded,
          ...(bounded ? {canary_native_coverage_complete: true, global_inventory_status: 'UNVERIFIED',
            ...(ownedBrowser ? {expected_account_scope_sha256: observed.expectedAccountScope,
              expected_owned_page_namespace: observed.expectedOwnedPageNamespace, native_owned_conversation_proof: ownedProof}
              : completedCodex ? {expected_cwd: observed.expectedCwd, native_completed_turns_proof: completedProof}
              : {expected_cwd: observed.expectedCwd, expected_create_model: observed.expectedCreateModel, official_owner_coverage_complete: true, native_official_server_proof: officialProof,
                official_catalog_observed_at: active.observedAt, official_catalog_age_ms: age(active.observedAt, now()),
                official_catalog_expires_at: object(active.raw).officialAfter.expiresAt, ui_observed_at: new Date(now()).toISOString()})} : {}),
          native_active_session_ids: ids, native_active_states: Object.fromEntries(active.sessions.map(s => [s.id, s.status])),
          ui_visible_session_ids: rows.map(r => r.nativeId), ui_session_states: states,
          native_receipt_ref: nativeRef, browser_snapshot_ref: snapshotRef};
        lane.checks.vibe_session_visibility = 'PASS'; await save(); return;
      }
      await sleep(1000);
    }
    fail('authorized_native_sessions_not_visible_or_state_mismatch');
  }
  await save();
  try {
    if (bindings.browser?.transport !== 'vibe-mcp'
        || ['openOwnPage', 'readRows', 'capture', 'openDetails', 'closeOwnPage'].some(name => typeof (bindings.browser as any)[name] !== 'function')) fail('vibe_transport_required');
    for (const harness of SMOKE_HARNESSES) {
      const provider = bindings.native?.[harness], config = fixture.lanes[harness];
      if (!provider || provider.instanceRef !== config.instance_ref || provider.harness !== harness
          || provider.hostId !== config.host_id
          || (provider.coverageCapability ?? 'owner_active_catalog') !== (config.coverage_capability ?? 'owner_active_catalog')
          || ['preflight', 'readSession', 'readActive', 'readOwnedState', 'cancelOwned'].some(name => typeof (provider as any)[name] !== 'function')) fail('native_provider_fixture_missing');
    }
    const identity = await bindings.runtimeIdentity();
    if (identity.process_binding_verified !== true || identity.source_sha !== request.expected_source_sha
        || !/^[0-9a-f]{64}$/.test(identity.artifact_sha256) || !fresh(identity.observedAt, now()) || identity.raw == null) fail('installed_process_identity_unproven');
    report.artifact_sha256 = identity.artifact_sha256;
    report.identity_receipt_ref = await receipt('installed-identity', identity); report.identity = 'PASS'; await save();
    for (const harness of SMOKE_HARNESSES) {
      const preflight = await bindings.native[harness].preflight();
      report.native_preflight_receipts ??= {};
      report.native_preflight_receipts[harness] = await receipt(harness + '-native-preflight', preflight ?? {ready: true});
    }
    page = await bindings.browser.openOwnPage(fixture.ui_url);
    if (!Number.isSafeInteger(page) || page < 1) fail('owned_browser_page_missing');
    const preflight = await bindings.browser.readRows(page);
    if (!preflight.herder || new URL(preflight.url).origin !== new URL(fixture.ui_url).origin) fail('qa_ui_authentication_missing');
    report.ui_preflight_ref = await receipt('vibe-preflight', preflight); await save();
    for (const harness of SMOKE_HARNESSES) {
      const lane = report.lanes[harness], config = fixture.lanes[harness];
      const pairs: Array<{prompt: string; token: string}> = [];
      try {
        for (const turn of [0, 1]) {
          const token = 'HERDER_CI_' + randomUUID().replaceAll('-', '');
          const prompt = 'Reply with exactly this token and nothing else: ' + token;
          pairs.push({prompt, token}); lane.canary_turns = pairs; await save();
          const args = turn === 0
            ? {action: 'create', instance_ref: config.instance_ref, ...(config.project_ref ? {project_ref: config.project_ref} : {}), prompt, request_key: request.run_id + '-' + harness + '-create'}
            : {action: 'session', session_ref: lane.core_session_ref, message: prompt, mode: 'queue', request_key: request.run_id + '-' + harness + '-continue'};
          await waitTask(harness, await effect(harness, turn === 0 ? 'create' : 'deliver', args));
          if (!lane.core_session_ref) fail('created_session_reference_missing');
          await readTurns(harness, pairs); await findNative(harness);
          if (turn === 0) lane.checks.create = lane.checks.reply = 'PASS';
          else lane.checks.continue_same_session = lane.checks.read_both = 'PASS';
          await save();
        }
        await visible(harness, pairs);
      } catch (error) {
        lane.error_code = resultCode(error); lane.status = 'FAIL';
        if (object(error).receipt !== undefined) lane.native_error_receipt_ref = await receipt(harness + '-native-error', object(error).receipt);
        await save();
      } finally {
        if (lane.core_session_ref) {
          try {
            const nativeId = await findNative(harness), provider = bindings.native[harness];
            const binding: OwnedCanaryBinding = {runId: request.run_id, coreSessionRef: lane.core_session_ref,
              nativeId, harness, hostId: config.host_id, cwd: lane.native_cwd, createReceiptId: lane.native_delivery_receipt_ids?.[0]};
            await cleanupOwnedCanary(binding, {
              read: () => provider.readOwnedState(binding, {pairs}),
              hold: async () => {
                const held = content(await effect(harness, 'stop', {action: 'stop', session_ref: lane.core_session_ref,
                  request_key: request.run_id + '-' + harness + '-cleanup-hold'}));
                if (held.session_ref !== lane.core_session_ref || held.hold !== 'active') fail('owned_cleanup_hold_unconfirmed');
              },
              cancel: guard => provider.cancelOwned(binding, guard, {pairs}),
              archive: async () => {
                const archive = await effect(harness, 'session', {action: 'archive', session_ref: lane.core_session_ref,
                  request_key: request.run_id + '-' + harness + '-archive'});
                if (content(archive).archived !== true) fail('owned_cleanup_unconfirmed');
              },
              record: async (kind, value) => {const ref = await receipt(harness + '-cleanup-' + kind, value);
                lane.cleanup_receipts = [...(lane.cleanup_receipts ?? []), {kind, receipt_ref: ref}]; await save();},
            }, {now, sleep, deadlineMs: Math.min(deadlineMs, 45000)});
            lane.checks.owned_cleanup = 'PASS';
          } catch (error) {lane.cleanup_error_code = resultCode(error);}
          await save();
        }
      }
    }
  } catch (error) {
    report.error_code = resultCode(error);
    if (error && typeof error === 'object' && 'receipt' in error)
      report.error_receipt_ref = await receipt('preflight-original-error', (error as any).receipt);
  } finally {
    if (page !== undefined) {
      try {const closed = await bindings.browser.closeOwnPage(page);
        report.browser_cleanup_ref = await receipt('owned-ui-page-cleanup', closed ?? {closed: true}); report.browser_cleanup = 'PASS';}
      catch (error) {report.browser_cleanup = 'FAIL'; report.browser_cleanup_error = resultCode(error);
        if (object(error).receipt !== undefined) report.browser_cleanup_ref = await receipt('owned-ui-page-cleanup-unknown', object(error).receipt);
      }
    } else report.browser_cleanup = 'NOT_CREATED';
    try {const cleanup = await bindings.close();
      report.transport_cleanup_ref = await receipt('owned-transport-cleanup', cleanup ?? {closed: true});
      report.transport_cleanup = 'PASS';
    } catch (error) {report.transport_cleanup = 'FAIL';
      if (object(error).receipt !== undefined) report.transport_cleanup_ref = await receipt('owned-transport-cleanup-unknown', object(error).receipt);
    }
    report.status = report.identity === 'PASS' && report.browser_cleanup === 'PASS'
      && report.transport_cleanup !== 'FAIL' && SMOKE_HARNESSES.every(h => SMOKE_CHECKS.every(c => report.lanes[h].checks[c] === 'PASS')) ? 'PASS' : 'FAIL';
    report.functional_status = report.status;
    report.global_inventory_status = SMOKE_HARNESSES.every(h => report.lanes[h].browser_evidence?.native_catalog_complete === true)
      ? 'VERIFIED' : 'UNVERIFIED';
    await save();
  }
  return report;
}
