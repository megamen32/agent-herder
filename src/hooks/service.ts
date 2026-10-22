import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { HOOK_CATALOG, isHookKind, type HookKind } from "./catalog.js";
import {
  HooksProhibitionsStore,
  type HooksProhibitionsAuditRecord,
  type HooksProhibitionsChange,
  type HooksProhibitionsChangeResult,
  type HooksProhibitionsDocument,
} from "./state.js";

/** The durable file of the activity of the hooks. */
export const HOOKS_ACTIVITY_FILE_NAME = "hooks-activity.json";

/** How long the activity of the hooks is kept in memory before it is written. */
const ACTIVITY_FLUSH_MS = 30_000;

/** The last refusal of one hook, as the owner reads it. */
export interface HooksActivityRefusal {
  at: string;
  reason: string;
  sessionId?: string;
  harness?: string;
}

/** The durable activity of the hooks: when they fired and what they refused. */
export interface HooksActivityDocument {
  version: 1;
  /** When each hook fired last. */
  lastFired: Partial<Record<HookKind, string>>;
  /** The last refusal of each hook. */
  lastRefusal: Partial<Record<HookKind, HooksActivityRefusal>>;
}

/** The state of one hook as the panel shows it. */
export interface HooksPanelHook {
  kind: HookKind;
  humanName: string;
  purpose: string;
  scope: string;
  canProhibit: boolean;
  prohibition: string;
  /** «включены», «выключены», «неизвестно» or «не запрещает». */
  state: string;
  /** When the hook fired last, if it ever did. */
  lastFiredAt?: string;
  /** The last refusal of the hook, with its reason. */
  lastRefusal?: HooksActivityRefusal;
}

/** The whole view of the hooks, as the panel reads it. */
export interface HooksPanelView {
  ok: true;
  /** False when the state of the lever cannot be trusted. */
  known: boolean;
  /** True when the hooks may forbid something. */
  prohibitionsEnabled: boolean;
  /** The hooks whose own prohibitions are off. */
  disabledHooks: HookKind[];
  changedBy: string;
  changedAt: string;
  reason: string;
  etag: string;
  hooks: HooksPanelHook[];
  audit: HooksProhibitionsAuditRecord[];
}

/** The light answer of the hooks: what they must know to stay quiet. */
export interface HooksProhibitionsRead {
  ok: true;
  /** False when the state of the lever cannot be trusted. */
  known: boolean;
  prohibitionsEnabled: boolean;
  disabledHooks: HookKind[];
  etag: string;
  reason?: string;
}

/** What one hook reports about itself. */
export interface HooksActivityReport {
  hook: string;
  /** «fired» — the hook ran; «refused» — the hook refused something. */
  outcome: "fired" | "refused";
  reason?: string;
  sessionId?: string;
  harness?: string;
  at?: string;
}

/**
 * Does this hook still forbid anything?
 *
 * An unknown state forbids nothing: a hook that cannot learn the decision of
 * the owner must stay quiet rather than guess. A hook that is named in the
 * disabled set forbids nothing even when the other hooks still do.
 */
export function hookProhibitionsEnabled(
  state: HooksProhibitionsDocument,
  known: boolean,
  kind: HookKind,
): boolean {
  if (!known) return false;
  if (!state.prohibitionsEnabled) return false;
  if (state.disabledHooks.includes(kind)) return false;
  return true;
}

/**
 * The durable activity of the hooks.
 *
 * The file is written when a hook refuses something and, for the ordinary
 * firing, at most once per half minute: the panel reads when a hook fired
 * last, and a minute of staleness there costs nothing while a write per tool
 * call would cost a lot.
 */
export class HooksActivityStore {
  constructor(readonly path: string) {}

  /** The store of one runtime state directory. */
  static at(stateDir: string): HooksActivityStore {
    return new HooksActivityStore(join(stateDir, HOOKS_ACTIVITY_FILE_NAME));
  }

  /** The store of the configured runtime state directory. */
  static forRuntime(env: NodeJS.ProcessEnv = process.env): HooksActivityStore {
    return HooksActivityStore.at(resolveAutopilotStateDir(env));
  }

