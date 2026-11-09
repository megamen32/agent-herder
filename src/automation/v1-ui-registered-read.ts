import type { AgentSession, SessionDetails, SessionMessageView } from '../types/index.js';
import { buildSessionProgress } from '../health-progress.js';
import type { V1NativeSessionReadPort, V1NativeSessionReadRequest } from './v1-noticeplace-ui-session.js';
import type { V1UiReadResult } from './v1-noticeplace-ui-read.js';

export const V1_UI_EXPECTED_HARNESSES = ['codex', 'opencode', 'chatgpt', 'zai', 'zcode'] as const;
export type V1CoreUiReadPort = { call(tool: 'discover' | 'sessions' | 'session', args: Record<string, unknown>): Promise<unknown> };
export type V1UiConfiguredInstance = { instanceRef: string; harness: string; hostId: string };
export type V1RegisteredUiSource = {
  instanceRef?: string; harness: string; hostId?: string; source: string; scope: string;
  complete: false; state: 'ready' | 'partial' | 'unavailable'; observedAt: string; reason?: string;
  registeredComplete?: boolean; nativeMetadataComplete?: boolean;
};
export type V1RegisteredUiDiscovery = { instances: V1UiConfiguredInstance[]; sources: V1RegisteredUiSource[]; complete: boolean };
export type V1RegisteredUiCatalog = V1RegisteredUiDiscovery & {
  sessions: AgentSession[];
  unresolvedSessions: Array<{ nativeId: string; core_session_ref: string; harness: string; hostId: string; reason: string }>;
};
export interface V1RegisteredUiReadPort extends V1NativeSessionReadPort {
  discover(query: URLSearchParams): Promise<V1RegisteredUiDiscovery>;
  catalog(query: URLSearchParams): Promise<V1RegisteredUiCatalog>;
}
type Binding = V1UiConfiguredInstance & { nativeId: string; coreRef: string; native?: AgentSession };
type InternalCatalog = V1RegisteredUiCatalog & { bindings: Binding[] };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_core_read');
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !/[\r\n\0]/u.test(value);
const nativeIdentifier = (value: unknown): value is string => identifier(value) && !value.startsWith('session:') && !value.includes('/');
const sourceName = 'v1-authorized-registered-sessions';
const scopeName = 'authorized_registered_sessions';

function readNativeMetadata(value: unknown, binding: Binding): AgentSession {
  const row = object(value);
  if (row.id !== binding.nativeId || row.harness !== binding.harness || row.hostId !== binding.hostId
    || !['idle', 'running', 'needs_input', 'stopped', 'error'].includes(String(row.status))
    || typeof row.title !== 'string' || typeof row.cwd !== 'string' || typeof row.needsPermission !== 'boolean'
    || typeof row.lastActivity !== 'string' || !Number.isFinite(Date.parse(row.lastActivity))) throw new Error('registered_native_binding_mismatch');
  return { ...row, id: binding.nativeId, core_session_ref: binding.coreRef } as unknown as AgentSession;
}
function readMessage(value: unknown): SessionMessageView {
  const row = object(value), parts = row.parts ?? [];
  if (!identifier(row.id) || !['user', 'assistant', 'tool', 'system'].includes(String(row.role)) || !Array.isArray(parts)
    || parts.some(part => !part || typeof part !== 'object' || !['text', 'thinking', 'tool_call', 'tool_result', 'image'].includes(part.type))
    || (row.text !== undefined && typeof row.text !== 'string')) throw new Error('invalid_registered_history');
  return { ...row, parts } as unknown as SessionMessageView;
}

