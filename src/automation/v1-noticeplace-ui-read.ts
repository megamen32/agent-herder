import type { AgentSession, ListSessionsOptions, SessionSnapshotReceipt } from '../types/index.js';
import type { AutopilotSessionStore } from '../autopilot/session-store.js';
import type { ChoiceRegistry } from '../autopilot/choice-registry.js';
import type { HerderJobRegistry } from '../herder-jobs.js';
import { orderSessionListForPanel } from '../session-listing.js';
import type { V1RegisteredUiReadPort, V1RegisteredUiCatalog } from './v1-ui-registered-read.js';

export const V1_UI_READ_PATHS = ['/api/sessions', '/api/sessions/active', '/api/autopilot/choices', '/api/autopilot/overview', '/api/jobs'] as const;
export type V1UiReadPath = typeof V1_UI_READ_PATHS[number];
export type V1UiReadResult = { status: number; body: Record<string, unknown> };
export interface V1UiReadPort { read(path: V1UiReadPath, query: URLSearchParams): Promise<V1UiReadResult> }

export type V1NativeReadProvider = {
  instanceRef: string;
  harness: string;
  hostId: string;
  source: string;
  adapter: {
    listSessions(options?: ListSessionsOptions): Promise<AgentSession[]>;
    listActiveSessions(): Promise<AgentSession[]>;
    getSessionSnapshotReceipt?(): SessionSnapshotReceipt | null;
    getActiveSessionSnapshotReceipt?(): { exhaustive: boolean; observedAt: string; reason?: string; [key: string]: unknown } | null;
  };
};

export type V1NativeUiReadOptions = {
  providers: V1NativeReadProvider[];
  registered?: V1RegisteredUiReadPort;
  /** Complete only when every declared owner/provider is connected, never inferred from one working source. */
  completeScope?: boolean;
  scope?: string;
  jobs?: Pick<HerderJobRegistry, 'list'>;
  choices?: Pick<ChoiceRegistry, 'list'>;
  autopilot?: Pick<AutopilotSessionStore, 'list'>;
  readPolicy?: () => Promise<{ enabled: boolean; harnesses: readonly string[] }>;
};
type SourceRead = { sessions: AgentSession[]; complete: boolean; observedAt: string; reason?: string; state: 'ready' | 'partial' | 'unavailable' };
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const NATIVE_SNAPSHOT_TTL_MS = 30_000;
const NATIVE_CLOCK_SKEW_MS = 5_000;

function snapshotTimeIssue(observedAt: unknown, now: number): string | undefined {
  const timestamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(timestamp)) return 'native_snapshot_time_invalid';
  if (timestamp > now + NATIVE_CLOCK_SKEW_MS) return 'native_snapshot_from_future';
  if (timestamp < now - NATIVE_SNAPSHOT_TTL_MS) return 'native_snapshot_expired';
  return undefined;
}
function activityTimeIssue(session: AgentSession, observedAt: string, now: number): string | undefined {
  const observed = session.meta?.activityObservedAt ?? observedAt;
  const issue = snapshotTimeIssue(observed, now);
  if (issue) return issue.replace('native_snapshot_', 'native_activity_');
  const expiresAt = session.meta?.activityExpiresAt;
  if (expiresAt !== undefined) {
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(expiry)) return 'native_activity_expiry_invalid';
    if (expiry <= now || expiry <= Date.parse(observed as string)) return 'native_activity_expired';
  }
  return undefined;
}

