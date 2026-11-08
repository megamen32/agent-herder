import { createHash } from 'node:crypto';
import type { AgentSession } from '../types/common.js';
import { incidentSessionPolicy, IncidentSessionRouter } from './incident-session-router.js';
import type { ProjectLaunchRunner } from './project-launch-dispatch.js';
import type { NamedSessionResult } from '../named-session.js';
import { HUMAN_STOP_MESSAGE } from '../human-stop-actions.js';
import { NOTICEPLACE_V1_MODEL } from './v1-noticeplace-launch.js';
import type { GptAdminTransport } from '../mesh/gptadmin.js';

export interface NoticePlaceRustToolPort {
  call(tool: 'sessions' | 'create' | 'deliver' | 'compat_task' | 'stop', args: Record<string, unknown>, operationKey?: string): Promise<unknown>;
}

/** Route calls through the already authenticated shared GPTAdmin child MCP ref. */
export function createNoticePlaceGptAdminPort(hub: GptAdminTransport, target: string): NoticePlaceRustToolPort {
  if (!/^mcp:shell:[a-zA-Z0-9.-]+:AgentHerder$/u.test(target)) throw new Error('NoticePlace Rust target must be an explicitly configured AgentHerder child ref');
  return { call: (tool,args,key) => hub.call(target,tool,args,key) };
}

