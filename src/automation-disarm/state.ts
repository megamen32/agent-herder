import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { normalizeWorkKeyInput } from "./work-key.js";
import { ALL_SCOPES, canonicalScopePath, scopeOfWorkKey } from "./scope.js";

/** The durable owner-level state file, next to the live launch policy. */
export const AUTOMATION_DISARM_FILE_NAME = "automation-disarm.json";

/**
 * One owner decision about one scope.
 *
 * A record says whether the automatic launches of one scope are forbidden or
 * explicitly permitted. The scope is the boundary: the catch-all scope covers
 * everything, and a project scope covers that project and everything inside
 * it. The optional work keys are the finer boundary inside the scope.
 */
export interface AutomationDisarmRecord {
  /** `"*"` for every automatic launch, otherwise the absolute project path. */
  scope: string;
  /** True forbids the automatic launches of this scope, false permits them. */
  forbidden: boolean;
  /** The identity of the owner who made the decision. */
  owner?: string;
  /** Owner-visible reason for the decision. */
  reason?: string;
  /** When the owner made the decision. */
  createdAt: string;
  /** The revision of the live launch policy at the moment of the decision. */
  policyRevision?: string;
  /** The finer boundary inside the scope; canonical work keys. */
  workKeys?: string[];
}

/**
 * The state one node reports about itself.
 *
 * The records are the authority. The flat mirrors exist so that a node that
 * only knows the earlier flat format still reads the lever of this node
 * instead of taking it for armed.
 */
export interface AutomationDisarmNodeState {
  /** 2 for the record format, 1 for the earlier flat format. */
  version: 1 | 2;
  /** One record per scope; absent only in the earlier flat format. */
  records?: AutomationDisarmRecord[];
  /** The flat mirror of the catch-all record. */
  disarmed: boolean;
  /** The flat mirror of every work key the records name. */
  blockedWorkKeys: string[];
  /** When the owner last changed the state. */
  changedAt: string;
  /** Only an explicit owner action writes this field. */
  changedBy: "owner";
  /** Owner-visible reason of the catch-all decision. */
  reason?: string;
}

/**
 * The durable owner-level "automation is forbidden" state.
 *
 * The file is the authority, not process memory: a restart re-reads it, so the
 * lever survives a restart of the runtime. `changedBy` is always `owner`,
 * because only an explicit owner action may write this file.
 */
export interface AutomationDisarmDocument extends AutomationDisarmNodeState {
  /** One record per scope. */
  records: AutomationDisarmRecord[];
}

/**
 * Who asks for a state change.
 *
 * Only `owner` may change the state. Every automatic path in the runtime asks
 * with `automation` and is refused with a reason, so a retry, an autopilot
 * sweep, a policy reload or a re-dispatch can never lift the lever.
 */
export type AutomationDisarmSource = "owner" | "automation";

/** The legacy flat change: one global lever and one flat list of work keys. */
export interface AutomationDisarmChange {
  source: AutomationDisarmSource;
  /** The requested global lever position. */
  disarmed: boolean;
  /** Owner-visible reason. */
  reason?: string;
  /** Logical work keys to block; `undefined` keeps the recorded set. */
  workKeys?: string[];
  /** The revision of the live launch policy at the moment of the change. */
  policyRevision?: string;
}

/** The change of one scope: an upsert of the record of that scope. */
export interface AutomationDisarmRecordChange {
  source: AutomationDisarmSource;
  /** `"*"` or the absolute path of the project. */
  scope: string;
  /** True forbids the automatic launches of the scope, false permits them. */
  forbidden: boolean;
  /** The identity of the owner who made the decision. */
  owner?: string;
  /** Owner-visible reason. */
  reason?: string;
  /** The finer boundary inside the scope. */
  workKeys?: string[];
  /** The revision of the live launch policy at the moment of the change. */
  policyRevision?: string;
  /** The expected revision of the state; a mismatch changes nothing. */
  ifMatch?: string;
}

