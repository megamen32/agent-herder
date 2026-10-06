import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { AgentSession } from "./types/common.js";

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 500;
const MAX_REASON_LENGTH = 1000;
const MAX_IGNORED_STOP_IDS = 128;

export type HumanStopTarget = Pick<AgentSession, "harness" | "id"> & Partial<Pick<AgentSession, "cwd" | "title">>;

export type HumanStopEvidence = {
  id: string;
  at: string;
  reason: string;
  turnId?: string;
};

export type HumanPromptEvidence = {
  id: string;
  at: string;
  turnId?: string;
  origin?: string;
  kind?: string;
  inputId?: string;
  automated?: boolean;
  synthetic?: boolean;
};

export type HumanStopRecord = {
  harness: string;
  id: string;
  active: boolean;
  stop: HumanStopEvidence;
  ignoredStopIds: string[];
  clearedAt?: string;
  clearedBy?: "explicit-resume" | "new-user-prompt";
  cwd?: string;
  title?: string;
};

type HumanStopFile = { version: 1; sessions: HumanStopRecord[] };
const stores = new Map<string, HumanStopStore>();

/** Durable fence for explicit human interruptions; independent from automation opt-ins. */
export class HumanStopStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async hold(session: HumanStopTarget, evidence: HumanStopEvidence): Promise<void> {
    const target = normalizeTarget(session);
    const stop = normalizeStopEvidence(evidence);
    await this.mutate((file) => {
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.id) === sessionKey(target.harness, target.id));
      const existing = index < 0 ? undefined : file.sessions[index];
      if (existing?.ignoredStopIds.includes(stop.id)) return false;
      if (existing && isStaleClearedStop(existing, stop)) {
        file.sessions[index!] = { ...existing, ignoredStopIds: boundIgnoredIds([...existing.ignoredStopIds, stop.id]) };
        return true;
      }
      if (existing?.active && existing.stop.id === stop.id) {
        const merged = mergeTarget(existing, target);
        const enriched = !existing.stop.turnId && stop.turnId ? { ...merged, stop: { ...existing.stop, turnId: stop.turnId } } : merged;
        const changed = enriched.cwd !== existing.cwd || enriched.title !== existing.title || enriched.stop.turnId !== existing.stop.turnId;
        file.sessions[index!] = enriched;
        return changed;
      }
      const ignoredStopIds = boundIgnoredIds([...new Set([
        ...(existing?.ignoredStopIds ?? []),
        ...(existing?.stop.id && existing.stop.id !== stop.id ? [existing.stop.id] : []),
      ])]);
      const record: HumanStopRecord = {
        ...(existing ? mergeTarget(existing, target) : target),
        active: true,
        stop,
        ignoredStopIds,
      };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index!] = record;
      return true;
    }, (changed) => changed);
  }

  /** Apply native stop/prompt metadata and return whether the session remains fenced. */
  async observe(session: AgentSession): Promise<boolean> {
    const target = normalizeTarget(session);
    const stop = normalizeStopEvidenceOrUndefined(session.meta?.automationStop);
    const prompt = normalizePromptEvidenceOrUndefined(session.meta?.latestUserPrompt);
    if (!stop && !prompt) return this.isHeld(target.harness, target.id);
    const result = await this.mutate((file) => {
      const key = sessionKey(target.harness, target.id);
      let index = file.sessions.findIndex((record) => sessionKey(record.harness, record.id) === key);
      let record = index < 0 ? undefined : file.sessions[index];
      let changed = false;
      if (stop && record && isStaleClearedStop(record, stop)) {
        if (!record.ignoredStopIds.includes(stop.id)) {
          record = { ...record, ignoredStopIds: boundIgnoredIds([...record.ignoredStopIds, stop.id]) };
          file.sessions[index!] = record;
          changed = true;
        }
      } else if (stop && !record?.ignoredStopIds.includes(stop.id) && !(record?.active && record.stop.id === stop.id)) {
        const ignoredStopIds = boundIgnoredIds([...new Set([
          ...(record?.ignoredStopIds ?? []),
          ...(record?.stop.id && record.stop.id !== stop.id ? [record.stop.id] : []),
        ])]);
        record = { ...(record ? mergeTarget(record, target) : target), active: true, stop, ignoredStopIds };
        if (index < 0) {
          index = file.sessions.length;
          file.sessions.push(record);
        } else file.sessions[index] = record;
        changed = true;
      } else if (record && stop && record.active && record.stop.id === stop.id) {
        const merged = mergeTarget(record, target);
        const enriched = !record.stop.turnId && stop.turnId ? { ...merged, stop: { ...record.stop, turnId: stop.turnId } } : merged;
        if (enriched.cwd !== record.cwd || enriched.title !== record.title || enriched.stop.turnId !== record.stop.turnId) {
          record = enriched;
          file.sessions[index] = record;
          changed = true;
        }
      }
      if (record?.active && prompt && isStrictlyNewerPrompt(prompt, record.stop)) {
        const ignoredStopIds = boundIgnoredIds([...new Set([...record.ignoredStopIds, record.stop.id])]);
        record = {
          ...record,
          active: false,
          ignoredStopIds,
          clearedAt: prompt.at,
          clearedBy: "new-user-prompt",
        };
        file.sessions[index] = record;
        changed = true;
      }
      return { held: Boolean(record?.active), changed };
    }, (value) => value.changed);
    return result.held;
  }

  async isHeld(harness: string, id: string): Promise<boolean> {
    const file = await this.read();
    return file.sessions.find((record) => sessionKey(record.harness, record.id) === sessionKey(harness, id))?.active === true;
  }

  /** Check an ancestor plus its immediate source from one persisted snapshot. */
  async anyHeld(sources: Array<{ harness: string; sessionId: string }>): Promise<boolean> {
    if (!Array.isArray(sources) || sources.length > 32) throw new Error("sources must contain at most 32 sessions");
    const keys = new Set(sources.map(({ harness, sessionId }) => sessionKey(
      normalizeHarness(harness),
      bounded(sessionId, "sessionId", MAX_ID_LENGTH),
    )));
    const file = await this.read();
    return file.sessions.some((record) => record.active && keys.has(sessionKey(record.harness, record.id)));
  }

  /** Record a Herder-issued native interrupt without overriding a human hold. */
  async ignoreNativeStop(harness: string, id: string, evidence: HumanStopEvidence): Promise<void> {
    const targetHarness = bounded(harness, "harness", MAX_ID_LENGTH);
    const targetId = bounded(id, "sessionId", MAX_ID_LENGTH);
    const stop = normalizeStopEvidence(evidence);
    await this.mutate((file) => {
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.id) === sessionKey(targetHarness, targetId));
      const existing = index < 0 ? undefined : file.sessions[index];
      if (existing?.stop.id === stop.id || existing?.ignoredStopIds.includes(stop.id)) return false;
      const record: HumanStopRecord = existing
        ? { ...existing, ignoredStopIds: boundIgnoredIds([...existing.ignoredStopIds, stop.id]) }
        : { harness: targetHarness, id: targetId, active: false, stop, ignoredStopIds: [stop.id] };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index!] = record;
      return true;
    }, (changed) => changed);
  }

  /** Clear only on a public explicit resume or a newer, real human prompt. */
  async release(harness: string, id: string, prompt?: HumanPromptEvidence): Promise<boolean> {
    const targetHarness = bounded(harness, "harness", MAX_ID_LENGTH);
    const targetId = bounded(id, "sessionId", MAX_ID_LENGTH);
    const normalizedPrompt = prompt ? normalizePromptEvidenceOrUndefined(prompt) : undefined;
    if (prompt && !normalizedPrompt) return false;
    return this.mutate((file) => {
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.id) === sessionKey(targetHarness, targetId));
      if (index < 0) return false;
      const record = file.sessions[index]!;
      if (!record.active) return false;
      if (normalizedPrompt && !isStrictlyNewerPrompt(normalizedPrompt, record.stop)) return false;
      file.sessions[index] = {
        ...record,
        active: false,
        ignoredStopIds: boundIgnoredIds([...new Set([...record.ignoredStopIds, record.stop.id])]),
        clearedAt: normalizedPrompt?.at ?? new Date().toISOString(),
        clearedBy: normalizedPrompt ? "new-user-prompt" : "explicit-resume",
      };
      return true;
    }, (changed) => changed);
  }

  async findHeldNamed(harness: string, name: string, cwd: string): Promise<HumanStopRecord | undefined> {
    const expectedHarness = bounded(harness, "harness", MAX_ID_LENGTH);
    const expectedName = normalizeName(name);
    const expectedCwd = resolve(cwd);
    const file = await this.read();
    const found = file.sessions.find((record) => record.active
      && record.harness === expectedHarness
      && normalizeName(record.title ?? "") === expectedName
      && (record.cwd ? resolve(record.cwd) : "") === expectedCwd);
    return found ? cloneRecord(found) : undefined;
  }

  private async read(): Promise<HumanStopFile> {
    const pending = this.operation;
    await pending;
    return this.readUnsafe();
  }

  private async readUnsafe(): Promise<HumanStopFile> {
    try {
      return parseHumanStopFile(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async mutate<T>(operation: (file: HumanStopFile) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const previous = this.operation;
    let releaseOperation!: () => void;
    this.operation = new Promise<void>((resolvePromise) => { releaseOperation = resolvePromise; });
    await previous;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
      const releaseFileLock = await lockfile.lock(this.lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 },
      });
      try {
        const file = await this.readUnsafe();
        const result = await operation(file);
        if (shouldWrite(result)) await this.write(file);
        return result;
      } finally {
        await releaseFileLock();
      }
    } finally {
      releaseOperation();
    }
  }

  private async write(file: HumanStopFile): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      try { await unlink(temporary); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }
}

