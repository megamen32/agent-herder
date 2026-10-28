import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import lockfile from 'proper-lockfile';
import type {AgentSession} from '../types/common.js';
import type {NamedSessionResult} from '../named-session.js';

type IncidentFacts = {id: string; project: string; sourceId?: string; consumerId?: string; hostId: string; signalType?: string; problemType?: string};

const PROBLEM_TYPE_ALIASES: Record<string, string[]> = {
  cpu: ['load', 'loadavg', 'cpu_load', 'cpu'],
  disk: ['disk', 'disk_space', 'disk_full', 'inodes'],
};

function canonicalProblemType(facts: IncidentFacts): string | undefined {
  if (facts.problemType) return facts.problemType;
  if (!facts.signalType) return undefined;
  const raw = facts.signalType.trim();
  const aliasGroup = Object.entries(PROBLEM_TYPE_ALIASES).find(([, aliases]) => aliases.includes(raw.toLowerCase()));
  return aliasGroup?.[0] ?? raw;
}

function incidentFacts(message: string): IncidentFacts | undefined {
  for (const line of message.slice(-65536).split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const facts = JSON.parse(line);
      if (typeof facts.id !== 'string' || !facts.id.startsWith('inc_')) continue;
      const required = ['project', 'host_id'] as const;
      if (required.some(key => typeof facts[key] !== 'string' || !facts[key].trim() || facts[key].length > 256)) return;
      if (facts.consumer_id !== undefined && facts.consumer_id !== null && typeof facts.consumer_id !== 'string') return;
      if (facts.problem_type !== undefined && facts.problem_type !== null && typeof facts.problem_type !== 'string') return;
      const sourceId = typeof facts.source_id === 'string' && facts.source_id.trim() ? facts.source_id.trim() : undefined;
      const consumerId = typeof facts.consumer_id === 'string' && facts.consumer_id.trim() ? facts.consumer_id.trim() : undefined;
      const signalType = typeof facts.signal_type === 'string' && facts.signal_type.trim() ? facts.signal_type.trim() : undefined;
      const problemType = typeof facts.problem_type === 'string' && facts.problem_type.trim() ? facts.problem_type.trim() : undefined;
      return {id: facts.id, project: facts.project.trim(), sourceId, consumerId, hostId: facts.host_id.trim(), signalType, problemType};
    } catch { /* Bounded telemetry, never executable instructions. */ }
  }
}
export function incidentRequestId(message: string): string | undefined { return incidentFacts(message)?.id; }