function limitOf(query: URLSearchParams, fallback = 100): number {
  const raw = query.get('limit');
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 500) throw new Error('limit must be between 1 and 500');
  return Number(raw);
}
function validNative(rows: AgentSession[], provider: V1NativeReadProvider): AgentSession[] {
  if (!Array.isArray(rows) || rows.some(row => !row || !text(row.id) || row.id.startsWith('session:') || row.harness !== provider.harness
    || (row.hostId !== undefined && row.hostId !== provider.hostId))) {
    throw new Error('native_identity_invalid');
  }
  return rows.map(row => ({ ...row, hostId: row.hostId ?? provider.hostId }));
}
function activeRow(session: AgentSession, provider: V1NativeReadProvider, read: SourceRead) {
  const hostId = session.hostId ?? provider.hostId;
  const observedAt = text(session.meta?.activityObservedAt) ?? read.observedAt;
  const nativeExpiry = Date.parse(text(session.meta?.activityExpiresAt) ?? '');
  const expiresAt = new Date(Math.min(
    Number.isFinite(nativeExpiry) ? nativeExpiry : Infinity,
    Date.parse(observedAt) + NATIVE_SNAPSHOT_TTL_MS,
    Date.parse(read.observedAt) + NATIVE_SNAPSHOT_TTL_MS,
  )).toISOString();
  return {
    id: session.id, harness: session.harness, title: session.title, runtimeHostId: hostId, status: session.status,
    activity: {
      state: 'active',
      observedAt,
      evidence: text(session.meta?.activityEvidence) ?? provider.source,
      expiresAt,
    },
    workspaces: session.cwd?.startsWith('/') ? [{ hostId, absolutePath: session.cwd }] : [],
  };
}