  /**
   * The activity of the hooks.
   *
   * The document is kept in memory after the first read: the activity
   * arrives with every tool call, and reading the file every time would
   * cost more than the answer is worth.
   */
  async read(): Promise<HooksActivityDocument> {
    if (this.document) return this.document;
    let document: HooksActivityDocument = { version: 1, lastFired: {}, lastRefusal: {} };
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<HooksActivityDocument>;
      document = {
        version: 1,
        lastFired: parsed.lastFired && typeof parsed.lastFired === "object" ? parsed.lastFired : {},
        lastRefusal: parsed.lastRefusal && typeof parsed.lastRefusal === "object" ? parsed.lastRefusal : {},
      };
    } catch {
      // An unreadable file reads as an activity that never happened.
    }
    this.document = document;
    return document;
  }

  /** Remember that a hook fired. */
  async recordFired(kind: HookKind, at: string): Promise<void> {
    const document = await this.read();
    document.lastFired = { ...document.lastFired, [kind]: at };
    if (Date.now() - this.lastFlushAt < ACTIVITY_FLUSH_MS) return;
    await this.write(document);
  }

  /** Remember that a hook refused something; this is written at once. */
  async recordRefusal(kind: HookKind, refusal: HooksActivityRefusal): Promise<void> {
    const document = await this.read();
    document.lastFired = { ...document.lastFired, [kind]: refusal.at };
    document.lastRefusal = { ...document.lastRefusal, [kind]: refusal };
    await this.write(document);
  }

  private lastFlushAt = 0;

  private document: HooksActivityDocument | undefined;

  private async write(document: HooksActivityDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    this.document = document;
    this.lastFlushAt = Date.now();
  }
}

/**
 * The service of the hooks of the product.
 *
 * The service owns the lever of the owner and the activity of the hooks. It
 * never touches the automation lever, the emergency pause or the policy of
 * the projects: those are different levers with different owners.
 */
export class HooksService {
  constructor(
    readonly prohibitions: HooksProhibitionsStore,
    readonly activity: HooksActivityStore,
  ) {}

  /** The service of the configured runtime state directory. */
  static forRuntime(env: NodeJS.ProcessEnv = process.env): HooksService {
    const stateDir = resolveAutopilotStateDir(env);
    return new HooksService(HooksProhibitionsStore.at(stateDir), HooksActivityStore.at(stateDir));
  }

  /** The light answer the hooks ask for before they forbid something. */
  async readProhibitions(): Promise<HooksProhibitionsRead> {
    const { state, known, reason, etag } = await this.prohibitions.readState();
    return {
      ok: true,
      known,
      prohibitionsEnabled: known ? state.prohibitionsEnabled : false,
      disabledHooks: [...state.disabledHooks],
      etag,
      ...(reason ? { reason } : {}),
    };
  }

  /** The whole view of the hooks, as the panel reads it. */
  async readView(): Promise<HooksPanelView> {
    const { state, known, reason, etag } = await this.prohibitions.readState();
    const activity = await this.activity.read();
    const audit = await this.prohibitions.audit(20);
    const hooks: HooksPanelHook[] = HOOK_CATALOG.map((descriptor) => {
      const enabled = hookProhibitionsEnabled(state, known, descriptor.kind);
      return {
        kind: descriptor.kind,
        humanName: descriptor.humanName,
        purpose: descriptor.purpose,
        scope: descriptor.scope,
        canProhibit: descriptor.canProhibit,
        prohibition: descriptor.prohibition,
        state: !known ? "неизвестно" : !descriptor.canProhibit ? "не запрещает" : enabled ? "включены" : "выключены",
        ...(activity.lastFired[descriptor.kind] ? { lastFiredAt: activity.lastFired[descriptor.kind] } : {}),
        ...(activity.lastRefusal[descriptor.kind] ? { lastRefusal: activity.lastRefusal[descriptor.kind] } : {}),
      };
    });
    return {
      ok: true,
      known,
      prohibitionsEnabled: state.prohibitionsEnabled,
      disabledHooks: [...state.disabledHooks],
      changedBy: state.changedBy,
      changedAt: state.changedAt,
      reason: reason ?? state.reason,
      etag,
      hooks,
      audit,
    };
  }

  /** Apply one change of the owner and answer with the new view. */
  async applyProhibitions(
    change: HooksProhibitionsChange,
  ): Promise<{ ok: true; changed: boolean; view: HooksPanelView } | { ok: false; code: string; reason: string }> {
    const result: HooksProhibitionsChangeResult = await this.prohibitions.apply(change);
    if (!result.ok) {
      return { ok: false, code: result.code, reason: result.reason };
    }
    return { ok: true, changed: result.changed, view: await this.readView() };
  }

  /**
   * Remember what a hook did.
   *
   * Only a refusal is worth a durable record: the ordinary firing is a
   * timestamp, and the panel shows it as «когда последний раз сработал».
   */
  async recordActivity(report: HooksActivityReport): Promise<boolean> {
    if (!isHookKind(report.hook)) return false;
    const kind = report.hook;
    const at = typeof report.at === "string" && report.at ? report.at : new Date().toISOString();
    if (report.outcome === "refused") {
      await this.activity.recordRefusal(kind, {
        at,
        reason: typeof report.reason === "string" && report.reason ? report.reason : "причина не названа",
        ...(report.sessionId ? { sessionId: report.sessionId } : {}),
        ...(report.harness ? { harness: report.harness } : {}),
      });
      return true;
    }
    await this.activity.recordFired(kind, at);
    return true;
  }
}

