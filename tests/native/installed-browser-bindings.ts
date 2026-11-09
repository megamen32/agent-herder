import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {readFile, lstat} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {dirname, isAbsolute, relative, sep} from 'node:path';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {VibeMcpPort, vibeStdioParameters, parseVibeOpenedPage, parseVibeEvaluation, vibeResultText, normalizeVibePages, SERVER100_VIBE_TARGET} from '../../src/adapters/vibe-chrome-transport.js';
import {SMOKE_HARNESSES, SmokeFailure, type SmokeBindings, type NativePort, type BrowserPort, type BrowserRows, type NativeCoverageCapability} from './installed-browser-smoke.js';
import {validateCodexCanaryProof} from './installed-codex-proof.js';
import {validateZcodeCanaryProof} from './installed-zcode-proof.js';
import type {OwnedCanaryBinding, OwnedCanaryState} from './installed-owned-cleanup.js';
type Json = Record<string, any>;
const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reject = (code: string): never => {throw new SmokeFailure(code);};
const text = (x: any) => typeof x === 'string' && x.length > 0 && x.length <= 4096 && !/[\x00-\x1f]/.test(x);
async function pinned(path: string, digest: string, privateFile = false) {
  if (!text(path) || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(digest)) reject('pinned_source_required');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & (privateFile ? 0o077 : 0o022)) !== 0
      || (privateFile && info.uid !== process.getuid?.())) reject('protected_source_required');
  const raw = await readFile(path);
  if (hash(raw) !== digest) reject('protected_source_digest_mismatch');
  return raw;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => {clearTimeout(timer); resolve(true);};
    const timer = setTimeout(() => {child.off('exit', done); resolve(exited(child));}, ms);
    child.once('exit', done);
  });
}
/** Close only this child; success requires an observed exit, including escalation. */
export async function stopOwnedChild(child: ChildProcess, graceMs = 3000) {
  if (exited(child)) return;
  child.stdin?.end();
  if (await waitExit(child, graceMs)) return;
  child.kill('SIGTERM');
  if (await waitExit(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!await waitExit(child, graceMs)) reject('owned_child_exit_unconfirmed');
}

/** Private IPC only. The maintained PublicRust consumer owns HTTP/MCP/auth. */
export class PublicCorePort {
  private process: ReturnType<typeof spawn>;
  private next = 0;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: any) => void; timer: NodeJS.Timeout}>();
  private ready: Promise<void>;
  constructor(script: string, fixturePath: string, readyTimeoutMs = 20000, private closeGraceMs = 3000) {
    this.process = spawn('/usr/bin/python3', ['-I', script, fixturePath], {stdio: ['pipe', 'pipe', 'ignore'], env: process.env});
    this.ready = new Promise((resolve, fail) => {
      const readyTimer = setTimeout(() => fail(new SmokeFailure('public_auth_preflight_timeout')), readyTimeoutMs);
      const readyDone = (error?: Error) => {clearTimeout(readyTimer); error ? fail(error) : resolve();};
      const lines = createInterface({input: this.process.stdout!});
      let started = false;
      lines.on('line', line => {
        if (line.length > 2 * 1024 * 1024) {readyDone(new SmokeFailure('public_response_too_large')); return;}
        let value: any; try {value = JSON.parse(line);} catch {readyDone(new SmokeFailure('public_ipc_invalid')); return;}
        if (!started) {started = true; readyDone(value.ready === true ? undefined : new SmokeFailure('public_auth_preflight_failed')); return;}
        const entry = this.pending.get(value.id); if (!entry) return;
        this.pending.delete(value.id); clearTimeout(entry.timer);
        if (value.error) entry.reject(Object.assign(new SmokeFailure('public_operation_unknown'), {receipt: value.error.receipt}));
        else entry.resolve(value.result);
      });
      this.process.once('error', () => readyDone(new SmokeFailure('public_consumer_unavailable')));
      this.process.once('exit', () => {
        readyDone(new SmokeFailure('public_consumer_exited'));
        for (const value of this.pending.values()) {clearTimeout(value.timer); value.reject(new SmokeFailure('public_consumer_exited'));}
        this.pending.clear();
      });
    });
    void this.ready.catch(() => {});
  }
  async request(method: string, params: Json): Promise<any> {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, fail) => {
      const timer = setTimeout(() => {this.pending.delete(id); fail(new SmokeFailure('public_operation_unknown'));}, 20000);
      this.pending.set(id, {resolve, reject: fail, timer});
      this.process.stdin!.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  callTool(name: string, args: Json) {return this.request('tools/call', {name, arguments: args});}
  async close() {await stopOwnedChild(this.process, this.closeGraceMs);}
}

