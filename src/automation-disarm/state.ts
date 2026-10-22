import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { normalizeWorkKeyInput } from "./work-key.js";

/** The durable owner-level state file, next to the live launch policy. */
export const AUTOMATION_DISARM_FILE_NAME = "automation-disarm.json";

/**
 * The durable owner-level "automation is forbidden" state.
 *
 * The file is the authority, not process memory: a restart re-reads it, so the
 * lever survives a restart of the runtime. `changedBy` is always `owner`,
 * because only an explicit owner action may write this file.
 */
export interface AutomationDisarmDocument {
  version: 1;
  /** The global lever: every automatic launch is refused while this is true. */
  disarmed: boolean;
  /** When the owner last changed the state. */
  changedAt: string;
  /** Only an explicit owner action writes this field. */
  changedBy: "owner";
  /** Owner-visible reason for the last change. */
  reason?: string;
  /** Logical work keys blocked even when the global lever is off. */
  blockedWorkKeys: string[];
}

/**
 * Who asks for a state change.
 *
 * Only `owner` may change the state. Every automatic path in the runtime asks
 * with `automation` and is refused with a reason, so a retry, an autopilot
 * sweep, a policy reload or a re-dispatch can never lift the lever.
 */
export type AutomationDisarmSource = "owner" | "automation";

export interface AutomationDisarmChange {
  source: AutomationDisarmSource;
  /** The requested global lever position. */
  disarmed: boolean;
  /** Owner-visible reason. */
  reason?: string;
  /** Logical work keys to block; `undefined` keeps the recorded set. */
  workKeys?: string[];
}

export type AutomationDisarmChangeResult =
  | { ok: true; state: AutomationDisarmDocument }
  | {
    ok: false;
    code: "automation_cannot_change_disarm" | "invalid_work_key";
    reason: string;
    state: AutomationDisarmDocument;
  };

/** The refusal every automatic attempt to change the lever receives. */
export const AUTOMATION_CANNOT_CHANGE_DISARM_REASON =
  "Автоматический путь не может снять или изменить запрет автоматики: состояние меняет только явное действие владельца.";

/** The state of a runtime that never had an owner decision. */
export function armedState(): AutomationDisarmDocument {
  return { version: 1, disarmed: false, changedAt: "", changedBy: "owner", blockedWorkKeys: [] };
}

/**
 * The state of a runtime whose owner file cannot be trusted.
 *
 * A corrupt or unreadable owner file is fail-closed for automation: the lever
 * reads as disarmed rather than silently re-enabling automatic launches.
 */
export function unreadableState(reason: string): AutomationDisarmDocument {
  return { version: 1, disarmed: true, changedAt: "", changedBy: "owner", reason, blockedWorkKeys: [] };
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
   * parsed is fail-closed and reads as disarmed.
   */
  async read(): Promise<AutomationDisarmDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return armedState();
      return unreadableState(`Файл состояния запрета автоматики недоступен: ${(error as Error).message}`);
    }
    try {
      return parseDisarmDocument(JSON.parse(raw));
    } catch (error) {
      return unreadableState(`Файл состояния запрета автоматики повреждён: ${(error as Error).message}`);
    }
  }

  /**
   * Apply one owner action.
   *
   * An automatic request is refused with a reason and changes nothing: the
   * lever is only ever moved by an explicit owner action.
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
      // The owner may name a work in the readable form or in the canonical
      // one. Both are stored canonically, and a key that reads as neither is
      // refused: a silently dropped key would look like a blocked work.
      const canonical: string[] = [];
      for (const key of change.workKeys ?? []) {
        const normalized = normalizeWorkKeyInput(key);
        if (!normalized) {
          return {
            ok: false,
            code: "invalid_work_key",
            reason: `Ключ работы '${key}' не распознан. Ожидается 'harness|каталог|имя' или 'project|ключ'.`,
            state: current,
          };
        }
        canonical.push(normalized);
      }
      const state: AutomationDisarmDocument = {
        version: 1,
        disarmed: change.disarmed,
        changedAt: new Date().toISOString(),
        changedBy: "owner",
        ...(change.reason ? { reason: change.reason } : {}),
        blockedWorkKeys: change.workKeys === undefined
          ? current.blockedWorkKeys
          : [...new Set(canonical)],
      };
      await this.write(state);
      return { ok: true, state };
    }));
  }

  private async write(state: AutomationDisarmDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
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

/** Accept only a file that has the exact owner-decision shape. */
function parseDisarmDocument(value: unknown): AutomationDisarmDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected shape");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) throw new Error("unsupported version");
  if (typeof file.disarmed !== "boolean") throw new Error("disarmed must be a boolean");
  const blocked = file.blockedWorkKeys === undefined ? [] : file.blockedWorkKeys;
  if (!Array.isArray(blocked) || blocked.some((key) => typeof key !== "string")) {
    throw new Error("blockedWorkKeys must be a string list");
  }
  return {
    version: 1,
    disarmed: file.disarmed,
    changedAt: typeof file.changedAt === "string" ? file.changedAt : "",
    changedBy: "owner",
    ...(typeof file.reason === "string" && file.reason ? { reason: file.reason } : {}),
    blockedWorkKeys: blocked as string[],
  };
}