export type AutomationDisarmChangeResult =
  | { ok: true; state: AutomationDisarmDocument }
  | {
    ok: false;
    code: "automation_cannot_change_disarm" | "invalid_work_key" | "state_conflict" | "invalid_scope";
    reason: string;
    state: AutomationDisarmDocument;
  };

/** The refusal every automatic attempt to change the lever receives. */
export const AUTOMATION_CANNOT_CHANGE_DISARM_REASON =
  "Автоматический путь не может снять или изменить запрет автоматики: состояние меняет только явное действие владельца.";

/** The state of a runtime that never had an owner decision. */
export function armedState(): AutomationDisarmDocument {
  return {
    version: 2,
    records: [],
    changedAt: "",
    changedBy: "owner",
    disarmed: false,
    blockedWorkKeys: [],
  };
}

/**
 * The state of a runtime whose owner file cannot be trusted.
 *
 * A corrupt or unreadable owner file is fail-closed for automation: the lever
 * reads as forbidden rather than silently re-enabling automatic launches.
 */
export function unreadableState(reason: string): AutomationDisarmDocument {
  return {
    version: 2,
    records: [{ scope: ALL_SCOPES, forbidden: true, reason, createdAt: "" }],
    changedAt: "",
    changedBy: "owner",
    disarmed: true,
    blockedWorkKeys: [],
    reason,
  };
}

/**
 * The revision of one state.
 *
 * The revision is a hash of the exact state, so it identifies the state
 * without exposing it and changes whenever the state changes. A write may
 * name it in `If-Match`, and a mismatch means the state moved under the
 * caller: the write is refused instead of overwriting a newer decision.
 */
export function automationDisarmEtag(state: AutomationDisarmDocument): string {
  const canonical = JSON.stringify({
    records: [...state.records]
      .sort((left, right) => left.scope.localeCompare(right.scope))
      .map((record) => ({
        scope: record.scope,
        forbidden: record.forbidden,
        owner: record.owner ?? "",
        reason: record.reason ?? "",
        createdAt: record.createdAt,
        policyRevision: record.policyRevision ?? "",
        workKeys: record.workKeys ?? [],
      })),
    changedAt: state.changedAt,
    changedBy: state.changedBy,
  });
  return `"${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}"`;
}

/**
 * The durable store of the owner-level automation lever.
 *
 * The file lives in the runtime state directory, so it is as durable as the
 * launch policy beside it and survives a restart of the process. Writes are
 * atomic and interprocess-locked, so two writers never leave a partial file.
 */
export class AutomationDisarmStore {
  constructor(readonly path: string) {}

  /** The store of one runtime state directory. */
  static at(stateDir: string): AutomationDisarmStore {
    return new AutomationDisarmStore(join(stateDir, AUTOMATION_DISARM_FILE_NAME));
  }

  /** The store of the configured runtime state directory. */
  static forRuntime(env: NodeJS.ProcessEnv = process.env): AutomationDisarmStore {
    return AutomationDisarmStore.at(resolveAutopilotStateDir(env));
  }

  /**
   * Read the current state.
   *
   * An absent file is an armed runtime. A file that exists but cannot be
   * parsed is fail-closed and reads as forbidden.
   */
  async read(): Promise<AutomationDisarmDocument> {
    return (await this.readState()).state;
  }