/** Public owner discovery and registered reads only. Registry coverage is never native inventory coverage. */
export function createV1RegisteredUiRead(options: { port: V1CoreUiReadPort; expectedHarnesses?: readonly string[] }): V1RegisteredUiReadPort {
  const expected = options.expectedHarnesses ?? V1_UI_EXPECTED_HARNESSES;
  let discoveryInFlight: Promise<{ instances: V1UiConfiguredInstance[]; complete: boolean }> | undefined;
  const catalogsInFlight = new Map<string, Promise<InternalCatalog>>();
  const readDiscovery = () => {
    if (discoveryInFlight) return discoveryInFlight;
    const read = (async () => {
      const payload = object(await options.port.call('discover', { action: 'instances' }));
      if (!['configured_owner_instances', 'configured_owner_instance'].includes(String(payload.scope)) || !Array.isArray(payload.instances)
        || payload.instances.length > 64) throw new Error('configured_owner_discovery_invalid');
      const instances = payload.instances.map(value => {
        const row = object(value);
        if (!identifier(row.instance_ref) || !identifier(row.node_ref) || !identifier(row.harness)) throw new Error('configured_owner_binding_invalid');
        return { instanceRef: row.instance_ref, hostId: row.node_ref, harness: row.harness };
      });
      if (new Set(instances.map(owner => owner.instanceRef)).size !== instances.length) throw new Error('configured_owner_ambiguous');
      return { instances, complete: payload.complete === true };
    })();
    discoveryInFlight = read;
    void read.then(() => { if (discoveryInFlight === read) discoveryInFlight = undefined; }, () => { if (discoveryInFlight === read) discoveryInFlight = undefined; });
    return read;
  };
  async function discover(query: URLSearchParams): Promise<V1RegisteredUiDiscovery> {
    const harness = query.get('harness'), hostId = query.get('runtimeHostId') ?? query.get('hostId');
    const observedAt = new Date().toISOString();
    const required = harness ? [harness] : [...expected];
    try {
      const result = await readDiscovery();
      const instances = result.instances.filter(owner => (!harness || owner.harness === harness) && (!hostId || owner.hostId === hostId));
      const sources: V1RegisteredUiSource[] = required.filter(kind => !instances.some(owner => owner.harness === kind)).map(kind => ({
        harness: kind, ...(hostId ? { hostId } : {}), source: 'v1-configured-owner-discovery', scope: 'configured_owner_instances',
        state: 'unavailable', complete: false, observedAt, reason: 'configured_owner_missing',
      }));
      if (!result.complete) sources.push({ harness: harness ?? '*', source: 'v1-configured-owner-discovery', scope: 'configured_owner_instances', state: 'partial', complete: false, observedAt, reason: 'configured_owner_discovery_incomplete' });
      return { instances, sources, complete: result.complete && sources.length === 0 };
    } catch {
      return { instances: [], complete: false, sources: required.map(kind => ({ harness: kind, source: 'v1-configured-owner-discovery', scope: 'configured_owner_instances', state: 'unavailable', complete: false, observedAt, reason: 'configured_owner_discovery_unavailable' })) };
    }
  }
  async function readCatalog(query: URLSearchParams): Promise<InternalCatalog> {
    const key = JSON.stringify([query.get('harness'), query.get('runtimeHostId') ?? query.get('hostId')]);
    const pending = catalogsInFlight.get(key);
    if (pending) return pending;
    const read = (async (): Promise<InternalCatalog> => {
      const discovery = await discover(query);
      const results = await Promise.all(discovery.instances.map(async owner => {
        const base: V1RegisteredUiSource = { ...owner, source: sourceName, scope: scopeName, state: 'unavailable', complete: false, observedAt: new Date().toISOString() };
        const bindings: Binding[] = [], unresolvedSessions: V1RegisteredUiCatalog['unresolvedSessions'] = [];
        try {
          const payload = object(await options.port.call('sessions', { action: 'list', instance_ref: owner.instanceRef }));
          if (payload.scope !== scopeName || !Array.isArray(payload.sessions)) throw new Error('registered_scope_unavailable');
          let invalid = false;
          for (const value of payload.sessions) {
            try {
              const row = object(value), address = object(row.address), instance = object(address.instance);
              if (!identifier(row.session_ref) || !nativeIdentifier(address.native_session_id)
                || instance.instance_id !== owner.instanceRef || instance.node !== owner.hostId) throw new Error('registered_binding_invalid');
              const binding: Binding = { ...owner, coreRef: row.session_ref, nativeId: address.native_session_id };
              if (row.native !== null && row.native !== undefined) {
                try { binding.native = readNativeMetadata(row.native, binding); } catch { invalid = true; }
              }
              bindings.push(binding);
              if (!binding.native) unresolvedSessions.push({ nativeId: binding.nativeId, core_session_ref: binding.coreRef, harness: binding.harness, hostId: binding.hostId, reason: 'registered_native_metadata_unavailable' });
            } catch { invalid = true; }
          }
          const registeredComplete = payload.complete === true && !invalid;
          const nativeMetadataComplete = payload.native_coverage_complete === true && !invalid && unresolvedSessions.length === 0;
          return { bindings, unresolvedSessions, source: { ...base, registeredComplete, nativeMetadataComplete,
            state: registeredComplete && nativeMetadataComplete ? 'ready' as const : 'partial' as const,
            ...(!registeredComplete || !nativeMetadataComplete ? { reason: invalid ? 'registered_binding_invalid' : 'registered_native_metadata_incomplete' } : {}),
          } };
        } catch { return { bindings, unresolvedSessions, source: { ...base, reason: 'registered_owner_read_unavailable' } }; }
      }));
      const bindings = results.flatMap(result => result.bindings);
      return { ...discovery, sources: [...discovery.sources, ...results.map(result => result.source)],
        sessions: bindings.flatMap(binding => binding.native ? [binding.native] : []), bindings,
        unresolvedSessions: results.flatMap(result => result.unresolvedSessions) };
    })();
    catalogsInFlight.set(key, read);
    void read.then(() => { if (catalogsInFlight.get(key) === read) catalogsInFlight.delete(key); }, () => { if (catalogsInFlight.get(key) === read) catalogsInFlight.delete(key); });
    return read;
  }
  async function read(input: V1NativeSessionReadRequest): Promise<V1UiReadResult> {
    const base = { scope: scopeName, source: sourceName, complete: false, observedAt: new Date().toISOString() };
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}): V1UiReadResult => ({ status, body: { error, coverage: { ...base, ...extra } } });
    if (!nativeIdentifier(input.nativeId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) return fail(400, 'invalid_native_session_read');
    const query = new URLSearchParams({ harness: input.harness, ...(input.hostId ? { runtimeHostId: input.hostId } : {}) });
    const catalog = await readCatalog(query);
    const matches = catalog.bindings.filter(binding => binding.nativeId === input.nativeId);
    if (!matches.length) return fail(catalog.sources.some(source => source.state === 'unavailable') ? 503 : 404, 'registered_native_binding_unavailable', { sources: catalog.sources });
    if (matches.length !== 1) return fail(409, 'registered_native_binding_ambiguous');
    const binding = matches[0]!;
    const receipt = { instanceRef: binding.instanceRef, harness: binding.harness, hostId: binding.hostId };
    if (!binding.native) return fail(503, 'registered_native_metadata_unavailable', receipt);
    try {
      const response = object(await options.port.call('session', { action: 'messages', session_ref: binding.coreRef }));
      if (response.session_ref !== binding.coreRef) return fail(503, 'registered_history_binding_mismatch', receipt);
      const page = object(response.page);
      if (!Array.isArray(page.messages)) return fail(503, 'registered_history_unavailable', receipt);
      const messages = page.messages.map(readMessage).slice(-input.limit);
      const details: SessionDetails = { session: binding.native, messages, lineage: { kind: 'unknown' }, children: [],
        history: { source: 'live-cache', complete: false, warning: 'Bounded message tail from the authorized owner; full history and child-session coverage are unverified.' } };
      return { status: 200, body: { ...(input.kind === 'progress' ? buildSessionProgress(details, input.limit) : details),
        nativeSessionId: binding.nativeId, core_session_ref: binding.coreRef,
        coverage: { ...base, ...receipt, reason: 'registered_bounded_history', sections: { session: 'observed', messages: 'bounded', children: 'unavailable', lineage: 'unknown' } } } };
    } catch { return fail(503, 'registered_history_unavailable', receipt); }
  }
  return { discover, catalog: readCatalog, read };
}