export function getHumanStopStore(env: NodeJS.ProcessEnv = process.env): HumanStopStore {
  const configured = env.AGENT_HERDER_HUMAN_STOP_STORE?.trim();
  const path = resolve(configured || resolve(homedir(), ".local/state/agent-herder/human-stops.json"));
  let store = stores.get(path);
  if (!store) {
    store = new HumanStopStore(path);
    stores.set(path, store);
  }
  return store;
}

function parseHumanStopFile(value: unknown): HumanStopFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid human stop store");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.sessions)) throw new Error("invalid human stop store");
  return { version: 1, sessions: input.sessions.map(parseRecord) };
}

function parseRecord(value: unknown): HumanStopRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid human stop record");
  const input = value as Record<string, unknown>;
  if (typeof input.active !== "boolean" || !Array.isArray(input.ignoredStopIds)
    || !input.ignoredStopIds.every((item) => typeof item === "string")) throw new Error("invalid human stop record");
  const record: HumanStopRecord = {
    harness: normalizeHarness(input.harness),
    id: bounded(input.id, "sessionId", MAX_ID_LENGTH),
    active: input.active,
    stop: normalizeStopEvidence(input.stop),
    ignoredStopIds: [...new Set(input.ignoredStopIds as string[])],
    ...(typeof input.cwd === "string" ? { cwd: resolve(input.cwd) } : {}),
    ...(typeof input.title === "string" ? { title: bounded(input.title, "title", MAX_TITLE_LENGTH) } : {}),
    ...(typeof input.clearedAt === "string" ? { clearedAt: isoTimestamp(input.clearedAt, "clearedAt") } : {}),
    ...(input.clearedBy === "explicit-resume" || input.clearedBy === "new-user-prompt" ? { clearedBy: input.clearedBy } : {}),
  };
  if (record.active && record.ignoredStopIds.includes(record.stop.id)) throw new Error("active human stop is already cleared");
  return record;
}

