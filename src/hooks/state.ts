import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { HOOK_KINDS, isHookKind, type HookKind } from "./catalog.js";

/** The durable document of the lever of the owner. */
export const HOOKS_PROHIBITIONS_FILE_NAME = "hooks-prohibitions.json";

/** The append-only journal of the changes of the lever, beside the document. */
export const HOOKS_PROHIBITIONS_AUDIT_FILE_NAME = "hooks-prohibitions.audit.jsonl";

/**
 * The durable state of the prohibitions of the hooks.
 *
 * The document is the authority, not the memory of the process: a restart
 * re-reads it, so the lever of the owner survives a restart of the runtime.
 *
 * Two levers live here and they are not the same lever. `hooksEnabled` is the
 * switch of the whole optional hooks runtime of the herder: while it is off,
 * no hook of the herder runs at all — neither the ones that forbid something
 * nor the ones that only carry the context of the session.
 * `prohibitionsEnabled` says whether the hooks that run may forbid a tool
 * call or hold the stop of a turn. Turning the prohibitions off never stops
 * the hooks from running, and turning the hooks off is not the same thing as
 * turning the prohibitions off.
 *
 * The default is the current behaviour of the product — the hooks are off and
 * nothing forbids anything — and only an explicit action of the owner turns
 * them on. A document that does not know the switch is a document of an older
 * runtime, and it is read as off: an optional integration never comes back by
 * itself.
 */
export interface HooksProhibitionsDocument {
  /** 1 for the only format of the document. */
  version: 1;
  /** True runs the optional hooks runtime of the herder, false keeps it quiet. */
  hooksEnabled: boolean;
  /** True forbids the hooks, false permits them to forbid nothing. */
  prohibitionsEnabled: boolean;
  /** The hooks whose own prohibitions are off, even when the others are on. */
  disabledHooks: HookKind[];
  /** The hooks that do not run at all, even when the runtime is on. */
  inactiveHooks: HookKind[];
  /** The identity of the owner who changed the lever. */
  changedBy: string;
  /** When the owner changed the lever. */
  changedAt: string;
  /** The owner-visible reason of the change. */
  reason: string;
}

/** One change of the lever, as the journal keeps it. */
export interface HooksProhibitionsAuditRecord {
  at: string;
  actor: string;
  before: { hooksEnabled: boolean; prohibitionsEnabled: boolean; disabledHooks: HookKind[]; inactiveHooks: HookKind[] };
  after: { hooksEnabled: boolean; prohibitionsEnabled: boolean; disabledHooks: HookKind[]; inactiveHooks: HookKind[] };
  reason: string;
}

/** Who asks for a change of the lever. */
export type HooksProhibitionsSource = "owner" | "automation";

/** The change one caller asks for. */
export interface HooksProhibitionsChange {
  source: HooksProhibitionsSource;
  /** The identity of the owner, as the journal keeps it. */
  actor?: string;
  /** The requested position of the main lever; undefined keeps the current one. */
  prohibitionsEnabled?: boolean;
  /**
   * The requested position of the whole hooks runtime.
   *
   * Undefined keeps the current position. This switch is never written by the
   * automatic paths: only an explicit action of the owner moves it, so an
   * auto-install or a fleet sync can never turn the hooks back on.
   */
  hooksEnabled?: boolean;
  /** The hooks whose prohibitions are off; undefined keeps the recorded set. */
  disabledHooks?: HookKind[];
  /**
   * The hooks that do not run at all.
   *
   * Undefined keeps the recorded set. Like the switch of the whole runtime,
   * this list moves only by an explicit action of the owner.
   */
  inactiveHooks?: HookKind[];
  /** The owner-visible reason of the change. */
  reason?: string;
}

/** The answer of a change: the new state and whether anything moved. */
export type HooksProhibitionsChangeResult =
  | { ok: true; state: HooksProhibitionsDocument; changed: boolean; etag: string }
  | {
    ok: false;
    code: "automation_cannot_change_prohibitions" | "unknown_hook";
    reason: string;
    state: HooksProhibitionsDocument;
  };

/**
 * The state of a runtime that never had a decision of the owner.
 *
 * The optional hooks runtime of the herder is off, and nothing forbids
 * anything. A new installation, a new session and an update all start here:
 * an optional integration is opt-in, never opt-out.
 */
export function defaultHooksProhibitions(): HooksProhibitionsDocument {
  return {
    version: 1,
    hooksEnabled: false,
    prohibitionsEnabled: false,
    disabledHooks: [],
    inactiveHooks: [],
    changedBy: "owner",
    changedAt: "",
    reason: "",
  };
}

/** The refusal every automatic attempt to change the lever receives. */
export const AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON =
  "Автоматический путь не может изменить запреты хуков: состояние меняет только явное действие владельца.";

/**
 * The revision of one state.
 *
 * The revision is a hash of the exact state: it identifies the state without
 * exposing it and changes whenever the state changes. A write may name it in
 * `If-Match`, and a mismatch means the state moved under the caller.
 */
