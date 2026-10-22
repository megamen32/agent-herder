/**
 * The state of the common settings on one node.
 *
 * The node keeps what it applied, when it applied it and the deviations it
 * replaced. The file is the node's own: a node that was off keeps its state
 * and catches up when it comes back, and the owner sees what every node holds
 * without reading a single file of another node.
 *
 * The opt-in flag lives here too: the node itself declares that it takes the
 * common settings, and a node that never declared it is never written to.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CommonSettingsDocument } from "./document.js";

/** The file of the state of the common settings of this node. */
export const COMMON_SETTINGS_STATE_FILE = join(
  homedir(),
  ".local",
  "share",
  "agent-herder",
  "fleet",
  "common-settings.json",
);

/** The role of the node in the contour of the common settings. */
export type CommonSettingsRole = "owner" | "member" | "none";

/**
 * A deviation of the node from the common value.
 *
 * The common value wins and is applied, but the value the node held stays
 * visible here with both values side by side, and it can be put back.
 */
export interface CommonSettingsConflict {
  /** The setting the node holds differently: `herder.env/KEY`. */
  id: string;
  /** The value of the common document. */
  commonValue: string | null;
  /** The value the node held before the document was applied. */
  localValue: string | null;
  /**
   * How the deviation was found.
   *
   * `adopted` — the node had no common document before, so the value it held
   * was replaced by the common one. `local-change` — the node was changed
   * locally after the last document was applied, so a person changed it.
   */
  kind: "adopted" | "local-change";
  /** When the deviation was found. */
  detectedAt: string;
  /**
   * Whether the deviation is in force on the node.
   *
   * A deviation that was put back or that the common value caught up with is
   * closed: it stays in the history, and it is not a conflict of the node.
   */
  open?: boolean;
  /** The policy of the launch is not a string: it is named apart. */
  policyChanged?: boolean;
  /** The policy the node held before the document was applied. */
  localPolicy?: unknown;
  /** The policy of the common document. */
  commonPolicy?: unknown;
  /** The lever of the hooks is not a string either: it is named apart. */
  hooksChanged?: boolean;
  /** The position of the lever of the hooks on the node before the document was applied. */
  localHooksState?: { prohibitionsEnabled: boolean; disabledHooks: string[] } | null;
  /** The position of the lever of the hooks in the common document. */
  commonHooksState?: { prohibitionsEnabled: boolean; disabledHooks: string[] };
  /** A note about the deviation, in the words of the owner. */
  note?: string;
  /** When the local value was put back. */
  restoredAt?: string;
}

/** The state of the common settings on one node. */
export interface CommonSettingsNodeState {
  /** Whether the node takes the common settings of the owner. */
  optIn: boolean;
  /** The role of the node in the contour of the common settings. */
  role: CommonSettingsRole;
  /** The revision the node holds. */
  appliedRevision: string | null;
  /** When the node applied that revision. */
  appliedAt: string | null;
  /** The document the node holds. */
  document: CommonSettingsDocument | null;
  /** The deviations the node replaced, with both values. */
  conflicts: CommonSettingsConflict[];
  /** The values that were there before, so the local one can be put back. */
  rollback: Record<string, string | null>;
}

/** The state of a node that never took the common settings. */
export function emptyCommonSettingsState(role: CommonSettingsRole = "none"): CommonSettingsNodeState {
  return {
    optIn: false,
    role,
    appliedRevision: null,
    appliedAt: null,
    document: null,
    conflicts: [],
    rollback: {},
  };
}

/** The state of the node, as the owner reads it over the fleet. */
export interface CommonSettingsNodeStatus {
  /** The node that answered. */
  hostId: string;
  /** The role of the node in the contour. */
  role: CommonSettingsRole;
  /** Whether the node takes the common settings. */
  optIn: boolean;
  /** The revision the node holds. */
  appliedRevision: string | null;
  /** When the node applied that revision. */
  appliedAt: string | null;
  /** The deviations the node replaced. */
  conflicts: CommonSettingsConflict[];
}

/**
 * The durable state of the common settings of this node.
 *
 * The file is written whole and replaced by a rename, so a broken write never
 * leaves a half-written state behind.
 */
export class CommonSettingsStateStore {
  private readonly path: string;
  private readonly now: () => Date;

  constructor(options: { path?: string; now?: () => Date } = {}) {
    this.path = options.path ?? COMMON_SETTINGS_STATE_FILE;
    this.now = options.now ?? (() => new Date());
  }

  /** The path of the file of the state. */
  get statePath(): string {
    return this.path;
  }

  /**
   * The state of this node.
   *
   * A state that cannot be read is the state of a node that never took the
   * common settings: nothing is claimed about a node whose state is unknown.
   */
  async read(): Promise<CommonSettingsNodeState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyCommonSettingsState();
      const raw = parsed as Record<string, unknown>;
      const role = raw.role === "owner" || raw.role === "member" ? raw.role : "none";
      const conflicts = Array.isArray(raw.conflicts)
        ? raw.conflicts.filter((item): item is CommonSettingsConflict => {
          if (!item || typeof item !== "object") return false;
          const conflict = item as Record<string, unknown>;
          return typeof conflict.id === "string"
            && (conflict.commonValue === null || typeof conflict.commonValue === "string")
            && (conflict.localValue === null || typeof conflict.localValue === "string")
            && (conflict.kind === "adopted" || conflict.kind === "local-change")
            && typeof conflict.detectedAt === "string";
        })
        : [];
      const rollback: Record<string, string | null> = {};
      if (raw.rollback && typeof raw.rollback === "object" && !Array.isArray(raw.rollback)) {
        for (const [key, value] of Object.entries(raw.rollback as Record<string, unknown>)) {
          if (value === null || typeof value === "string") rollback[key] = value;
        }
      }
      return {
        optIn: raw.optIn === true,
        role,
        appliedRevision: typeof raw.appliedRevision === "string" ? raw.appliedRevision : null,
        appliedAt: typeof raw.appliedAt === "string" ? raw.appliedAt : null,
        document: (raw.document ?? null) as CommonSettingsDocument | null,
        conflicts,
        rollback,
      };
    } catch {
      return emptyCommonSettingsState();
    }
  }

  /** The state of this node, written whole. */
  async write(state: CommonSettingsNodeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  /** The opt-in flag of this node, set by the owner of this node. */
  async setOptIn(enabled: boolean): Promise<CommonSettingsNodeState> {
    const state = await this.read();
    state.optIn = enabled;
    await this.write(state);
    return state;
  }

  /** The time of the last write of the state. */
  get clock(): () => Date {
    return this.now;
  }
}