function normalizeTarget(session: HumanStopTarget): HumanStopTarget {
  return {
    harness: normalizeHarness(session.harness),
    id: bounded(session.id, "sessionId", MAX_ID_LENGTH),
    ...(session.cwd ? { cwd: resolve(bounded(session.cwd, "cwd", MAX_TITLE_LENGTH)) } : {}),
    ...(session.title ? { title: bounded(session.title, "title", MAX_TITLE_LENGTH) } : {}),
  };
}

function normalizeStopEvidence(value: unknown): HumanStopEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid human stop evidence");
  const input = value as Record<string, unknown>;
  return {
    id: bounded(input.id, "stopId", MAX_ID_LENGTH),
    at: isoTimestamp(input.at, "stopAt"),
    reason: bounded(input.reason, "stopReason", MAX_REASON_LENGTH),
    ...(typeof input.turnId === "string" && input.turnId ? { turnId: bounded(input.turnId, "turnId", MAX_ID_LENGTH) } : {}),
  };
}

function normalizeStopEvidenceOrUndefined(value: unknown): HumanStopEvidence | undefined {
  try { return normalizeStopEvidence(value); } catch { return undefined; }
}

function normalizePromptEvidence(value: unknown): HumanPromptEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid human prompt evidence");
  const input = value as Record<string, unknown>;
  const prompt: HumanPromptEvidence = {
    id: bounded(input.id, "promptId", MAX_ID_LENGTH),
    at: isoTimestamp(input.at, "promptAt"),
    ...(typeof input.turnId === "string" && input.turnId ? { turnId: bounded(input.turnId, "turnId", MAX_ID_LENGTH) } : {}),
    ...(typeof input.origin === "string" ? { origin: input.origin } : {}),
    ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
    ...(typeof input.inputId === "string" ? { inputId: input.inputId } : {}),
    ...(typeof input.automated === "boolean" ? { automated: input.automated } : {}),
    ...(typeof input.synthetic === "boolean" ? { synthetic: input.synthetic } : {}),
  };
  if (!isRealUserPrompt(prompt)) throw new Error("prompt evidence is not a real human prompt");
  return prompt;
}