/** Source identity deliberately excludes incident ID, correlation and sample fingerprint. */
export function incidentSourceKey(message: string): string | undefined {
  const facts = incidentFacts(message);
  if (facts) {
    const consumer = facts.consumerId ?? facts.sourceId;
    const problem = canonicalProblemType(facts);
    if (!consumer || !problem || [consumer, problem].some(value => value.length > 256)) return;
    const identity = [facts.project, consumer, facts.hostId, problem];
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
}

/** Old registry keys used source_id and signal_type; retain a narrow upgrade bridge. */
export function incidentLegacySourceKeys(message: string): string[] {
  const facts = incidentFacts(message);
  if (!facts?.sourceId || !facts.signalType) return [];
  const aliases = facts.problemType ? [facts.signalType] : (PROBLEM_TYPE_ALIASES[canonicalProblemType(facts)?.toLowerCase() ?? ''] ?? [facts.signalType]);
  return [...new Set(aliases.map(signal => createHash('sha256').update(JSON.stringify([facts.project, facts.sourceId, facts.hostId, signal])).digest('hex')))];
}

type Binding = {sessionId?: string; pending?: string};
type Registry = {version: 1; groups: Record<string, Binding>};
type Request = {harness: string; cwd: string; message: string; inputId: string; model?: string};
export type IncidentSessionRouterPorts = {
  readSession(harness: string, sessionId: string): Promise<AgentSession | null>;
  unfinished(session: AgentSession): Promise<boolean>;
  held?(session: AgentSession): Promise<boolean>;
  /** Confirm that the original bound incident is still open before continuation. */
  boundIncidentOpen?(session: AgentSession, request?: Request): Promise<boolean>;
  /** Confirm a durable degraded/work-finished receipt for a stopped attempt. */
  continuationReady?(session: AgentSession, request?: Request): Promise<boolean | 'blocked'>;
  /** Adopt a pre-upgrade executor only after matching its original native facts. */
  findExisting?(request: Request, sourceKey: string): Promise<AgentSession | undefined>;
};

/** One interprocess source-group lock; per-operation admission remains in the launch log. */
export class IncidentSessionRouter {
  constructor(private readonly path: string, private readonly ports: IncidentSessionRouterPorts) {}

  async run(request: Request, launch: (existingSessionId?: string) => Promise<NamedSessionResult>): Promise<NamedSessionResult> {
    const source = incidentSourceKey(request.message);
    if (!source) return launch(); // Incomplete telemetry never groups unrelated work.
    const key = createHash('sha256').update(JSON.stringify([request.harness, request.cwd, source])).digest('hex');
    await mkdir(dirname(this.path), {recursive: true});
    const target = `${this.path}.${key}.lock`;
    const handle = await open(target, 'a', 0o600);
    await handle.close();
    const release = await lockfile.lock(target, {realpath: false, stale: 120000, retries: {retries: 120, minTimeout: 100, maxTimeout: 500}});
    try {
      const state = await this.read();
      let prior = state.groups[key];
      {
        const legacy = incidentLegacySourceKeys(request.message)
          .map(oldSource => state.groups[createHash('sha256').update(JSON.stringify([request.harness, request.cwd, oldSource])).digest('hex')])
          .filter((binding): binding is Binding => Boolean(binding));
        if (legacy.some(binding => binding.pending) || prior?.pending) return {
          ok: false, created: false, name: 'incident-source-pending', cwd: request.cwd, harness: request.harness,
          inputId: request.inputId, admissionUnknown: true, nonRetryable: true, delivery: 'admission_unknown',
          error: 'У старой привязки источника есть отправка с неизвестным результатом; второй исполнитель не создан.',
        };
        const sessionIds = [...new Set([...legacy, ...(prior ? [prior] : [])].map(binding => binding.sessionId).filter((id): id is string => Boolean(id)))];
        if (sessionIds.length > 1) {
          const preferred = this.ports.findExisting ? await this.ports.findExisting(request, source) : undefined;
          if (!preferred) return {
            ok: false, created: false, name: 'incident-session-ambiguous', cwd: request.cwd, harness: request.harness,
            inputId: request.inputId, delivery: 'not_attempted', nonRetryable: true,
            error: 'Старые привязки источника указывают на несколько сессий; автоматическое продолжение остановлено.',
          };
          prior = {sessionId: preferred.id};
        }
        if (!prior && sessionIds.length === 1) {
          const adopted = [...legacy, ...(prior ? [prior] : [])].find(binding => binding.sessionId === sessionIds[0]);
          if (adopted) prior = adopted;
        }
      }
      if (prior?.pending) return {
        ok: false, created: false, name: 'incident-source-pending', cwd: request.cwd, harness: request.harness,
        inputId: request.inputId, admissionUnknown: true, nonRetryable: true, delivery: 'admission_unknown',
        ...(prior.sessionId ? {sessionId: prior.sessionId} : {}),
        error: 'Предыдущая отправка по этому источнику имеет неизвестный результат; второй исполнитель не создан.',
      };
      let existing = prior?.sessionId ? await this.ports.readSession(request.harness, prior.sessionId) : undefined;
      if (prior?.sessionId && !existing) return {
        ok: false, created: false, name: 'incident-session-unavailable', cwd: request.cwd, harness: request.harness,
        inputId: request.inputId, delivery: 'not_attempted', nonRetryable: true, sessionId: prior.sessionId,
        error: 'Исходная сессия ремонта недоступна; новая сессия не создана.',
      };
      // A human hold stays attached to the source group. Let the existing
      // admission gate reject it; never escape the hold through a fresh ID.
      if (prior?.sessionId && existing) {
        if (existing.cwd !== request.cwd || existing.meta?.archived === true) return {
          ok: false, created: false, name: 'incident-session-unavailable', cwd: request.cwd, harness: request.harness,
          inputId: request.inputId, delivery: 'not_attempted', nonRetryable: true, sessionId: existing.id,
          error: 'Исходная сессия ремонта архивирована или сменила рабочую директорию; новая сессия не создана.',
        };
        if (!await this.ports.held?.(existing)) {
          const open = !this.ports.boundIncidentOpen || await this.ports.boundIncidentOpen(existing, request);
          if (!open || !await this.ports.unfinished(existing)) {
            const continuation = await this.ports.continuationReady?.(existing, request);
            if (!open && (continuation === false || !this.ports.continuationReady)) existing = undefined; // Proven new episode retains normal new-generation policy.
            else if (continuation !== true) return {
              ok: false, created: false, name: 'incident-continuation-unconfirmed', cwd: request.cwd, harness: request.harness,
              inputId: request.inputId, delivery: 'not_attempted', nonRetryable: true, sessionId: existing.id,
              error: 'Исходная сессия завершила попытку, но актуальная квитанция продолжения не подтверждена; новая сессия не создана.',
            };
          }
        }
        // A finished attempt resumes the exact bound ID only with a durable
        // continuation receipt. HumanStop remains with the ordinary admission gate.
      } else if (existing && !await this.ports.held?.(existing)
        && (existing.cwd !== request.cwd || existing.meta?.archived === true || !await this.ports.unfinished(existing))) existing = undefined;
      if (!prior && this.ports.findExisting) existing = await this.ports.findExisting(request, source);
      const binding: Binding = {...(existing ? {sessionId: existing.id} : {}), pending: request.inputId};
      await this.update(key, binding); // Crash/timeout cannot silently fall through to a new executor.
      const result = await launch(existing?.id);
      if (existing && result.sessionId && result.sessionId !== existing.id) return {
        ...result, ok: false, created: false, sessionId: existing.id, delivery: 'not_attempted', nonRetryable: true,
        error: 'Исполнитель вернул другой ID вместо исходной сессии; замена не принята.',
      };
      const unknown = result.admissionUnknown || result.pending || result.delivery === 'accepted_unconfirmed';
      await this.update(key, {
        ...(result.sessionId ? {sessionId: result.sessionId} : existing ? {sessionId: existing.id} : {}),
        // A known session ID does not resolve an unknown input admission.
        ...(unknown ? {pending: request.inputId} : {}),
      });
      return {...result, ...(existing && result.sessionId === existing.id ? {coalesced: true} : {})};
    } finally {
      await release();
    }
  }

  private async read(): Promise<Registry> {
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8'));
      if (file.version !== 1 || !file.groups || typeof file.groups !== 'object') throw new Error('Invalid incident source registry');
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version: 1, groups: {}};
      throw error;
    }
  }

  private async update(key: string, binding: Binding): Promise<void> {
    // Different source groups may launch concurrently; merge under the file's own lock.
    const target = `${this.path}.lock`;
    const handle = await open(target, 'a', 0o600); await handle.close();
    const release = await lockfile.lock(target, {realpath: false, retries: {retries: 100, minTimeout: 10, maxTimeout: 100}});
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await this.read();
      file.groups[key] = binding;
      const output = await open(temp, 'wx', 0o600);
      try {await output.writeFile(JSON.stringify(file)); await output.sync();} finally {await output.close();}
      await rename(temp, this.path);
    } finally {await unlink(temp).catch(() => undefined); await release();}
  }
}