/** One exact profile environment and cwd per child, using its installed factory. */
const NATIVE_WORKER = 'const validateCodexCanaryProof = ' + validateCodexCanaryProof.toString() + ';\n'
  + 'const validateZcodeCanaryProof = ' + validateZcodeCanaryProof.toString() + ';\n' + String.raw`
const workerData = JSON.parse(process.argv[1]);
const {readFile} = require('node:fs/promises');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const digest = value => createHash('sha256').update(value).digest('hex');
let adapter, made, readOfficial, officialPin, modelPin;
const cancelDispatched = new Set();
let browserPrepareAttempted;
const progress = receipt => {if(process.connected)process.send({event:'native_reader_receipt',receipt});};
const state = s => ({id:s.id, harness:s.harness, hostId:s.hostId, status:s.status});
const rawState = s => ({status:s.status, needsPermission:s.needsPermission, nativeStateObserved:s.meta?.nativeStateObserved,
 activityEvidence:s.meta?.activityEvidence, activityObservedAt:s.meta?.activityObservedAt,
 activityExpiresAt:s.meta?.activityExpiresAt, runningEvidence:s.meta?.runningEvidence,
 stopVisible:s.meta?.stopVisible, archived:s.meta?.archived});
function exact(s, id) {
 if (!s || s.id !== id || s.harness !== workerData.harness || s.hostId !== workerData.hostId || s.cwd !== workerData.cwd)
  throw Error('native_canary_identity_mismatch');
 return s;
}
async function init() {
 const raw = await readFile(workerData.module);
 if (digest(raw) !== workerData.sha) throw Error('reader_bundle_changed');
 const module = await import(pathToFileURL(workerData.module).href);
 if (typeof module.makeConfiguredAdapter !== 'function') throw Error('installed_factory_missing');
 made = await module.makeConfiguredAdapter(); adapter = made.adapter || made;
 readOfficial = module.readZcodeOfficialRunning;
 if (typeof adapter.init !== 'function' || typeof adapter.getSession !== 'function') throw Error('native_reader_missing');
 if (typeof adapter.verifyPinnedAccountScope === 'function') await adapter.verifyPinnedAccountScope();
 await adapter.init();
}
async function official() {
 if (workerData.harness !== 'zcode' || adapter.nativeReadWithoutActivation !== true || typeof readOfficial !== 'function')
  throw Error('official_existing_owner_required');
 const value = await readOfficial();
 const age=Date.now()-Date.parse(value?.observedAt),ttl=Date.parse(value?.expiresAt)-Date.parse(value?.observedAt);
 if (!Number.isSafeInteger(value?.pid) || value.pid < 1 || !Number.isSafeInteger(value.generation) || value.generation < 0
     || !Array.isArray(value.tasks) || !Number.isFinite(ttl) || ttl<=0 || ttl>16000 || Date.now() >= Date.parse(value.expiresAt)
     || !Number.isFinite(age) || age < -5000 || age > 15000
     || value.tasks.some(task=>typeof task.sessionId!=='string'||!task.sessionId||typeof task.workspacePath!=='string'||!task.workspacePath.startsWith('/'))
     || new Set(value.tasks.map(task=>task.sessionId)).size!==value.tasks.length)
  throw Error('official_owner_snapshot_unavailable');
 if (officialPin && (officialPin.pid !== value.pid || officialPin.generation !== value.generation))
  throw Error('official_owner_generation_changed');
 officialPin ||= {pid:value.pid, generation:value.generation};
 return value;
}
async function active() {
 const dedicated = typeof adapter.listActiveSessions === 'function';
 const rows = await (dedicated ? adapter.listActiveSessions() : adapter.listSessions({limit:100000}));
 const receipt = dedicated ? adapter.getActiveSessionSnapshotReceipt?.() : adapter.getSessionSnapshotReceipt?.();
 if (!Array.isArray(rows)) throw Error('native_catalog_invalid');
 const known = rows.every(s => ['running','idle','needs_input','stopped','error'].includes(s.status));
 const scope = receipt?.scope ?? (workerData.harness === 'opencode' && receipt?.source === 'opencode-native-active-status'
  ? 'authorized_owner_active_sessions' : null);
 const exhaustive = receipt?.exhaustive === true && known && scope === 'authorized_owner_active_sessions';
 return {sessions:(dedicated ? rows : rows.filter(s => ['running','needs_input'].includes(s.status))).map(state),
  exhaustive, scope, observedAt:receipt?.observedAt, source:receipt?.source || workerData.module,
  partial:!exhaustive, raw:{receipt, states:rows.map(s => ({...state(s), raw:rawState(s)}))}};
}
async function officialActive() {
 const before = await official();
 const rows = await adapter.listActiveSessions();
 const combinedReceipt = adapter.getActiveSessionSnapshotReceipt?.();
 const after = await official();
 const sessions = after.tasks.map(task => {
  const matches = rows.filter(row => row.id === task.sessionId && row.harness === 'zcode'
   && row.hostId === workerData.hostId && row.cwd === task.workspacePath && ['running','needs_input'].includes(row.status));
  if (matches.length !== 1) throw Error('official_active_identity_unproven');
  return state(matches[0]);
 });
 return {sessions, exhaustive:false, partial:true, scopedComplete:true, scope:'pinned_official_server_owner',
  observedAt:after.observedAt, source:'zcode-official-server-running-tasks',
  raw:{officialBefore:before, officialAfter:after, combinedAdapterReceipt:combinedReceipt, global_inventory_status:'UNVERIFIED'}};
}
async function browserObservation(id) {
 if (browserPrepareAttempted && browserPrepareAttempted !== id) throw Error('foreign_canary_view_refused');
 if (!browserPrepareAttempted) {
  browserPrepareAttempted = id;
  progress({phase:'browser_prepare_intent',native_session_id:id,outcome:'UNKNOWN'});
  try {await adapter.prepareCanaryObservation(id);progress({phase:'browser_prepared',native_session_id:id,view:adapter.getCanaryViewReceipt?.()});}
  catch (error) {throw Object.assign(Error('owned_canary_view_preparation_unknown'), {receipt:adapter.getCanaryViewReceipt?.()});}
 }
 await adapter.verifyPinnedAccountScope();
 const result = await adapter.readCanaryObservation(id);
 exact(result.session, id);
 result.expectedAccountScope = adapter.getAccountScope();
 result.expectedOwnedPageNamespace = adapter.getOwnedPageNamespace();
 result.raw = {native_messages_receipt:result.proof?.native_messages_receipt,
  dom_generation_state_receipt:result.proof?.dom_generation_state_receipt, owned_view_receipt:result.proof?.owned_view_receipt};
 progress({phase:'browser_observed',native_session_id:id,observedAt:result.observedAt,status:result.session.status,view:adapter.getCanaryViewReceipt?.()});
 return result;
}
async function codexObservation(id, pairs) {
 if (!Array.isArray(pairs) || pairs.length !== 2) throw Error('codex_canary_pairs_required');
 exact(await adapter.getSession(id, {includeMetrics:false}), id);
 const messages = await adapter.getSessionMessages(id, 50);
 if (!Array.isArray(messages)) throw Error('codex_native_messages_unavailable');
 const ids = pairs.map(pair => {
  const matches = messages.filter(m => m?.role === 'assistant' && (m.text ?? m.content) === pair.token);
  return matches.length === 1 ? matches[0].turnId : null;
 });
 if (ids.some(id => typeof id !== 'string' || !id)) throw Error('codex_native_turn_identity_missing');
 const completion = await adapter.readTrackedTurnCompletion(id, ids[1], workerData.cwd);
 const observedAt = new Date().toISOString();
 const proof = {capability:'registered-canary-completed-turns', source:'codex-native-thread-read-completion',
  native_session_id:id, cwd:workerData.cwd, canonical_status:'idle', observed_at:observedAt,
  completed_turn_ids:ids, latest_turn_id:ids[1], fingerprint:completion?.fingerprint,
  canonical_transcript_sha256:typeof completion?.transcriptTail === 'string' ? digest(completion.transcriptTail) : null,
  native_messages_receipt:messages, canonical_completion_receipt:completion};
 validateCodexCanaryProof(proof, {nativeId:id, cwd:workerData.cwd, hostId:workerData.hostId, pairs, now:Date.now()}, digest);
 return {session:state(completion.session), complete:true, observedAt, expectedCwd:workerData.cwd, proof,
  raw:{native_messages_receipt:messages, canonical_completion_receipt:completion}};
}
async function officialTranscript(id) {
 const before = await official();
 const session = exact(await adapter.getSession(id, {includeMetrics:false}), id);
 const receipt = await adapter.getRawTranscript(id);
 if (!receipt || receipt.complete !== true || !Buffer.isBuffer(receipt.bytes)) throw Error('native_complete_transcript_missing');
 const text = receipt.bytes.toString('utf8');
 if (Buffer.byteLength(text) > 1048576) throw Error('native_transcript_limit');
 const raw = JSON.parse(text), after = await official();
 if (raw?.session?.sessionId !== id || raw.session.workspace?.workspacePath !== workerData.cwd
     || raw.session.workspace?.workspaceIdentity !== workerData.cwd || raw.projection?.sessionId !== id)
  throw Error('native_official_transcript_identity_mismatch');
 return {session, before, after, raw, receipt:{complete:receipt.complete, source:receipt.source,
  timestampCoverage:receipt.timestampCoverage, text}};
}
async function zcodeObservation(id, pairs) {
 if (!Array.isArray(pairs) || pairs.length !== 2) throw Error('zcode_canary_pairs_required');
 const value = await officialTranscript(id);
 const text = m => Array.isArray(m.parts) ? m.parts.filter(p => p?.type === 'text').map(p => p.text || '').join('') : '';
 const messages = Array.isArray(value.raw.messages) ? value.raw.messages : [];
 const userIds = pairs.map(pair => {
  const rows = messages.filter(m => m.info?.role === 'user' && m.info.synthetic !== true && text(m) === pair.prompt);
  return rows.length === 1 ? rows[0].info.messageId : null;
 });
 const assistantIds = pairs.map(pair => {
  const rows = messages.filter(m => m.info?.role === 'assistant' && m.info?.semantics?.kind === 'assistant_response' && text(m) === pair.token);
  return rows.length === 1 ? rows[0].info.messageId : null;
 });
 const observedAt = new Date().toISOString();
 const proof = {capability:'official-server-canary', source:'zcode-native-session-read+official-supervisor',
  native_session_id:id, cwd:workerData.cwd, host_id:workerData.hostId, canonical_status:value.session.status,
  create_model:modelPin?.model,
  observed_at:observedAt, official_pid:value.after.pid, official_generation:value.after.generation,
  official_before:value.before, official_after:value.after, completed_message_ids:assistantIds, user_message_ids:userIds,
  native_transcript_sha256:digest(value.receipt.text), native_transcript_receipt:value.receipt};
 validateZcodeCanaryProof(proof, {nativeId:id, cwd:workerData.cwd, hostId:workerData.hostId, createModel:modelPin?.model, pairs, now:Date.now()}, digest);
 return {session:state(value.session), complete:true, observedAt, expectedCwd:workerData.cwd, expectedCreateModel:modelPin.model, proof,
  raw:{nativeTranscript:value.receipt, officialBefore:value.before, officialAfter:value.after}};
}
function cleanupBinding(binding) {
 if (!binding || binding.harness !== workerData.harness || binding.hostId !== workerData.hostId || binding.cwd !== workerData.cwd
     || typeof binding.nativeId !== 'string' || !binding.nativeId || binding.nativeId.startsWith('session:')
     || typeof binding.coreSessionRef !== 'string' || !binding.coreSessionRef.startsWith('session:')
     || typeof binding.createReceiptId !== 'string' || !binding.createReceiptId || typeof binding.runId !== 'string' || !binding.runId)
  throw Error('owned_cleanup_authority_mismatch');
}
async function ownedState(binding, pairs) {
 cleanupBinding(binding);
 const id = binding.nativeId;
 let session, raw, terminal = false, cancellation = 'unsupported', generation;
 if (['chatgpt','zai'].includes(workerData.harness)) {
  const observed = await browserObservation(id); session = observed.session; raw = observed;
  terminal = session.status === 'idle' && observed.proof?.canonical_status === 'idle';
  generation = digest(JSON.stringify([binding, observed.proof?.account_scope_sha256,
   observed.proof?.owned_page_namespace, observed.proof?.owned_page_id, observed.proof?.native_conversation_id]));
 } else if (workerData.harness === 'codex') {
  // A separate controller has no proven authority to cancel the producing controller.
  try {const observed = await codexObservation(id, pairs);session=observed.session;raw=observed;terminal=true;}
  catch {session=exact(await adapter.getSession(id,{includeMetrics:false}),id);raw={state:rawState(session),producerCancellation:'UNSUPPORTED'};}
  generation = digest(JSON.stringify([binding, workerData.sha]));
 } else if (workerData.harness === 'zcode') {
  const observed = await officialTranscript(id); session=observed.session; raw=observed;
  const p=observed.raw.projection,r=observed.raw.runtime;
  const pending=[p?.pendingPermissions,p?.activeToolCalls,p?.backgroundJobs,r?.pendingRequestIds];
  terminal=['idle','completed','error'].includes(observed.raw.session.status)
   && ['idle','completed','error'].includes(p?.status) && pending.every(x=>Array.isArray(x)&&x.length===0)
   && !observed.after.tasks.some(task=>task.sessionId===id);
  cancellation = observed.after.tasks.some(task=>task.sessionId===id)
   && typeof p?.currentTurnId==='string' && p.currentTurnId && typeof adapter.cancelTurn==='function' ? 'supported' : 'unsupported';
  generation = digest(JSON.stringify([binding,observed.after.pid,observed.after.generation,p?.currentTurnId]));
 } else if (workerData.harness === 'opencode') {
  session=exact(await adapter.getSession(id,{includeMetrics:false}),id);
  const catalog=await active();
  if(!catalog.exhaustive||catalog.partial)throw Error('owned_cleanup_active_scope_unknown');
  terminal=['idle','stopped','error'].includes(session.status)&&!catalog.sessions.some(s=>s.id===id);
  const messages=typeof adapter.getSessionMessages==='function'?await adapter.getSessionMessages(id,50):null;
  const latestUser=Array.isArray(messages)?messages.filter(m=>m?.role==='user').at(-1):null;
  const pair=Array.isArray(pairs)?pairs.at(-1):null;
  const boundTurn=pair&&typeof pair.prompt==='string'&&typeof latestUser?.id==='string'&&latestUser.id
   && (latestUser.text??latestUser.content)===pair.prompt;
  cancellation=boundTurn&&typeof adapter.cancelTurn==='function'?'supported':'unsupported';
  raw={state:rawState(session),catalog,nativeMessages:messages,cancellationScope:'exact-created-session-current-user-message'};
  // The maintained interrupt endpoint is session scoped. Re-read the exact
  // latest native user message before dispatch; never claim an atomic turn CAS.
  generation=digest(JSON.stringify([binding,workerData.sha,boundTurn?latestUser.id:null,boundTurn?latestUser.turnId:null,boundTurn?pair.prompt:null]));
 } else throw Error('owned_cleanup_harness_unsupported');
 return {nativeId:id,harness:workerData.harness,hostId:workerData.hostId,cwd:workerData.cwd,
  observedAt:new Date().toISOString(),status:session.status,terminal,cancellation,generation,raw};
}
async function handle({id, method, args}) {
 try {
  let result;
  if (method === 'preflight') {
   if (!adapter) await init();
   if(workerData.harness==='zcode'){
    const pin=process.env.AHAP_ZCODE_CREATE_MODEL;
    if(typeof pin!=='string'||adapter.getPinnedCreateModel?.()!==pin||typeof adapter.verifyPinnedCreateModel!=='function')
     throw Error('explicit_zcode_create_model_pin_required');
    modelPin=await adapter.verifyPinnedCreateModel();
    if(modelPin?.model!==pin||modelPin.source!=='zcode-native-create-model-catalog'
      ||!Number.isFinite(Date.parse(modelPin.observed_at))||Math.abs(Date.now()-Date.parse(modelPin.observed_at))>15000)
     throw Error('native_zcode_create_model_pin_unproven');
   }
   if (workerData.capability === 'owned_current_conversations') {
    if (!['chatgpt','zai'].includes(workerData.harness) || typeof adapter.readCanaryObservation !== 'function' || typeof adapter.prepareCanaryObservation !== 'function'
      || typeof adapter.closeCanaryObservation !== 'function' || typeof adapter.getCanaryViewReceipt !== 'function'
      || !/^[a-f0-9]{64}$/.test(adapter.getAccountScope?.() || '') || !/^vibe-[a-f0-9]{64}$/.test(adapter.getOwnedPageNamespace?.() || ''))
     throw Error('owned_conversation_capability_missing');
   } else if (workerData.capability === 'registered_canary_completed_turns') {
    if (workerData.harness !== 'codex' || typeof adapter.getSessionMessages !== 'function' || typeof adapter.readTrackedTurnCompletion !== 'function')
     throw Error('codex_completion_capability_missing');
   } else if (workerData.capability === 'pinned_official_server_owner') {
    if (workerData.harness !== 'zcode' || typeof adapter.getRawTranscript !== 'function') throw Error('official_canary_capability_missing');
    await official();
   } else {const catalog=await active();if(!catalog.exhaustive||catalog.partial)throw Error('native_catalog_not_exhaustive');}
   result={ready:true,...(modelPin?{model_pin:modelPin}:{})};
  } else if (method === 'readActive') {
   result=workerData.capability==='pinned_official_server_owner'?await officialActive():workerData.capability==='owner_active_catalog'?await active():
    {sessions:[],exhaustive:false,partial:true,scope:workerData.capability,observedAt:new Date().toISOString(),
     source:'native-global-active-inventory-unsupported',raw:{capability:workerData.capability,global_inventory_status:'UNVERIFIED'}};
  } else if (method === 'readSession') {
   if(workerData.capability==='owned_current_conversations')result=await browserObservation(args[0]);
   else if(workerData.capability==='registered_canary_completed_turns')result=await codexObservation(args[0],args[1]?.pairs);
   else if(workerData.capability==='pinned_official_server_owner')result=await zcodeObservation(args[0],args[1]?.pairs);
   else {const s=exact(await adapter.getSession(args[0],{includeMetrics:false}),args[0]);
    result={session:state(s),complete:true,observedAt:new Date().toISOString(),raw:rawState(s)};}
  } else if (method === 'readOwnedState') result=await ownedState(args[0],args[1]?.pairs);
  else if (method === 'cancelOwned') {
   const [binding,guard,expected]=args;cleanupBinding(binding);
   const key=binding.runId+':'+binding.nativeId;
   if(cancelDispatched.has(key))throw Error('owned_cancel_replay_refused');
   const current=await ownedState(binding,expected?.pairs);
   if(current.terminal)result={accepted:false,raw:{terminalAlready:true}};
   else {
    if(current.generation!==guard?.generation||current.cancellation!=='supported'
      || !['opencode','zcode'].includes(workerData.harness))throw Error('owned_cancel_generation_or_capability_unproven');
    cancelDispatched.add(key);
    const receipt=await adapter.cancelTurn(binding.nativeId);
    result={accepted:receipt?.ok===true,raw:receipt};
   }
  } else if (method === 'close') {
   let view;
   try {if(typeof adapter?.closeCanaryObservation==='function'){
    const prepared=adapter.getCanaryViewReceipt?.();
    if(prepared?.receipt){
     if(prepared.control!==browserPrepareAttempted)throw Error('owned_view_control_changed');
     const final=await browserObservation(prepared.control);
     if(final.session.status!=='idle'||Date.now()-Date.parse(final.observedAt)>15000)throw Error('owned_view_not_fresh_terminal');
    }
    view=await adapter.closeCanaryObservation();
   }}
   catch {throw Object.assign(Error('owned_canary_view_cleanup_unconfirmed'),{receipt:adapter.getCanaryViewReceipt?.()});}
   finally {if(typeof adapter?.close==='function')await adapter.close();else if(typeof adapter?.dispose==='function')await adapter.dispose();}
   result={closed:true,view};
  } else throw Error('unsupported_private_reader_operation');
  process.send({id,result},()=>{if(method==='close')process.disconnect();});
 } catch(error) {
  const receipt=error?.receipt??(['chatgpt','zai'].includes(workerData.harness)?adapter?.getCanaryViewReceipt?.():undefined);
  process.send({id,error:{code:'native_read_or_coverage_failed',...(receipt===undefined?{}:{receipt})}});
 }
}
// A parent deadline does not cancel a dispatched operation. Serialize all
// follow-up reads and close behind it; never race SDK cleanup against prepare.
let serial = Promise.resolve();
process.on('message', message => {serial=serial.then(()=>handle(message)).catch(()=>{process.exitCode=1;process.disconnect();});});
`;
export class NativeWorkerPort implements NativePort {
  readonly coverageCapability: NativeCoverageCapability;
  private worker: ChildProcess; private next = 0;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: any) => void; timer: NodeJS.Timeout}>();
  private closing?: Promise<unknown>;
  private latestReceipt?: unknown;
  constructor(public instanceRef: string, public harness: string, public hostId: string,
              module: string, sha: string, env: NodeJS.ProcessEnv, cwd: string, node: string, capability: NativeCoverageCapability,
              private testTimeouts: Partial<Record<'readSession' | 'close', number>> = {}) {
    this.coverageCapability = capability;
    this.worker = spawn(node, ['-e', NATIVE_WORKER, JSON.stringify({module, sha, capability, harness, hostId, cwd})],
      {cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
    // Provider logs can contain private session metadata. They never reach CI output.
    this.worker.stdout!.resume(); this.worker.stderr!.resume();
    this.worker.on('message', value => {
      if (value.event === 'native_reader_receipt') {this.latestReceipt = value.receipt; return;}
      const request = this.pending.get(value.id); if (!request) return;
      this.pending.delete(value.id); clearTimeout(request.timer);
      value.error ? request.reject(Object.assign(new SmokeFailure('native_read_or_coverage_failed'), {receipt: value.error.receipt})) : request.resolve(value.result);
    });
    const stopped = () => {for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(new SmokeFailure('native_reader_exited'));} this.pending.clear();};
    this.worker.on('error', stopped); this.worker.on('exit', stopped);
  }
  private call(method: string, args: any[] = []): Promise<any> {
    if (this.closing && method !== 'close') return Promise.reject(new SmokeFailure('native_reader_closing'));
    const id = ++this.next;
    // Real fresh browser proof took 121 seconds. This budget remains bounded
    // below the fixed helper's wall clock; CLI readers retain their 45s bound.
    const budget = ['chatgpt', 'zai'].includes(this.harness) ? 180000 : 45000;
    const override = this.testTimeouts[method as 'readSession' | 'close'];
    const timeout = override === undefined ? budget : Math.min(budget, Math.max(1, override));
    return new Promise((resolve, fail) => {
      const timer = setTimeout(() => {this.pending.delete(id);
        fail(Object.assign(new SmokeFailure('native_read_timeout'), {receipt: {operation: method, outcome: 'UNKNOWN', progress: this.latestReceipt}}));
      }, timeout);
      this.pending.set(id, {resolve, reject: fail, timer});
      this.worker.send!({id, method, args}, error => {if (error) {
        this.pending.delete(id); clearTimeout(timer);
        fail(Object.assign(new SmokeFailure('native_reader_ipc_unknown'), {receipt: {operation: method, outcome: 'UNKNOWN', progress: this.latestReceipt}}));
      }});
    });
  }
  async preflight() {return await this.call('preflight');}
  readSession(id: string, expected?: {pairs: Array<{prompt: string; token: string}>}) {return this.call('readSession', [id, expected]);}
  readActive() {return this.call('readActive');}
  readOwnedState(binding: OwnedCanaryBinding, expected?: {pairs: Array<{prompt: string; token: string}>}) {return this.call('readOwnedState', [binding, expected]);}
  cancelOwned(binding: OwnedCanaryBinding, guard: OwnedCanaryState, expected?: {pairs: Array<{prompt: string; token: string}>}) {return this.call('cancelOwned', [binding, guard, expected]);}
  close(): Promise<unknown> {
    // Store the first outcome, including UNKNOWN. Never dispatch a second close.
    return this.closing ??= (async () => {
      if (exited(this.worker)) reject('native_reader_exited_without_close_receipt');
      try {return await this.call('close');} finally {await stopOwnedChild(this.worker);}
    })();
  }
}

