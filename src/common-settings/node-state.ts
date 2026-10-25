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

import { SecretStore, settingsFingerprint, isSecretMarker } from "../web/settings-store.js";
import type { CommonSettingsDocument } from "./document.js";
import { holdsSecretSetting, purposeOfSettingId } from "./scope.js";

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
  /** The fingerprint of the value of the common document, when it is a secret. */
  commonFingerprint?: string;
  /** The fingerprint of the value the node held, when it is a secret. */
  localFingerprint?: string;
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

/**
 * A deviation of a node, as a reader of the fleet reads it.
 *
 * The value of a secret is never here: the deviation names the setting, says
 * that the setting holds a secret and gives its fingerprint. A setting that is
 * not a secret keeps both values, because there is nothing to hide.
 */
export interface CommonSettingsConflictView {
  /** The setting the node holds differently: `herder.env/KEY`. */
  id: string;
  /** The value of the common document. `null` for a secret. */
  commonValue: string | null;
  /** The value the node held before the document was applied. `null` for a secret. */
  localValue: string | null;
  /** Whether the value of the common document is a secret. */
  commonSecret?: boolean;
  /** The fingerprint of the secret of the common document. */
  commonFingerprint?: string;
  /** Whether the value the node held is a secret. */
  localSecret?: boolean;
  /** The fingerprint of the secret the node held. */
  localFingerprint?: string;
  /** What the setting is for. */
  purpose?: string;
  /** How the deviation was found. */
  kind: "adopted" | "local-change";
  /** When the deviation was found. */
  detectedAt: string;
  /** Whether the deviation is in force on the node. */
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

/**
 * One side of a deviation, as a reader of the fleet reads it.
 *
 * A secret is never shown: the side says that the setting holds a secret and
 * gives its fingerprint. A setting that is not a secret keeps its value.
 */
function redactConflictSide(
  id: string,
  value: string | null,
  fingerprint: string | undefined,
): { value: string | null; secret: boolean; fingerprint?: string } {
  if (!holdsSecretSetting(id)) return { value, secret: false };
  if (value === null) {
    return fingerprint ? { value: null, secret: true, fingerprint } : { value: null, secret: true };
  }
  return { value: null, secret: true, fingerprint: settingsFingerprint(value) };
}

/**
 * The deviations of a node, as a reader of the fleet reads them.
 *
 * The redaction is by the classification of the setting and never by the name of
 * the field: a field that carries the value of a secret is closed whatever it is
 * called, and a setting that is not a secret keeps its value.
 *
 * The redaction can be applied twice: a deviation that is already closed keeps
 * its fingerprint, because the value it hides is already gone.
 */
export function redactCommonSettingsConflicts(
  conflicts: readonly (CommonSettingsConflict | CommonSettingsConflictView)[],
): CommonSettingsConflictView[] {
  return conflicts.map((conflict) => {
    const view = conflict as CommonSettingsConflictView;
    const common = redactConflictSide(conflict.id, conflict.commonValue, view.commonFingerprint);
    const local = redactConflictSide(conflict.id, conflict.localValue, view.localFingerprint);
    const purpose = purposeOfSettingId(conflict.id);
    return {
      ...conflict,
      commonValue: common.value,
      localValue: local.value,
      ...(common.secret ? { commonSecret: true } : {}),
      ...(common.fingerprint ? { commonFingerprint: common.fingerprint } : {}),
      ...(local.secret ? { localSecret: true } : {}),
      ...(local.fingerprint ? { localFingerprint: local.fingerprint } : {}),
      ...(purpose ? { purpose } : {}),
    };
  });
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
  /** The deviations the node replaced, with the values of the secrets closed. */
  conflicts: CommonSettingsConflictView[];
}

/**
 * The state of the node as it is written to the disk.
 *
 * The file of the state is a file of the machine: the value of a secret never
 * goes into it. What goes into it is the marker of the secret — its
 * fingerprint — and the node puts the values back when it hands the document
 * on.
 */
function redactedState(state: CommonSettingsNodeState): CommonSettingsNodeState {
  return {
    ...state,
    document: state.document ? redactedDocument(state.document) : null,
    conflicts: state.conflicts.map(redactedConflict),
    rollback: redactedRollback(state.rollback),
  };
}

/** The document as it is written: the value of a secret is its marker. */
function redactedDocument(document: CommonSettingsDocument): CommonSettingsDocument {
  const environment: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(document.environment)) {
    const id = `herder.env/${key}`;
    if (!holdsSecretSetting(id) || value === null || isSecretMarker(value)) {
      environment[key] = value;
      continue;
    }
    environment[key] = settingsFingerprint(value);
  }
  return { ...document, environment };
}