/** Read native catalogs without adopting sessions, starting observers, or changing control ownership. */
export function createV1NativeUiRead(options: V1NativeUiReadOptions): V1UiReadPort {
  const activeInFlight = new Map<V1NativeReadProvider, Promise<SourceRead>>();
  const catalogInFlight = new Map<V1NativeReadProvider, Promise<SourceRead>>();
  const scope = options.scope ?? 'noticeplace-runtime';
  function readProvider(provider: V1NativeReadProvider, kind: 'active' | 'catalog'): Promise<SourceRead> {
    const pending = kind === 'active' ? activeInFlight : catalogInFlight;
    const existing = pending.get(provider);
    if (existing) return existing;
    const operation = (async (): Promise<SourceRead> => {
      try {
        const rows = validNative(await (kind === 'active' ? provider.adapter.listActiveSessions() : provider.adapter.listSessions({ limit: 500 })), provider);
        const receipt = kind === 'active' ? provider.adapter.getActiveSessionSnapshotReceipt?.() : provider.adapter.getSessionSnapshotReceipt?.();
        const now = Date.now();
        const observedAt = receipt?.observedAt ?? new Date(now).toISOString();
        const timeIssue = receipt ? snapshotTimeIssue(receipt.observedAt, now) : undefined;
        if (timeIssue) return { sessions: [], complete: false, state: 'partial', observedAt, reason: timeIssue };
        let rowIssue: string | undefined;
        const sessions = kind === 'active' ? rows.filter(session => {
          const issue = activityTimeIssue(session, observedAt, now);
          rowIssue ??= issue;
          return !issue;
        }) : rows;
        const complete = receipt?.exhaustive === true && !rowIssue;
        return {
          sessions, complete, state: complete ? 'ready' : 'partial', observedAt,
          ...(!complete ? { reason: rowIssue ?? receipt?.reason ?? (kind === 'active' ? 'native_activity_coverage_unknown' : 'native_catalog_window') } : {}),
        };
      } catch {
        return { sessions: [], complete: false, state: 'unavailable', observedAt: new Date().toISOString(), reason: 'native_read_failed' };
      }
    })();
    pending.set(provider, operation);
    void operation.finally(() => { if (pending.get(provider) === operation) pending.delete(provider); });
    return operation;
  }
  const unavailable = (reason: string, extra: Record<string, unknown> = {}): V1UiReadResult => ({
    status: 503, body: { error: reason, coverage: { scope, complete: false }, ...extra },
  });
  function selected(query: URLSearchParams) {
    const harness = query.get('harness'), hostId = query.get('runtimeHostId') ?? query.get('hostId');
    return options.providers.filter(provider => (!harness || provider.harness === harness) && (!hostId || provider.hostId === hostId));
  }
  function sourceReceipt(provider: V1NativeReadProvider, read: SourceRead) {
    return { instanceRef: provider.instanceRef, harness: provider.harness, hostId: provider.hostId, source: provider.source, state: read.state, complete: read.complete, observedAt: read.observedAt, ...(read.reason ? { reason: read.reason } : {}) };
  }
  return { async read(path, query) {
    let limit: number;
    try { limit = limitOf(query); } catch (error) { return { status: 400, body: { error: (error as Error).message } }; }
    if (path === '/api/sessions' || path === '/api/sessions/active') {
      const providers = selected(query);
      if (!providers.length && !options.registered) return unavailable('native_read_provider_unavailable', { requestedHarness: query.get('harness'), requestedHost: query.get('runtimeHostId') ?? query.get('hostId') });
      const [activeRead, catalogRead, registry] = await Promise.all([
        Promise.all(providers.map(provider => readProvider(provider, 'active'))),
        path === '/api/sessions' ? Promise.all(providers.map(provider => readProvider(provider, 'catalog'))) : Promise.resolve(undefined),
        options.registered ? (path === '/api/sessions' ? options.registered.catalog(query) : options.registered.discover(query)) : Promise.resolve(undefined),
      ]);
      // A slow owner cannot stretch the native evidence lifetime while other reads finish.
      const recheck = (read: SourceRead, kind: 'active' | 'catalog'): SourceRead => {
        if (read.state === 'unavailable') return read;
        const now = Date.now(), timeIssue = snapshotTimeIssue(read.observedAt, now);
        if (timeIssue) return { ...read, sessions: [], complete: false, state: 'partial', reason: timeIssue };
        if (kind === 'catalog') return read;
        let issue: string | undefined;
        const sessions = read.sessions.filter(session => { const problem = activityTimeIssue(session, read.observedAt, now); issue ??= problem; return !problem; });
        return issue ? { ...read, sessions, complete: false, state: 'partial', reason: issue } : read;
      };
      const active = activeRead.map(read => recheck(read, 'active'));
      const catalog = catalogRead?.map(read => recheck(read, 'catalog'));
      const nativeSources = providers.map((provider, index) => sourceReceipt(provider, catalog ? {
        ...catalog[index]!, complete: catalog[index]!.complete && active[index]!.complete,
        state: catalog[index]!.state === 'unavailable' && active[index]!.state === 'unavailable' ? 'unavailable' : catalog[index]!.complete && active[index]!.complete ? 'ready' : 'partial',
        reason: (catalog[index]!.state === 'unavailable' ? catalog[index]!.reason : undefined)
          ?? (active[index]!.state === 'unavailable' ? active[index]!.reason : undefined) ?? catalog[index]!.reason ?? active[index]!.reason,
      } : active[index]!));
      const missingNative = registry?.instances.filter(owner => !providers.some(provider => provider.instanceRef === owner.instanceRef && provider.harness === owner.harness && provider.hostId === owner.hostId)).map(owner => ({
        ...owner, scope: path === '/api/sessions/active' ? 'native-active-sessions' : 'native-session-catalog',
        source: 'native-provider', state: 'unavailable', complete: false, observedAt: new Date().toISOString(), reason: 'native_read_provider_unavailable',
      })) ?? [];
      const registeredCatalog = path === '/api/sessions' ? registry as V1RegisteredUiCatalog | undefined : undefined;
      const complete = options.completeScope === true && providers.length > 0 && nativeSources.every(source => source.complete)
        && (!registry || registry.complete && missingNative.length === 0 && registry.sources.every(source => source.state === 'ready'));
      const sources = [...nativeSources, ...(registry?.sources ?? []), ...missingNative];
      const coverage = { scope, complete, sources };
      const nativeReadable = active.some(read => read.state !== 'unavailable') || catalog?.some(read => read.state !== 'unavailable');
      const registeredReadable = registeredCatalog?.sources.some(source => source.scope === 'authorized_registered_sessions' && source.state !== 'unavailable');
      if (!nativeReadable && !registeredReadable) return { status: 503, body: { error: 'native_read_incomplete', coverage } };
      if (path === '/api/sessions/active') {
        const all = providers.flatMap((provider, index) => active[index]!.sessions.filter(session => session.status === 'running' || session.status === 'needs_input').map(session => activeRow(session, provider, active[index]!)));
        const filtered = all.filter(session => !query.get('cwd') || session.workspaces.some(workspace => workspace.absolutePath === query.get('cwd')));
        const hosts = providers.map((provider, index) => ({ hostId: provider.hostId, state: active[index]!.state, observedAt: active[index]!.observedAt, sources: [{ harness: provider.harness, exhaustive: active[index]!.complete, source: provider.source, ...(active[index]!.reason ? { reason: active[index]!.reason } : {}) }] }));
        return { status: 200, body: { sessions: filtered.slice(0, limit), hosts, partial: !complete || filtered.length > limit, total: filtered.length, limit, truncated: filtered.length > limit, coverage } };
      }
      const known = new Map<string, AgentSession>();
      const remember = (session: AgentSession) => {
        const key = `${session.hostId}:${session.harness}:${session.id}`, previous = known.get(key);
        known.set(key, { ...previous, ...session, ...(previous?.meta || session.meta ? { meta: { ...previous?.meta, ...session.meta } } : {}) });
      };
      for (const session of registeredCatalog?.sessions ?? []) remember(session);
      for (const index of providers.keys()) {
        for (const session of [...catalog![index]!.sessions, ...active[index]!.sessions]) remember(session);
      }
      const rows = [...known.values()].filter(session => (!query.get('status') || session.status === query.get('status')) && (!query.get('cwd') || session.cwd === query.get('cwd')));
      const ordered = orderSessionListForPanel(rows);
      return { status: 200, body: { sessions: ordered.slice(0, limit), total: ordered.length, limit, truncated: ordered.length > limit, totalIsLowerBound: !complete, warming: false, coverage,
        ...(registeredCatalog ? { unresolvedSessions: registeredCatalog.unresolvedSessions } : {}) } };
    }
    const storeCoverage = { scope: 'v1-noticeplace-stores', complete: false, source: path, reason: 'other_runtime_stores_not_projected' };
    try {
      if (path === '/api/jobs') {
        if (!options.jobs) return unavailable('job_registry_unavailable');
        return { status: 200, body: { jobs: options.jobs.list(limit), coverage: storeCoverage } };
      }
      if (path === '/api/autopilot/choices') {
        if (!options.choices) return unavailable('choice_registry_unavailable');
        if (query.get('status') && query.get('status') !== 'pending') return { status: 400, body: { error: 'status must be pending' } };
        const records = await options.choices.list({ status: 'pending', limit });
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const visible = records.filter(record => Date.parse(record.createdAt) >= cutoff);
        if (visible.some(record => !record.harness || record.sessionId.startsWith('session:'))) return unavailable('choice_native_identity_unavailable');
        return { status: 200, body: { choices: visible.map(record => ({
          requestId: record.requestId, sessionId: record.sessionId, harness: record.harness, cwd: record.cwd, status: record.status, createdAt: record.createdAt,
          choices: record.choices.map(({ choiceId, label }) => ({ choiceId, label })),
        })), coverage: storeCoverage } };
      }
      if (path === '/api/autopilot/overview') {
        if (!options.autopilot || !options.readPolicy) return unavailable('autopilot_read_provider_unavailable');
        const [policy, records] = await Promise.all([options.readPolicy(), options.autopilot.list()]);
        if (typeof policy.enabled !== 'boolean' || !Array.isArray(policy.harnesses)) return unavailable('autopilot_policy_unavailable');
        const enabled = records.filter(record => record.enabled === true);
        if (enabled.some(record => record.sessionId.startsWith('session:'))) return unavailable('autopilot_native_identity_unavailable');
        return { status: 200, body: { global: policy.enabled, harnesses: [...policy.harnesses], sessions: enabled.map(record => ({ harness: record.harness, sessionId: record.sessionId })), coverage: storeCoverage } };
      }
    } catch { return unavailable('state_read_unavailable'); }
    return { status: 404, body: { error: 'unsupported_ui_read' } };
  } };
}