/** Mirrors owner_opencode.rs::build, including explicit profile overrides. */
export function nativeLaunchContext(owner: Json, _inherited: NodeJS.ProcessEnv = process.env) {
  if (!text(owner.code_home) || !isAbsolute(owner.code_home) || !text(owner.cwd) || !isAbsolute(owner.cwd)
      || !owner.ahap_env || typeof owner.ahap_env !== 'object' || Array.isArray(owner.ahap_env)) reject('native_launch_context_missing');
  if (Object.entries(owner.ahap_env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof value !== 'string' || value.includes('\0'))) reject('native_profile_environment_invalid');
  const env: NodeJS.ProcessEnv = {HOME: owner.code_home, PATH: '/usr/bin:/bin'};
  if (owner.ahap_base_url !== undefined) {
    if (!text(owner.ahap_base_url)) reject('native_profile_environment_invalid');
    env.AHAP_OPENCODE_BASE_URL = owner.ahap_base_url;
  }
  Object.assign(env, owner.ahap_env);
  // AhapClient applies these after env_clear plus the exact owner environment.
  env.AHAP_VERSION = '0.1'; env.AHAP_HARNESS = owner.kind;
  return {env, cwd: owner.cwd as string};
}

export class InstalledVibeBrowser implements BrowserPort {
  readonly transport = 'vibe-mcp' as const;
  private owned = new Set<number>(); private nonce = randomUUID(); private marker = 'herder-ci-anchor-' + this.nonce;
  private closeAttempts = new Map<number, unknown>();
  private fixtureReceipt: unknown;
  constructor(private port: Pick<VibeMcpPort, 'callTool'>, private expectedUrl: string,
    private attest?: (pageId: number, nonce: string) => Promise<unknown>) {}
  private ownedPage(id: number) {if (!Number.isSafeInteger(id) || id < 1 || !this.owned.has(id)) reject('foreign_browser_page_refused');}
  private async evaluate<T>(id: number, fn: string, args: string[] = []): Promise<T> {
    this.ownedPage(id); return parseVibeEvaluation<T>(await this.port.callTool('evaluate_script', {tabId: id, function: fn, args}));
  }
  async openOwnPage(url: string) {
    if (url !== this.expectedUrl) reject('fixture_ui_url_changed');
    const id = parseVibeOpenedPage(await this.port.callTool('new_page', {url, focus: false, waitForReady: true}));
    if (id < 1 || this.owned.has(id)) reject('owned_browser_page_missing');
    this.owned.add(id);
    const marker = await this.evaluate<string>(id, '(marker) => { window.name = marker; return window.name; }', [this.marker]);
    if (marker !== this.marker) reject('browser_ownership_marker_missing');
    if (this.attest) this.fixtureReceipt = await this.attest(id, this.nonce);
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await this.evaluate<boolean>(id, '() => Boolean(document.querySelector("#herder-chat-list"))');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) reject('qa_ui_authentication_missing');
    await this.evaluate(id, '() => { const reset=document.querySelector("button.sessions-counter-button"); if(reset)reset.click(); return Boolean(reset); }');
    return id;
  }
  async readRows(id: number): Promise<BrowserRows> {
    const view = await this.evaluate<BrowserRows>(id, `(marker) => {
      if(window.name!==marker)throw Error("browser_ownership_changed");
      const shown=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=="hidden";
      const list=document.querySelector("#herder-chat-list");
      const rows=Array.from(document.querySelectorAll("button.session-row[data-native-session-id]")).filter(shown)
        .map(el=>({nativeId:el.dataset.nativeSessionId,harness:el.dataset.harness,hostId:el.dataset.hostId||"",status:el.dataset.status}));
      const more=list&&Array.from(list.querySelectorAll("button")).find(el=>shown(el)&&!el.disabled&&
        (el.textContent.startsWith("Показать ещё")||el.textContent.startsWith("Догрузить ещё")));
      if(more)more.click();
      return {url:location.href,herder:Boolean(list),rows,raw:{marker:window.name,renderedRows:rows.length,more:Boolean(more)}};
    }`, [this.marker]);
    view.raw = {dom: view.raw, fixtureAttestation: this.fixtureReceipt};
    return view;
  }
  async capture(id: number, nativeId: string, harness: string, hostId: string) {
    this.ownedPage(id);
    await this.evaluate(id, `(encoded) => {const x=JSON.parse(encoded);
      const row=Array.from(document.querySelectorAll("button.session-row")).find(el=>
        el.dataset.nativeSessionId===x.nativeId&&el.dataset.harness===x.harness&&el.dataset.hostId===x.hostId);
      if(!row)throw Error("native_row_missing");row.scrollIntoView({block:"center"});return true;}`,
      [JSON.stringify({nativeId, harness, hostId})]);
    return {dom: await this.port.callTool('take_snapshot', {pageId: id, format: 'aria', compact: true, maxDepth: 6, scopeSelector: '#herder-chat-list'}),
      image: await this.port.callTool('take_screenshot', {tabId: id, detail: 'low', maxWidth: 1200, quality: 40})};
  }
  async openDetails(id: number, expected: {nativeId: string; harness: string; hostId: string; tokens: string[]}) {
    await this.evaluate(id, `(encoded) => {const x=JSON.parse(encoded);
      const row=Array.from(document.querySelectorAll("button.session-row")).find(el=>
        el.dataset.nativeSessionId===x.nativeId&&el.dataset.harness===x.harness&&el.dataset.hostId===x.hostId);
      if(!row)throw Error("native_row_missing");row.click();return true;}`, [JSON.stringify(expected)]);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const result = await this.evaluate<any>(id, `(encoded, marker) => {
        if(window.name!==marker)throw Error("browser_ownership_changed");
        const x=JSON.parse(encoded),shown=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=="hidden";
        const panel=Array.from(document.querySelectorAll('.chat-pane[data-details-verified="true"],.remote-chat-pane[data-details-verified="true"]')).find(el=>shown(el)&&
          el.dataset.nativeSessionId===x.nativeId&&el.dataset.harness===x.harness&&el.dataset.hostId===x.hostId);
        if(!panel)return null;
        const assistant=Array.from(panel.querySelectorAll("article.message.assistant")).filter(shown).map(el=>el.innerText);
        return {nativeId:panel.dataset.nativeSessionId,harness:panel.dataset.harness,hostId:panel.dataset.hostId,
          visibleAssistantTokens:x.tokens.filter(token=>assistant.some(text=>text.includes(token))),
          raw:{detailsVerified:true,assistantMessages:assistant.length}};
      }`, [JSON.stringify(expected), this.marker]);
      if (result && expected.tokens.every(token => result.visibleAssistantTokens.includes(token))) {
        result.raw.snapshot = await this.port.callTool('take_snapshot', {pageId: id, format: 'aria', compact: true, maxDepth: 8, scopeSelector: '[data-details-verified="true"]'});
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    reject('verified_native_details_missing');
  }
  async closeOwnPage(id: number) {
    this.ownedPage(id);
    if (!this.closeAttempts.has(id)) {
      this.closeAttempts.set(id, {outcome: 'UNKNOWN'});
      try {this.closeAttempts.set(id, await this.port.callTool('close_page', {pageId: id}));}
      catch (error) {this.closeAttempts.set(id, {outcome: 'UNKNOWN', receipt: (error as any)?.receipt});}
    }
    let confirmation: unknown;
    try {
      confirmation = await this.port.callTool('list_pages', {});
      const pages = normalizeVibePages(vibeResultText(confirmation));
      if (pages.split('\n').some(line => line.startsWith(id + ':'))) throw Error('still present');
    } catch {
      throw Object.assign(new SmokeFailure('owned_browser_cleanup_unconfirmed'), {
        receipt: {page_id: id, close_attempted: true, close_receipt: this.closeAttempts.get(id), confirmation},
      });
    }
    this.owned.delete(id);
    return {page_id: id, closed: true, close_receipt: this.closeAttempts.get(id), confirmation};
  }
  async close() {
    const results = await Promise.allSettled([...this.owned].map(id => this.closeOwnPage(id)));
    if (results.some(result => result.status === 'rejected')) throw Object.assign(new SmokeFailure('owned_browser_cleanup_unconfirmed'), {
      receipt: results.map(result => result.status === 'fulfilled' ? result.value : result.reason?.receipt),
    });
  }
}