/** The deviation as it is written: the value of a secret is its fingerprint. */
function redactedConflict(conflict: CommonSettingsConflict): CommonSettingsConflict {
  if (!holdsSecretSetting(conflict.id)) return conflict;
  return {
    ...conflict,
    commonValue: null,
    localValue: null,
    ...(conflict.commonValue !== null && conflict.commonValue !== undefined
      ? { commonFingerprint: settingsFingerprint(conflict.commonValue) }
      : {}),
    ...(conflict.localValue !== null && conflict.localValue !== undefined
      ? { localFingerprint: settingsFingerprint(conflict.localValue) }
      : {}),
  };
}

/** The values that were there before, as they are written: a secret is its marker. */
function redactedRollback(rollback: Record<string, string | null>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(rollback)) {
    if (value === null || !holdsSecretSetting(id)) {
      result[id] = value;
      continue;
    }
    result[id] = settingsFingerprint(value);
  }
  return result;
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
  private readonly secretStore?: SecretStore;

  constructor(options: { path?: string; now?: () => Date; secretStore?: SecretStore } = {}) {
    this.path = options.path ?? COMMON_SETTINGS_STATE_FILE;
    this.now = options.now ?? (() => new Date());
    this.secretStore = options.secretStore;
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
    let state: CommonSettingsNodeState;
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
      state = {
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
    // Do not swallow a failed secret-store write: callers must not proceed
    // with a state whose rollback value could be lost on the next write.
    await this.migrateLegacySecrets(state);
    return redactedState(state);
  }

  /**
   * Move values left in an older state file into the secret store before
   * replacing that file with its redacted form. Writing the secret store
   * first makes an interrupted migration safe to repeat.
   */
  private async migrateLegacySecrets(state: CommonSettingsNodeState): Promise<void> {
    const localValues = new Map<string, string>();
    for (const conflict of state.conflicts) {
      if (!holdsSecretSetting(conflict.id) || typeof conflict.localValue !== "string" || isSecretMarker(conflict.localValue)) continue;
      const key = conflict.id.startsWith("herder.env/") ? conflict.id.slice("herder.env/".length) : "";
      if (key) localValues.set(key, conflict.localValue);
    }
    for (const [id, value] of Object.entries(state.rollback)) {
      if (!holdsSecretSetting(id) || typeof value !== "string" || isSecretMarker(value)) continue;
      const key = id.startsWith("herder.env/") ? id.slice("herder.env/".length) : "";
      if (key && !localValues.has(key)) localValues.set(key, value);
    }

    if (localValues.size === 0) return;
    if (!this.secretStore) {
      throw new Error("Cannot migrate legacy common-settings secrets without the node SecretStore");
    }
    for (const [key, value] of localValues) {
      // Repeating this write is safe: the value comes from the same legacy
      // state until the redacted state replacement below succeeds.
      await this.secretStore.writeLocal(key, value);
    }
    await this.write(state);
  }

  /** The state of this node, written whole. */
  async write(state: CommonSettingsNodeState): Promise<void> {
    // The value of a secret never reaches the file of the state: the file
    // keeps the marker of the secret and never the value.
    const redacted = redactedState(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
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