  /** Read the current state together with the revision of that exact state. */
  async readState(): Promise<{ state: AutomationDisarmDocument; etag: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const state = armedState();
        return { state, etag: automationDisarmEtag(state) };
      }
      const state = unreadableState(`Файл состояния запрета автоматики недоступен: ${(error as Error).message}`);
      return { state, etag: automationDisarmEtag(state) };
    }
    try {
      const state = parseDisarmDocument(JSON.parse(raw));
      return { state, etag: automationDisarmEtag(state) };
    } catch (error) {
      const state = unreadableState(`Файл состояния запрета автоматики повреждён: ${(error as Error).message}`);
      return { state, etag: automationDisarmEtag(state) };
    }
  }

  /**
   * Apply one owner action in the earlier flat shape.
   *
   * The flat lever is the catch-all scope, and the flat list of work keys is
   * the finer boundary inside it. The action is refused for an automatic
   * caller and changes nothing in that case.
   */
  async apply(change: AutomationDisarmChange): Promise<AutomationDisarmChangeResult> {
    if (change.source !== "owner") {
      return {
        ok: false,
        code: "automation_cannot_change_disarm",
        reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        state: await this.read(),
      };
    }
    return this.serial(() => this.withFileLock(async () => {
      const current = await this.read();
      const canonical = await this.canonicalWorkKeys(change.workKeys);
      if (canonical === null) {
        return {
          ok: false,
          code: "invalid_work_key",
          reason: `Ключ работы '${(change.workKeys ?? []).find((key) => !normalizeWorkKeyInput(key)) ?? ""}' не распознан. Ожидается 'harness|каталог|имя' или 'project|ключ'.`,
          state: current,
        };
      }
      const now = new Date().toISOString();
      // The flat lever is the catch-all record: the earlier broad record of
      // that scope is replaced, and a record that names exact works is kept.
      let records = current.records.filter((record) => !(record.scope === ALL_SCOPES && !record.workKeys?.length));
      records.push({
        scope: ALL_SCOPES,
        forbidden: change.disarmed,
        createdAt: now,
        ...(change.reason ? { reason: change.reason } : {}),
        ...(change.policyRevision ? { policyRevision: change.policyRevision } : {}),
      });
      let blockedWorkKeys = current.blockedWorkKeys;
      if (canonical !== undefined) {
        // The named works are the whole flat list of the earlier format, so
        // the records that name exact works are replaced as a whole.
        records = records.filter((record) => !record.workKeys?.length);
        for (const key of canonical) {
          records.push({
            scope: await canonicalScopePath(scopeOfWorkKey(key)),
            forbidden: true,
            workKeys: [key],
            createdAt: now,
          });
        }
        blockedWorkKeys = canonical;
      }
      const state = buildDocument(records, { changedAt: now, blockedWorkKeys });
      await this.write(state);
      return { ok: true, state };
    }));
  }

  /**
   * Apply one owner action on one scope.
   *
   * The action is an upsert: the record of that scope is replaced by the
   * requested one. A scope that is forbidden and later permitted is one
   * record, so the explicit permission wins over the earlier prohibition.
   */
  async applyRecord(change: AutomationDisarmRecordChange): Promise<AutomationDisarmChangeResult> {
    if (change.source !== "owner") {
      return {
        ok: false,
        code: "automation_cannot_change_disarm",
        reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        state: await this.read(),
      };
    }
    return this.serial(() => this.withFileLock(async () => {
      const current = await this.read();
      if (change.ifMatch !== undefined && change.ifMatch !== automationDisarmEtag(current)) {
        return {
          ok: false,
          code: "state_conflict",
          reason: "Состояние запрета автоматики изменилось после того, как его прочитали: запись отменена.",
          state: current,
        };
      }
      if (typeof change.scope !== "string" || !change.scope.trim()) {
        return {
          ok: false,
          code: "invalid_scope",
          reason: "Область обязательна: это '*' или абсолютный путь проекта.",
          state: current,
        };
      }
      const canonical = await this.canonicalWorkKeys(change.workKeys);
      if (canonical === null) {
        return {
          ok: false,
          code: "invalid_work_key",
          reason: `Ключ работы '${(change.workKeys ?? []).find((key) => !normalizeWorkKeyInput(key)) ?? ""}' не распознан. Ожидается 'harness|каталог|имя' или 'project|ключ'.`,
          state: current,
        };
      }
      const scope = change.scope.trim() === ALL_SCOPES
        ? ALL_SCOPES
        : await canonicalScopePath(change.scope.trim());
      const now = new Date().toISOString();
      // One record per scope: the upsert replaces every record of that scope.
      const records = current.records.filter((record) => record.scope !== scope);
      records.push({
        scope,
        forbidden: change.forbidden,
        createdAt: now,
        ...(change.owner ? { owner: change.owner } : {}),
        ...(change.reason ? { reason: change.reason } : {}),
        ...(change.policyRevision ? { policyRevision: change.policyRevision } : {}),
        ...(canonical !== undefined ? { workKeys: canonical } : {}),
      });
      const state = buildDocument(records, { changedAt: now });
      await this.write(state);
      return { ok: true, state };
    }));
  }

  /**
   * Replace the whole record set with the one of another node.
   *
   * The fleet carries the owner decision as a whole, so a node converges to
   * the record set of the node that took the decision. A node that cannot
   * read the records refuses the change instead of holding a partial state.
   */
  async replaceRecords(change: {
    source: AutomationDisarmSource;
    records: AutomationDisarmRecord[];
    reason?: string;
  }): Promise<AutomationDisarmChangeResult> {
    if (change.source !== "owner") {
      return {
        ok: false,
        code: "automation_cannot_change_disarm",
        reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        state: await this.read(),
      };
    }
    return this.serial(() => this.withFileLock(async () => {
      const current = await this.read();
      const now = new Date().toISOString();
      const records: AutomationDisarmRecord[] = [];
      for (const record of change.records) {
        const scope = record.scope === ALL_SCOPES ? ALL_SCOPES : await canonicalScopePath(record.scope);
        records.push({
          scope,
          forbidden: record.forbidden,
          createdAt: record.createdAt || now,
          ...(record.owner ? { owner: record.owner } : {}),
          ...(record.reason ? { reason: record.reason } : {}),
          ...(record.policyRevision ? { policyRevision: record.policyRevision } : {}),
          ...(record.workKeys?.length ? { workKeys: [...record.workKeys] } : {}),
        });
      }
      const state = buildDocument(records, { changedAt: now });
      await this.write(state);
      return { ok: true, state };
    }));
  }

  /** The canonical form of the named works, or undefined when none are named. */
  private async canonicalWorkKeys(
    workKeys: string[] | undefined,
  ): Promise<string[] | undefined | null> {
    if (workKeys === undefined) return undefined;
    const canonical: string[] = [];
    for (const key of workKeys) {
      const normalized = normalizeWorkKeyInput(key);
      if (!normalized) return null;
      canonical.push(normalized);
    }
    return [...new Set(canonical)];
  }

  private async write(state: AutomationDisarmDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    // The flat mirrors travel with the records, so a node that only knows the
    // earlier format still reads this lever instead of taking it for armed.
    const stored = {
      version: 2,
      records: state.records,
      changedAt: state.changedAt,
      changedBy: state.changedBy,
      disarmed: state.disarmed,
      blockedWorkKeys: state.blockedWorkKeys,
      ...(state.reason ? { reason: state.reason } : {}),
    };
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(stored, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private operation: Promise<unknown> = Promise.resolve();

  /** Bounded interprocess lock: the owner file is the authority for every writer. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockTarget = `${this.path}.lock`;
    const handle = await open(lockTarget, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

/**
 * Build the durable state from its records.
 *
 * The records are the authority. The flat mirrors are derived from them, so a
 * reader of the earlier format sees the same lever the records describe.
 */
export function buildDocument(
  records: AutomationDisarmRecord[],
  options: { changedAt: string; blockedWorkKeys?: string[] },
): AutomationDisarmDocument {
  const sorted = sortRecords(records);
  const broad = sorted.find((record) => record.scope === ALL_SCOPES && !record.workKeys?.length);
  const blockedWorkKeys = options.blockedWorkKeys ?? sorted.flatMap((record) => record.workKeys ?? []);
  const reason = broad?.reason;
  return {
    version: 2,
    records: sorted,
    changedAt: options.changedAt,
    changedBy: "owner",
    disarmed: broad?.forbidden === true,
    blockedWorkKeys: [...new Set(blockedWorkKeys)],
    ...(reason ? { reason } : {}),
  };
}

/** The records of one state, ordered by scope. */
export function sortRecords(records: AutomationDisarmRecord[]): AutomationDisarmRecord[] {
  return [...records].sort((left, right) => left.scope.localeCompare(right.scope));
}

/**
 * Read the durable state, in either format.
 *
 * The earlier flat format is expanded into records instead of being dropped:
 * the flat lever becomes the catch-all record and every named work becomes a
 * record of the scope it belongs to. A file that is neither format cannot be
 * trusted and is refused by the caller as forbidden.
 */
export function parseDisarmDocument(value: unknown): AutomationDisarmDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected shape");
  const file = value as Record<string, unknown>;
  if (file.version === 2) return parseRecordDocument(file);
  if (file.version === 1) return parseFlatDocument(file);
  throw new Error("unsupported version");
}

/** The record format: one record per scope. */
function parseRecordDocument(file: Record<string, unknown>): AutomationDisarmDocument {
  if (!Array.isArray(file.records)) throw new Error("records must be a list");
  const records: AutomationDisarmRecord[] = [];
  for (const entry of file.records) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("a record must be an object");
    const record = entry as Record<string, unknown>;
    if (typeof record.scope !== "string" || !record.scope) throw new Error("a record must name its scope");
    if (typeof record.forbidden !== "boolean") throw new Error("a record must be forbidden or not");
    const workKeys = record.workKeys === undefined ? [] : record.workKeys;
    if (!Array.isArray(workKeys) || workKeys.some((key) => typeof key !== "string")) {
      throw new Error("the work keys of a record must be a string list");
    }
    records.push({
      scope: record.scope,
      forbidden: record.forbidden,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
      ...(typeof record.owner === "string" && record.owner ? { owner: record.owner } : {}),
      ...(typeof record.reason === "string" && record.reason ? { reason: record.reason } : {}),
      ...(typeof record.policyRevision === "string" && record.policyRevision ? { policyRevision: record.policyRevision } : {}),
      ...(workKeys.length ? { workKeys: workKeys as string[] } : {}),
    });
  }
  const changedAt = typeof file.changedAt === "string" ? file.changedAt : "";
  const blocked = file.blockedWorkKeys === undefined ? undefined : file.blockedWorkKeys;
  if (blocked !== undefined && (!Array.isArray(blocked) || blocked.some((key) => typeof key !== "string"))) {
    throw new Error("blockedWorkKeys must be a string list");
  }
  return buildDocument(records, {
    changedAt,
    ...(blocked ? { blockedWorkKeys: blocked as string[] } : {}),
  });
}

/**
 * The earlier flat format, expanded into records.
 *
 * Nothing is lost: the flat lever becomes the catch-all record and every
 * named work becomes a record of the scope that work belongs to.
 */
function parseFlatDocument(file: Record<string, unknown>): AutomationDisarmDocument {
  if (typeof file.disarmed !== "boolean") throw new Error("disarmed must be a boolean");
  const blocked = file.blockedWorkKeys === undefined ? [] : file.blockedWorkKeys;
  if (!Array.isArray(blocked) || blocked.some((key) => typeof key !== "string")) {
    throw new Error("blockedWorkKeys must be a string list");
  }
  const changedAt = typeof file.changedAt === "string" ? file.changedAt : "";
  const reason = typeof file.reason === "string" && file.reason ? file.reason : undefined;
  const records: AutomationDisarmRecord[] = [{
    scope: ALL_SCOPES,
    forbidden: file.disarmed,
    createdAt: changedAt,
    ...(reason ? { reason } : {}),
  }];
  for (const key of blocked as string[]) {
    records.push({
      scope: scopeOfWorkKey(key),
      forbidden: true,
      workKeys: [key],
      createdAt: changedAt,
    });
  }
  return buildDocument(records, { changedAt, blockedWorkKeys: blocked as string[] });
}
