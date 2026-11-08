import { buildSessionProgress } from '../health-progress.js';
import type { AgentSession, SessionDetails, SessionMessageView } from '../types/index.js';

type ObjectValue = Record<string, unknown>;
type Options = {
  port: {call(name: 'sessions' | 'session', args: Record<string, unknown>): Promise<unknown>};
  instanceRef: string;
  cwd: string;
};
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_rust_read');
  return value as ObjectValue;
}
function required(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('missing_rust_identity');
  return value;
}
function message(value: unknown): SessionMessageView {
  const row = object(value);
  if (!['user','assistant','tool','system'].includes(String(row.role))) throw new Error('invalid_rust_message_role');
  const parts = row.parts === undefined ? [] : row.parts;
  if (!Array.isArray(parts) || parts.some(part => !part || typeof part !== 'object'
    || !['text','thinking','tool_call','tool_result','image'].includes(part.type))) throw new Error('invalid_rust_message_parts');
  if (row.text !== undefined && typeof row.text !== 'string') throw new Error('invalid_rust_message_text');
  return {...row, id:required(row.id), role:row.role as SessionMessageView['role'], parts} as SessionMessageView;
}

/** Existing NoticePlace helper shapes; all data comes from scoped Rust reads. */
export function createNoticePlaceSessionRead({port, instanceRef, cwd}: Options) {
  required(instanceRef); required(cwd);
  return {async read(sessionRef: string, kind: 'progress' | 'details') {
    required(sessionRef);
    if (kind !== 'progress' && kind !== 'details') throw new Error('unsupported_session_read');
    const matches: ObjectValue[] = [];
    let cursor: string | undefined;
    const visited = new Set<string>();
    for (let i=0; i<16; i++) {
      const result = object(await port.call('sessions', {action:'list', instance_ref:instanceRef, ...(cursor?{cursor}:{})}));
      if (!Array.isArray(result.sessions)) throw new Error('rust_sessions_unavailable');
      matches.push(...result.sessions.map(object).filter(row=>row.session_ref===sessionRef));
      if (result.next_cursor == null) {cursor=undefined;break;}
      cursor=required(result.next_cursor);
      if (visited.has(cursor)) throw new Error('rust_session_cursor_cycle');
      visited.add(cursor);
    }
    if (cursor || matches.length!==1) throw new Error('exact_rust_session_unavailable');
    const row=matches[0]!, native=object(row.native), address=object(row.address), hold=object(row.human_stop);
    const nativeId=required(address.native_session_id);
    if (native.id!==nativeId || native.harness!=='opencode' || native.cwd!==cwd
      || typeof hold.held!=='boolean' || typeof native.needsPermission!=='boolean'
      || !['idle','running','needs_input','stopped','error'].includes(String(native.status))) throw new Error('rust_session_binding_mismatch');
    const response=object(await port.call('session',{action:'messages',session_ref:sessionRef}));
    if (response.session_ref!==sessionRef) throw new Error('rust_messages_binding_mismatch');
    const page=object(response.page);
    if (!Array.isArray(page.messages)) throw new Error('rust_messages_unavailable');
    const messages=page.messages.map(message);
    const session: AgentSession={id:sessionRef,harness:'opencode',cwd,status:native.status as AgentSession['status'],
      title:typeof native.title==='string'?native.title:'',hostId:required(native.hostId),
      lastActivity:required(native.lastActivity),needsPermission:native.needsPermission,
      ...(typeof native.model==='string'?{model:native.model}:{}),
      ...(typeof native.messageCount==='number'?{messageCount:native.messageCount}:{}),
      lastMessage:messages.at(-1)?.text};
    const details: SessionDetails={session,lineage:{kind:'unknown'},children:[],messages,
      history:{source:'live-cache',complete:false,warning:'Bounded native message tail via Rust; full transcript completeness is not claimed.'}};
    return kind==='progress'?buildSessionProgress(details,5):{...details,nativeSessionId:nativeId,humanStopHeld:hold.held};
  }};
}