export function hooksProhibitionsEtag(state: HooksProhibitionsDocument): string {
  const canonical = JSON.stringify({
    hooksEnabled: state.hooksEnabled,
    prohibitionsEnabled: state.prohibitionsEnabled,
    disabledHooks: [...state.disabledHooks].sort(),
    inactiveHooks: [...state.inactiveHooks].sort(),
    changedAt: state.changedAt,
    changedBy: state.changedBy,
  });
  return `"${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}"`;
}

/**
 * Read the durable state, in the only format of the document.
 *
 * A document that cannot be trusted is refused by the caller: the state is
 * unknown, and the hooks that ask for it forbid nothing.
 */
export function parseHooksProhibitions(value: unknown): HooksProhibitionsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected shape");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) throw new Error("unsupported version");
  if (typeof file.prohibitionsEnabled !== "boolean") throw new Error("prohibitionsEnabled must be a boolean");
  // A document of an older runtime does not know the switch of the whole
  // hooks runtime. It is read as off: an optional integration never comes
  // back by itself, not after an update either.
  const hooksEnabled = file.hooksEnabled === undefined ? false : file.hooksEnabled;
  if (typeof hooksEnabled !== "boolean") throw new Error("hooksEnabled must be a boolean");
  const disabled = file.disabledHooks === undefined ? [] : file.disabledHooks;
  if (!Array.isArray(disabled) || disabled.some((kind) => !isHookKind(kind))) throw new Error("disabledHooks must be a list of hooks");
  const hooks = [...new Set(disabled as HookKind[])].sort(
    (left, right) => HOOK_KINDS.indexOf(left) - HOOK_KINDS.indexOf(right),
  );
  // The hooks that do not run at all. A document of an older runtime does not
  // know the list, and an unknown list means that no hook is switched off on
  // its own: the runtime switch decides.
  const inactive = file.inactiveHooks === undefined ? [] : file.inactiveHooks;
  if (!Array.isArray(inactive) || inactive.some((kind) => !isHookKind(kind))) throw new Error("inactiveHooks must be a list of hooks");
  const inactiveHooks = [...new Set(inactive as HookKind[])].sort(
    (left, right) => HOOK_KINDS.indexOf(left) - HOOK_KINDS.indexOf(right),
  );
  return {
    version: 1,
    hooksEnabled,
    prohibitionsEnabled: file.prohibitionsEnabled,
    disabledHooks: hooks,
    inactiveHooks,
    changedBy: typeof file.changedBy === "string" && file.changedBy ? file.changedBy : "owner",
    changedAt: typeof file.changedAt === "string" ? file.changedAt : "",
    reason: typeof file.reason === "string" ? file.reason : "",
  };
}

/** Do the two states say the same thing? */
export function sameHooksProhibitions(left: HooksProhibitionsDocument, right: HooksProhibitionsDocument): boolean {
  return left.hooksEnabled === right.hooksEnabled
    && left.prohibitionsEnabled === right.prohibitionsEnabled
    && left.disabledHooks.length === right.disabledHooks.length
    && left.disabledHooks.every((kind, index) => kind === right.disabledHooks[index])
    && left.inactiveHooks.length === right.inactiveHooks.length
    && left.inactiveHooks.every((kind, index) => kind === right.inactiveHooks[index]);
}

/**
 * The durable store of the lever of the owner.
 *
 * The file lives in the runtime state directory, so it is as durable as the
 * launch policy beside it. Writes are atomic and interprocess-locked, so two
 * writers never leave a partial file.
 */
export class HooksProhibitionsStore {
  constructor(readonly path: string) {}

  /** The store of one runtime state directory. */
  static at(stateDir: string): HooksProhibitionsStore {
    return new HooksProhibitionsStore(join(stateDir, HOOKS_PROHIBITIONS_FILE_NAME));
  }

  /** The store of the configured runtime state directory. */
  static forRuntime(env: NodeJS.ProcessEnv = process.env): HooksProhibitionsStore {
    return HooksProhibitionsStore.at(resolveAutopilotStateDir(env));
  }

  /** The journal of the changes, beside the document. */
  get auditPath(): string {
    return join(dirname(this.path), HOOKS_PROHIBITIONS_AUDIT_FILE_NAME);
  }

  /**
   * Read the current state.
   *
   * An absent file is a runtime that never had a decision: the prohibitions
   * are on. A file that cannot be parsed is not a decision at all: the state
   * is unknown, and the caller says so instead of guessing.
   */
  async read(): Promise<HooksProhibitionsDocument> {
    return (await this.readState()).state;
  }