/** Read the release's own artifact mapping, never a caller-asserted source label. */
export async function readProcessArtifactSource(artifact: Json, expectedSource: string) {
  const binding = artifact.source_manifest;
  if (!binding || !['fleet-build', 'noticeplace-build'].includes(binding.format))
    reject('process_artifact_source_manifest_required');
  const manifest = JSON.parse((await pinned(binding.path, binding.sha256)).toString());
  const source = binding.format === 'fleet-build' ? manifest.sourceSha : manifest.source_commit;
  if (!/^[a-f0-9]{40}$/.test(expectedSource) || !/^[a-f0-9]{40}$/.test(source) || source !== expectedSource)
    reject('running_component_source_mismatch');
  if (!text(artifact.path) || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    reject('running_component_artifact_unbound');
  const path = relative(dirname(binding.path), artifact.path).split(sep).join('/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) reject('running_component_artifact_unbound');
  const declared = binding.format === 'fleet-build'
    ? (path === 'dist/index.js' ? manifest.artifacts?.dist?.indexSha256 : undefined)
    : manifest.files?.[path];
  if (declared !== artifact.sha256) reject('running_component_artifact_unbound');
  return {source_sha: source, manifest_path: binding.path, manifest_sha256: binding.sha256,
    manifest_format: binding.format, artifact_path: artifact.path, artifact_sha256: declared};
}

async function processIdentity(config: Json, expectedArtifact: string) {
  const manifest = JSON.parse((await pinned(config.manifest_path, expectedArtifact)).toString());
  if (!['source_sha', 'source_commit', 'sourceCommit'].includes(config.source_field)) reject('source_manifest_field_required');
  const source = manifest[config.source_field];
  if (!/^[a-f0-9]{40}$/.test(source) || !Array.isArray(config.processes) || !config.processes.length) reject('installed_process_binding_required');
  const ticks = Number((await exec('/usr/bin/getconf', ['CLK_TCK'])).stdout.trim());
  const boot = Number((await readFile('/proc/stat', 'utf8')).match(/^btime (\d+)$/m)?.[1]);
  if (!(ticks > 0) || !(boot > 0)) reject('process_clock_unavailable');
  const proofs = [];
  for (const item of config.processes) {
    let pid: number;
    if (text(item.systemd_unit) && /^[a-zA-Z0-9_.@-]+\.service$/.test(item.systemd_unit)) {
      pid = Number((await exec('/bin/systemctl', [...(item.user_unit === true ? ['--user'] : []), 'show', '--property=MainPID', '--value', item.systemd_unit])).stdout.trim());
    } else if (text(item.pid_file) && isAbsolute(item.pid_file)) pid = Number((await readFile(item.pid_file, 'utf8')).trim());
    else reject('exact_running_process_selector_required');
    if (!Number.isSafeInteger(pid!) || pid! < 1) reject('running_process_missing');
    const prefix = '/proc/' + pid!, argv = (await readFile(prefix + '/cmdline', 'utf8')).split('\0').filter(Boolean);
    const stats = await readFile(prefix + '/stat', 'utf8'), fields = stats.slice(stats.lastIndexOf(')') + 2).split(' ');
    const started = (boot + Number(fields[19]) / ticks) * 1000;
    const executable = hash(await readFile(prefix + '/exe'));
    if (executable !== item.executable_sha256 || !Array.isArray(item.argv_artifacts) || !item.argv_artifacts.length) reject('running_executable_binding_mismatch');
    const artifacts = [];
    for (const artifact of item.argv_artifacts) {
      await pinned(artifact.path, artifact.sha256);
      if (!argv.includes(artifact.path) || (await lstat(artifact.path)).mtimeMs > started + 1000) reject('running_bundle_binding_mismatch');
      const sourceProof = await readProcessArtifactSource(artifact, source);
      if ((await lstat(sourceProof.manifest_path)).mtimeMs > started + 1000) reject('running_component_manifest_newer_than_process');
      artifacts.push({path: artifact.path, sha256: artifact.sha256, source_proof: sourceProof});
    }
    proofs.push({pid, executable_sha256: executable, started_at: new Date(started).toISOString(), artifacts});
  }
  return {source_sha: source, artifact_sha256: expectedArtifact, process_binding_verified: true,
    observedAt: new Date().toISOString(), raw: {manifest_path: config.manifest_path, processes: proofs}};
}
/** The fixed manager correlates the exact isolated profile, Vibe page and live processes. */
export function verifyBrowserFixtureProof(value: Json, fixture: Json, expected?: {generation: string; pageId: number; nonce: string}) {
  const vibe = fixture.bindings.vibe;
  const observed = typeof value?.observed_at === 'string' ? Date.parse(value.observed_at) : NaN;
  if (value?.schema !== 'agent-herder.ci-browser-proof.v1' || value.status !== 'PASS' || value.managed !== true
      || value.profile_path !== fixture.qa.profile_ref || value.session !== fixture.qa.browser_session
      || value.namespace !== fixture.qa.browser_namespace || !text(value.generation)
      || value.config_sha256 !== fixture.bindings.browser_manager?.config_sha256
      || !Number.isFinite(observed) || Date.now() - observed < -5000 || Date.now() - observed > 30000
      || value.authenticated !== true || value.api_status !== 200 || !text(value.cli_tab_id)
      || typeof value.api_content_type !== 'string' || value.api_content_type.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || value.origin !== new URL(fixture.ui_url).origin
      || ['daemon', 'browser', 'relay'].some(kind => !Number.isSafeInteger(value[kind + '_pid']) || value[kind + '_pid'] < 1
        || typeof value[kind + '_start_ticks'] !== 'string' || !/^[1-9][0-9]*$/.test(value[kind + '_start_ticks']))
      || value.relay?.agent_port !== vibe.relayPort || value.relay?.extension_port !== vibe.relayPort + 1
      || value.relay?.state_dir !== vibe.relayStateDir || value.relay?.session_id !== vibe.sessionId)
    reject('isolated_browser_fixture_binding_mismatch');
  if (expected && (value.vibe_page_correlated !== true || value.generation !== expected.generation || value.page_id !== expected.pageId
      || value.marker !== 'herder-ci-anchor-' + expected.nonce))
    reject('isolated_browser_page_attestation_mismatch');
  return value;
}
async function browserFixtureManager(fixture: Json) {
  const manager = fixture.bindings.browser_manager;
  if (!manager || manager.config_path !== '/etc/agent-herder-ci-smoke/browser-fixture.json')
    reject('protected_browser_fixture_manager_required');
  await pinned(manager.script_path, manager.script_sha256);
  // Topology is controlled by root, readable only by the actual runtime owner group.
  const info = await lstat(manager.config_path);
  if (info.uid !== 0 || info.gid !== process.getgid?.() || (info.mode & 0o777) !== 0o640)
    reject('trusted_browser_configuration_required');
  await pinned(manager.config_path, manager.config_sha256);
  const invoke = async (args: string[]) => {
    let raw: string;
    try {
      raw = (await exec(fixture.node_executable, [manager.script_path, '--config', manager.config_path, ...args],
        {timeout: 60000, maxBuffer: 262144, env: process.env})).stdout;
    } catch {reject('isolated_browser_fixture_unverified');}
    try {return JSON.parse(raw!);} catch {reject('isolated_browser_fixture_receipt_invalid');}
  };
  // A missing managed relay fails before the SDK can bootstrap an unmanaged replacement.
  const verified = verifyBrowserFixtureProof(await invoke(['verify']), fixture);
  return async (pageId: number, nonce: string) => {
    if (!Number.isSafeInteger(pageId) || pageId < 1 || !/^[a-f0-9-]{36}$/.test(nonce)) reject('owned_browser_attestation_identity_invalid');
    return verifyBrowserFixtureProof(await invoke(['attest', '--page-id', String(pageId), '--nonce', nonce]), fixture,
      {generation: verified.generation, pageId, nonce});
  };
}

export async function createInstalledSmokeBindings(fixture: Json): Promise<SmokeBindings> {
  const config = fixture.bindings;
  if (!config || !text(fixture.fixture_path) || !isAbsolute(fixture.fixture_path)) reject('fixed_bindings_configuration_required');
  const missing = SMOKE_HARNESSES.filter(harness => !config.native_profiles?.[harness]);
  if (missing.length) throw Object.assign(new SmokeFailure('native_profiles_missing'), {
    receipt: {missing_harnesses: missing, model_effects: 'NOT_SUBMITTED'},
  });
  if (config.vibe?.target !== SERVER100_VIBE_TARGET || config.vibe?.relayPort === 19888
      || !config.vibe?.relayPort || !config.vibe?.relayStateDir || !config.vibe?.sessionId) reject('dedicated_pinned_vibe_required');
  await pinned(config.public_bridge_path, config.public_bridge_sha256);
  await pinned(fixture.node_executable, fixture.node_sha256);
  const attestBrowser = await browserFixtureManager(fixture);
  const native: Record<string, NativeWorkerPort> = {};
  let core: PublicCorePort | undefined, vibe: VibeMcpPort | undefined, browser: InstalledVibeBrowser | undefined;
  try {
    for (const harness of SMOKE_HARNESSES) {
      const binding = config.native_profiles?.[harness], lane = fixture.lanes[harness];
      if (!binding) reject('native_profile_missing');
      const profile = JSON.parse((await pinned(binding.profile_path, binding.profile_sha256, true)).toString());
      await pinned(binding.adapter_path, binding.adapter_sha256);
      const owner = profile.owner;
      if (owner?.kind !== harness || owner?.instance !== lane.instance_ref || !text(binding.node_ref) || owner?.node !== binding.node_ref
          || owner?.ahap_script !== binding.adapter_path) reject('native_profile_identity_mismatch');
      const {env, cwd} = nativeLaunchContext(owner);
      native[harness] = new NativeWorkerPort(lane.instance_ref, harness, lane.host_id, binding.adapter_path, binding.adapter_sha256, env, cwd, fixture.node_executable, lane.coverage_capability ?? 'owner_active_catalog');
    }
    core = new PublicCorePort(config.public_bridge_path, fixture.fixture_path);
    vibe = new VibeMcpPort(() => new StdioClientTransport(vibeStdioParameters(config.vibe)));
    browser = new InstalledVibeBrowser(vibe, fixture.ui_url, attestBrowser);
    return {core, browser, native: native as any,
      runtimeIdentity: () => processIdentity(config.runtime_identity, fixture.expected_artifact_sha256),
      async close() {
        let pageCleanupFailed = false;
        try {await browser!.close();} catch {pageCleanupFailed = true;}
        const results = await Promise.allSettled([...Object.values(native).map(port => port.close()), core!.close(), vibe!.close()]);
        const receipt = {browser: pageCleanupFailed ? 'UNKNOWN' : 'CLOSED',
          transports: results.map((result, index) => ({name: [...SMOKE_HARNESSES, 'core', 'vibe'][index],
            ...(result.status === 'fulfilled' ? {closed: true, receipt: result.value}
              : {closed: false, outcome: 'UNKNOWN', receipt: result.reason?.receipt})}))};
        if (pageCleanupFailed || results.some(result => result.status === 'rejected'))
          throw Object.assign(new SmokeFailure('owned_transport_cleanup_failed'), {receipt});
        return receipt;
      }};
  } catch (error) {
    if (browser) try {await browser.close();} catch {}
    await Promise.allSettled([...Object.values(native).map(port => port.close()), ...(core ? [core.close()] : []), ...(vibe ? [vibe.close()] : [])]);
    throw error;
  }
}