function normalizePromptEvidenceOrUndefined(value: unknown): HumanPromptEvidence | undefined {
  try { return normalizePromptEvidence(value); } catch { return undefined; }
}

function isRealUserPrompt(prompt: HumanPromptEvidence): boolean {
  const origin = prompt.origin?.trim().toLocaleLowerCase();
  const allowedOrigin = origin === undefined || ["real_user", "human", "user"].includes(origin);
  const kind = prompt.kind?.trim().toLocaleLowerCase();
  const allowedKind = kind === undefined || kind === "user_prompt";
  const generatedId = (value?: string) => Boolean(value?.startsWith("agent-herder:auto:"));
  return allowedOrigin && allowedKind && prompt.automated !== true && prompt.synthetic !== true
    && !generatedId(prompt.id) && !generatedId(prompt.turnId) && !generatedId(prompt.inputId);
}

function isStrictlyNewerPrompt(prompt: HumanPromptEvidence, stop: HumanStopEvidence): boolean {
  if (!isRealUserPrompt(prompt) || prompt.id === stop.id || (prompt.turnId && prompt.turnId === stop.turnId)) return false;
  return Date.parse(prompt.at) > Date.parse(stop.at);
}

function isStaleClearedStop(record: HumanStopRecord, evidence: HumanStopEvidence): boolean {
  if (record.active || !record.clearedAt) return false;
  if (record.stop.turnId && evidence.turnId === record.stop.turnId) return true;
  return Date.parse(evidence.at) <= Date.parse(record.clearedAt);
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`);
  return new Date(Date.parse(value)).toISOString();
}

function bounded(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`invalid ${label}`);
  return value.trim();
}

function normalizeHarness(value: unknown): AgentSession["harness"] {
  const harness = bounded(value, "harness", MAX_ID_LENGTH);
  if (!(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"] as string[]).includes(harness)) {
    throw new Error("invalid harness");
  }
  return harness as AgentSession["harness"];
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sessionKey(harness: string, id: string): string {
  return JSON.stringify([harness, id]);
}

function cloneRecord(record: HumanStopRecord): HumanStopRecord {
  return { ...record, stop: { ...record.stop }, ignoredStopIds: [...record.ignoredStopIds] };
}

function mergeTarget(record: HumanStopRecord, target: HumanStopTarget): HumanStopRecord {
  return {
    ...record,
    ...(target.cwd ? { cwd: target.cwd } : {}),
    ...(target.title ? { title: target.title } : {}),
  };
}

function boundIgnoredIds(ids: string[]): string[] {
  return [...new Set(ids)].slice(-MAX_IGNORED_STOP_IDS);
}