export type NoticePlaceRustInstance = {
  instanceRef: string;
  harness: 'opencode';
  model: typeof NOTICEPLACE_V1_MODEL;
  /** Exact trusted workspace configured for this instance; Rust create has no cwd input. */
  cwd: string;
  deliveryMode: 'start' | 'queue';
};

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** The compatibility tool's documented result wrapper contains one structuredContent layer. */
function toolValue(value: unknown): Record<string, unknown> {
  const root = obj(value) ?? {};
  return obj(root.structuredContent) ?? root;
}
type RustTaskRead = {kind:'working'} | {kind:'unknown'} | {kind:'completed'; data:Record<string,unknown>; isError?:boolean};
const TASK_POLL_INTERVAL_MS = 250;
const TASK_POLL_DEADLINE_MS = 12_000;
async function readTask(port: NoticePlaceRustToolPort, taskRef: string, key: string): Promise<RustTaskRead> {
  const deadline = Date.now() + TASK_POLL_DEADLINE_MS;
  do {
    let raw: unknown;
    try { raw = await port.call('compat_task', { action: 'get', task_ref: taskRef }); }
    catch { return {kind:'unknown'}; }
    const task = toolValue(raw);
    if (task.taskId !== taskRef || task.resultType !== 'complete') return {kind:'unknown'};
    if (task.status === 'completed') {
      const result = obj(task.result);
      const structured = obj(result?.structuredContent);
      if (!result || !structured || (result.isError !== undefined && typeof result.isError !== 'boolean')) return {kind:'unknown'};
      return {kind:'completed',data:structured,...(typeof result.isError === 'boolean'?{isError:result.isError}:{})};
    }
    if (task.status !== 'working' || Date.now() + TASK_POLL_INTERVAL_MS >= deadline) return {kind:'unknown'};
    await new Promise(resolve => setTimeout(resolve,TASK_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return {kind:'unknown'};
}
function taskRef(value: unknown): string | undefined {
  const root = toolValue(value);
  const ref = root.task_ref ?? ((root.resultType === 'task' || root.native_task === true) ? root.taskId : undefined)
    ?? root._herder_create_task ?? root._herder_delivery_task;
  return typeof ref === 'string' && ref.trim() ? ref : undefined;
}
function rustHumanStop(value: Record<string,unknown>): boolean {
  const prompt = obj(value.prompt);
  const code = value.code ?? prompt?.code;
  return code === 'human_stop' || code === 'human_stop_active';
}
type CreatePromptReceipt = {sessionRef?:string; state:'admitted'|'human_stop'|'not_sent'|'unknown'};
function createPromptReceipt(task: RustTaskRead): CreatePromptReceipt {
  if (task.kind !== 'completed') return {state:'unknown'};
  const {data,isError} = task;
  const create = obj(data.create), prompt = obj(data.prompt);
  if (!create || !prompt) return {state:'unknown'};
  const sessionRef = create.effect === 'confirmed' && typeof create.session_ref === 'string' && create.session_ref.trim()
    ? create.session_ref : undefined;
  if (rustHumanStop(data)) return {state:'human_stop',...(sessionRef?{sessionRef}:{})};
  // A generic task/error flag is not evidence of no effect. Only the exact
  // Rust structured effect and final prompt outcome decide admission.
  if (create.effect === 'none' && prompt.effect === 'none') return {state:'not_sent'};
  if (create.effect !== 'confirmed' || !sessionRef) return {state:'unknown'};
  if (prompt.effect === 'none') return {state:'not_sent',sessionRef};
  if (isError !== true && prompt.outcome === 'confirmed') return {state:'admitted',sessionRef};
  // In particular create.confirmed + prompt.UNKNOWN retains sessionRef.
  return {state:'unknown',sessionRef};
}
type DeliverReceipt = {state:'admitted'|'human_stop'|'not_sent'|'unknown'};
function deliverReceipt(task: RustTaskRead): DeliverReceipt {
  if (task.kind !== 'completed') return {state:'unknown'};
  const {data,isError} = task;
  if (rustHumanStop(data)) return {state:'human_stop'};
  if (data.effect === 'none' && (data.code === 'adapter_refused' || data.code === 'human_stop' || data.code === 'human_stop_active')) return {state:'not_sent'};
  if (isError !== true && data.outcome === 'confirmed' && typeof data.native_receipt_id === 'string' && data.native_receipt_id)
    return {state:'admitted'};
  return {state:'unknown'};
}

function nativeSession(row: Record<string, unknown>, instance: NoticePlaceRustInstance): AgentSession | undefined {
  if (typeof row.session_ref !== 'string' || !row.session_ref) return;
  const native = obj(row.native) ?? {};
  const status = typeof native.status === 'string' ? native.status : 'running';
  return {
    id: row.session_ref, harness: instance.harness, cwd: instance.cwd, hostId: 'rust-instance',
    status: status as AgentSession['status'], title: typeof native.title === 'string' ? native.title : 'NoticePlace incident repair',
    lastActivity: typeof native.lastActivity === 'string' ? native.lastActivity : new Date(0).toISOString(),
    needsPermission: false,
  };
}

async function findBoundSession(port: NoticePlaceRustToolPort, instance: NoticePlaceRustInstance, sessionRef: string): Promise<AgentSession | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const result = toolValue(await port.call('sessions', {action:'list',instance_ref:instance.instanceRef,...(cursor?{cursor}:{})}));
    for (const row of Array.isArray(result.sessions) ? result.sessions : []) {
      const session = obj(row);
      if (session?.session_ref === sessionRef) return nativeSession(session,instance) ?? null;
    }
    if (typeof result.next_cursor !== 'string' || !result.next_cursor) return null;
    cursor = result.next_cursor;
  }
  return null;
}

/** Source-group registry is the existing TS durable binding; Rust remains the write/hold authority. */
export function createNoticePlaceIncidentRouter(path: string, port: NoticePlaceRustToolPort, instance: NoticePlaceRustInstance): IncidentSessionRouter {
  return new IncidentSessionRouter(path, {
    readSession: (_harness, sessionRef) => findBoundSession(port,instance,sessionRef),
    // Keep every bound source attached to its exact Rust reference. Rust deliver
    // decides HumanStop; an ended/held binding must never escape into fresh create.
    unfinished: async () => true,
    held: async () => false,
  });
}

/** Read exact stored session references and delegate every write/stop decision to Rust. */
export function createNoticePlaceRustRunner(options: {
  port: NoticePlaceRustToolPort;
  instance: NoticePlaceRustInstance;
  incidentRouter: IncidentSessionRouter;
}): ProjectLaunchRunner {
  const {port, instance, incidentRouter} = options;
  if (instance.model !== NOTICEPLACE_V1_MODEL || instance.harness !== 'opencode' || !instance.instanceRef.trim() || !instance.cwd.trim())
    throw new Error('NoticePlace Rust instance must be the configured OpenCode instance on the approved provider route');

  const readBound = async (sessionRef: string): Promise<AgentSession | null> => {
    return findBoundSession(port,instance,sessionRef); // Bounded proof cannot establish a binding: fail closed.
  };

  const execute = async (request: Parameters<ProjectLaunchRunner>[0], existingSessionId?: string): Promise<NamedSessionResult> => {
    if (request.harness !== instance.harness || request.model !== instance.model || request.cwd !== instance.cwd)
      return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:'Configured Rust instance does not match the policy-selected OpenCode workspace/model.'};
    try {
      if (existingSessionId) {
        const prior = await readBound(existingSessionId);
        if (!prior) return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:'Bound Rust session is unavailable; a replacement was not created.'};
        const raw = await port.call('deliver', {action:'session',session_ref:existingSessionId,message:request.message,mode:instance.deliveryMode,request_key:request.inputId}, request.inputId);
        const task = taskRef(raw);
        if (!task) return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'admission_unknown',admissionUnknown:true,pending:true,nonRetryable:true,error:'Rust delivery returned no task reference; result is UNKNOWN.'};
        const receipt = deliverReceipt(await readTask(port,task,request.inputId));
        if (receipt.state === 'human_stop') return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:HUMAN_STOP_MESSAGE};
        if (receipt.state === 'unknown') return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'admission_unknown',admissionUnknown:true,pending:true,nonRetryable:true,error:'Rust delivery receipt remains unknown; replay is prohibited.'};
        if (receipt.state === 'not_sent') return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:'Rust refused delivery before native admission.'};
        return {ok:true,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId:existingSessionId,inputId:request.inputId,delivery:'accepted',model:request.model};
      }
      const raw = await port.call('create', {action:'create',instance_ref:instance.instanceRef,prompt:request.message,request_key:request.inputId}, request.inputId);
      const task = taskRef(raw);
      if (!task) return {ok:false,created:false,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,inputId:request.inputId,delivery:'admission_unknown',admissionUnknown:true,nonRetryable:true,error:'Rust create returned no durable task reference; admission is unknown.'};
      const receipt = createPromptReceipt(await readTask(port,task,request.inputId));
      const sessionId = receipt.sessionRef;
      if (receipt.state === 'human_stop') return {ok:false,created:Boolean(sessionId),harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,...(sessionId?{sessionId}:{}),inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:HUMAN_STOP_MESSAGE};
      if (receipt.state === 'unknown') return {ok:false,created:Boolean(sessionId),harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,...(sessionId?{sessionId}:{}),inputId:request.inputId,delivery:'admission_unknown',admissionUnknown:true,pending:true,nonRetryable:true,error:'Rust create/prompt receipt is incomplete; replay is prohibited.'};
      if (receipt.state === 'not_sent') return {ok:false,created:Boolean(sessionId),harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,...(sessionId?{sessionId}:{}),inputId:request.inputId,delivery:'not_attempted',nonRetryable:true,error:'Rust confirmed that create or initial delivery had no effect.'};
      return {ok:true,created:true,harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,sessionId,inputId:request.inputId,delivery:'accepted',model:request.model};
    } catch {
      // A transport failure after a mutation is UNKNOWN; never replay with a new key.
      return {ok:false,created:Boolean(existingSessionId),harness:request.harness,name:'noticeplace-incident',cwd:request.cwd,...(existingSessionId?{sessionId:existingSessionId}:{}),inputId:request.inputId,delivery:'admission_unknown',admissionUnknown:true,nonRetryable:true,error:'Rust MCP result unavailable; operation remains UNKNOWN and will not be replayed.'};
    }
  };

  return request => {
    if (!request.incidentRouting) return execute(request);
    const routeFacts = request.message.split('\n').reverse().flatMap(line => {
      try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string,unknown>] : []; }
      catch { return []; }
    })[0];
    // The existing router's historical parser requires an `inc_` sentinel,
    // while the installed NoticePlace contract treats incident IDs as opaque.
    // Add a routing-only sentinel from the unchanged source facts; execute()
    // still sends the byte-for-byte original prompt to Rust.
    const routingMessage = routeFacts
      ? `${request.message}\n${JSON.stringify({...routeFacts,id:`inc_${createHash('sha256').update(JSON.stringify([request.cwd,routeFacts.project,routeFacts.source_id,routeFacts.consumer_id,routeFacts.host_id,routeFacts.problem_type,routeFacts.signal_type])).digest('hex')}`})}`
      : request.message;
    return incidentRouter.run({harness:request.harness,cwd:request.cwd,message:routingMessage,inputId:request.inputId,model:request.model,
      incidentSessionPolicy:request.incidentSessionPolicy ?? incidentSessionPolicy()},
      existingSessionId => execute(request,existingSessionId));
  };
}

export function noticePlaceOperationKey(incidentId: string, profileId: string, planId: string): string {
  return createHash('sha256').update(JSON.stringify([incidentId,profileId,planId])).digest('hex').slice(0,32);
}
