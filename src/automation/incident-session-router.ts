import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import lockfile from 'proper-lockfile';
import type {AgentSession} from '../types/common.js';
import type {NamedSessionResult} from '../named-session.js';

/** Source identity deliberately excludes incident ID, correlation and sample fingerprint. */
export function incidentSourceKey(message: string): string | undefined {
  for (const line of message.slice(-65536).split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const facts = JSON.parse(line);
      if (typeof facts.id !== 'string' || !facts.id.startsWith('inc_')) continue;
      const keys = ['project', 'source_id', 'host_id', 'signal_type'];
      if (keys.some(key => typeof facts[key] !== 'string' || !facts[key].trim() || facts[key].length > 256)) return;
      return createHash('sha256').update(JSON.stringify(keys.map(key => facts[key].trim()))).digest('hex');
    } catch { /* Bounded telemetry, never executable instructions. */ }
  }
}

type Binding = {sessionId?: string; pending?: string};
type Registry = {version: 1; groups: Record<string, Binding>};
type Request = {harness: string; cwd: string; message: string; inputId: string; model?: string};
export type IncidentSessionRouterPorts = {
  readSession(harness: string, sessionId: string): Promise<AgentSession | null>;
  unfinished(session: AgentSession): Promise<boolean>;
  held?(session: AgentSession): Promise<boolean>;
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
      const prior = state.groups[key];
      if (prior?.pending) return {
        ok: false, created: false, name: 'incident-source-pending', cwd: request.cwd, harness: request.harness,
        inputId: request.inputId, admissionUnknown: true, nonRetryable: true, delivery: 'admission_unknown',
        ...(prior.sessionId ? {sessionId: prior.sessionId} : {}),
        error: 'Предыдущая отправка по этому источнику имеет неизвестный результат; второй исполнитель не создан.',
      };
      let existing = prior?.sessionId ? await this.ports.readSession(request.harness, prior.sessionId) : undefined;
      // A human hold stays attached to the source group. Let the existing
      // admission gate reject it; never escape the hold through a fresh ID.
      if (existing && !await this.ports.held?.(existing)
        && (existing.cwd !== request.cwd || existing.meta?.archived === true || !await this.ports.unfinished(existing))) existing = undefined;
      if (!prior && this.ports.findExisting) existing = await this.ports.findExisting(request, source);
      const binding: Binding = {...(existing ? {sessionId: existing.id} : {}), pending: request.inputId};
      await this.update(key, binding); // Crash/timeout cannot silently fall through to a new executor.
      const result = await launch(existing?.id);
      const unknown = result.admissionUnknown || result.pending || result.delivery === 'accepted_unconfirmed';
      await this.update(key, {
        ...(result.sessionId ? {sessionId: result.sessionId} : existing ? {sessionId: existing.id} : {}),
        // A known session ID is safe to reuse; an unknown creation must stay fenced.
        ...(unknown && !result.sessionId ? {pending: request.inputId} : {}),
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