  /** Read the current state together with the revision of that exact state. */
  async readState(): Promise<{ state: HooksProhibitionsDocument; known: boolean; reason?: string; etag: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const state = defaultHooksProhibitions();
        return { state, known: true, etag: hooksProhibitionsEtag(state) };
      }
      const state = defaultHooksProhibitions();
      return {
        state,
        known: false,
        reason: `Файл состояния запретов хуков недоступен: ${(error as Error).message}`,
        etag: hooksProhibitionsEtag(state),
      };
    }
    try {
      const state = parseHooksProhibitions(JSON.parse(raw));
      return { state, known: true, etag: hooksProhibitionsEtag(state) };
    } catch (error) {
      const state = defaultHooksProhibitions();
      return {
        state,
        known: false,
        reason: `Файл состояния запретов хуков повреждён: ${(error as Error).message}`,
        etag: hooksProhibitionsEtag(state),
      };
    }
  }

  /**
   * Apply one change of the owner.
   *
   * The change is refused for an automatic caller and changes nothing in that
   * case. The same change twice changes nothing the second time: the journal
   * keeps one record of one decision, not one record of every retry.
   */
  async apply(change: HooksProhibitionsChange): Promise<HooksProhibitionsChangeResult> {
    if (change.source !== "owner") {
      const current = await this.read();
      return {
        ok: false,
        code: "automation_cannot_change_prohibitions",
        reason: AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON,
        state: current,
      };
    }
    if (change.disabledHooks?.some((kind) => !isHookKind(kind))) {
      const current = await this.read();
      return {
        ok: false,
        code: "unknown_hook",
        reason: `Такого хука нет: ${(change.disabledHooks ?? []).filter((kind) => !isHookKind(kind)).join(", ")}. Доступны: ${HOOK_KINDS.join(", ")}.`,
        state: current,
      };
    }
    if (change.inactiveHooks?.some((kind) => !isHookKind(kind))) {
      const current = await this.read();
      return {
        ok: false,
        code: "unknown_hook",
        reason: `Такого хука нет: ${(change.inactiveHooks ?? []).filter((kind) => !isHookKind(kind)).join(", ")}. Доступны: ${HOOK_KINDS.join(", ")}.`,
        state: current,
      };
    }
    return this.serial(() => this.withFileLock(async () => {
      const current = await this.read();
      const now = new Date().toISOString();
      const next: HooksProhibitionsDocument = {
        version: 1,
        // The switch of the whole hooks runtime moves only when the owner
        // names it. An automatic path leaves it as it is.
        hooksEnabled: change.hooksEnabled ?? current.hooksEnabled,
        prohibitionsEnabled: change.prohibitionsEnabled ?? current.prohibitionsEnabled,
        disabledHooks: change.disabledHooks
          ? [...new Set(change.disabledHooks)].sort((left, right) => HOOK_KINDS.indexOf(left) - HOOK_KINDS.indexOf(right))
          : [...current.disabledHooks],
        inactiveHooks: change.inactiveHooks
          ? [...new Set(change.inactiveHooks)].sort((left, right) => HOOK_KINDS.indexOf(left) - HOOK_KINDS.indexOf(right))
          : [...current.inactiveHooks],
        changedBy: change.actor?.trim() || current.changedBy || "owner",
        changedAt: now,
        reason: change.reason?.trim() || current.reason,
      };
      // The same decision twice is one decision: the state does not move and
      // the journal does not grow.
      if (sameHooksProhibitions(current, next)) {
        return { ok: true, state: current, changed: false, etag: hooksProhibitionsEtag(current) };
      }
      await this.write(next);
      await appendHooksProhibitionsAudit(this.auditPath, {
        at: now,
        actor: next.changedBy,
        before: { hooksEnabled: current.hooksEnabled, prohibitionsEnabled: current.prohibitionsEnabled, disabledHooks: [...current.disabledHooks], inactiveHooks: [...current.inactiveHooks] },
        after: { hooksEnabled: next.hooksEnabled, prohibitionsEnabled: next.prohibitionsEnabled, disabledHooks: [...next.disabledHooks], inactiveHooks: [...next.inactiveHooks] },
        reason: next.reason,
      });
      return { ok: true, state: next, changed: true, etag: hooksProhibitionsEtag(next) };
    }));
  }

  /** The journal of the changes, the last records last. */
  async audit(limit = 20): Promise<HooksProhibitionsAuditRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.auditPath, "utf8");
    } catch {
      return [];
    }
    const records: HooksProhibitionsAuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as HooksProhibitionsAuditRecord;
        if (record && typeof record.at === "string") records.push(record);
      } catch {
        // A damaged line of the journal does not hide the other records.
      }
    }
    return records.slice(-limit);
  }

  private async write(state: HooksProhibitionsDocument): Promise<void> {
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

/**
 * Append one change of the lever to the journal.
 *
 * The journal is a trail, not a gate: a failed write never fails the change.
 */
export async function appendHooksProhibitionsAudit(
  auditPath: string,
  record: HooksProhibitionsAuditRecord,
): Promise<void> {
  try {
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // The journal must not break the change.
  }
}
