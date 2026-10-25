/**
 * The application of the common document on a node.
 *
 * The document is applied, not negotiated: the common value wins. The value
 * the node held is kept beside it, so a deviation stays visible with both
 * values and can be put back. The policy of the resolution is the same on
 * every node, because the same code applies it everywhere.
 *
 * A node that has no common document yet is not in conflict with the owner:
 * it adopts the common value and the value it held is kept as the first
 * deviation. A node whose value was changed by a person after the last
 * document was applied is in conflict, and the owner sees both values.
 */

import { canonicalJson, parseCommonSettingsDocument, type CommonSettingsDocument, type CommonSettingsHooksLever } from "./document.js";
import type { CommonSettingsConflict, CommonSettingsNodeState } from "./node-state.js";

/** The settings of the product of this node, as the application needs them. */
export interface CommonSettingsTarget {
  /** The values of the environment file of the product. */
  readEnvironment(): Promise<{ values: Record<string, { present: boolean; value?: string }> }>;
  /** The value of a secret of the environment file. */
  readSecretValue(key: string): Promise<string | undefined>;
  /** The write of the values of the environment file of the product. */
  applyEnvironment(changes: Record<string, string | null>): Promise<unknown>;
}

/** The policy of the launch of this node, as the application needs it. */
export interface CommonSettingsLaunchPolicyTarget {
  /** The policy the node holds now. */
  read(): Promise<{ kind: "valid" | "absent" | "invalid"; policy?: unknown; etag?: string; error?: string }>;
  /** The write of the whole policy of the node. */
  replace(value: unknown, options: { ifMatch?: string }): Promise<{ policy: unknown; etag: string }>;
}

/** The outcome of the application of a document on a node. */
export interface CommonSettingsApplyResult {
  /** Whether the document was applied. */
  ok: boolean;
  /** The node that applied the document. */
  hostId: string;
  /** The revision the node holds now. */
  appliedRevision: string | null;
  /** When the node applied it. */
  appliedAt: string | null;
  /** The settings the node changed. */
  changed: string[];
  /** The deviations the node found. */
  conflicts: CommonSettingsConflict[];
  /** The document the node holds now. */
  document?: CommonSettingsDocument;
  /** Why the document was not applied, when it was not. */
  reason?: string;
}

/** The id of the policy of the launch in the list of the deviations. */
const LAUNCH_POLICY_ID = "launch-policy";

/** The id of the lever of the prohibitions of the hooks in the list of the deviations. */
const HOOKS_PROHIBITIONS_ID = "hooks-prohibitions";

/**
 * The value of one key of the environment file of this node.
 *
 * A secret is read from the file of the product: the view of the settings
 * never carries its value, but the application has to know whether the node
 * holds the same secret as the owner.
 */
async function localValue(target: CommonSettingsTarget, key: string): Promise<string | null> {
  const secret = await target.readSecretValue(key);
  if (secret !== undefined) return secret;
  const environment = await target.readEnvironment();
  const view = environment.values[key];
  return view?.present ? (view.value ?? null) : null;
}

/**
 * The document applied on this node.
 *
 * Everything is checked before the first write: a document that does not hold
 * its own revision, or that carries a machine setting, never touches a file
 * of the node.
 */
export async function applyCommonSettingsDocument(input: {
  /** The document as it arrived from the owner. */
  document: unknown;
  /** The settings of this node. */
  target: CommonSettingsTarget;
  /** The policy of the launch of this node, when it has one. */
  launchPolicy?: CommonSettingsLaunchPolicyTarget;
  /** The lever of the prohibitions of the hooks of this node, when it has one. */
  hooks?: CommonSettingsHooksLever;
  /** The state of this node before the application. */
  state: CommonSettingsNodeState;
  /** The name of this node. */
  hostId: string;
  now?: () => Date;
}): Promise<CommonSettingsApplyResult> {
  const now = input.now ?? (() => new Date());
  let document: CommonSettingsDocument;
  try {
    document = parseCommonSettingsDocument(input.document);
  } catch (error) {
    return {
      ok: false,
      hostId: input.hostId,
      appliedRevision: input.state.appliedRevision,
      appliedAt: input.state.appliedAt,
      changed: [],
      conflicts: input.state.conflicts,
      reason: (error as Error).message,
    };
  }

  const previous = input.state.document;
  const changed: string[] = [];
  const conflicts: CommonSettingsConflict[] = [...input.state.conflicts];
  const rollback: Record<string, string | null> = { ...input.state.rollback };
  const detectedAt = now().toISOString();

  // The environment of the product: the common value wins, the value the node
  // held is kept beside it.
  const environmentChanges: Record<string, string | null> = {};
  for (const [key, commonValue] of Object.entries(document.environment)) {
    const id = `herder.env/${key}`;
    const local = await localValue(input.target, key);
    if (local === commonValue) {
      closeConflict(conflicts, id);
      continue;
    }
    const expected = previous ? (previous.environment[key] ?? null) : undefined;
    const kind = previous && expected !== undefined && local !== expected ? "local-change" : "adopted";
    conflicts.push({ id, commonValue, localValue: local, kind, detectedAt, open: true });
    rollback[id] = local;
    environmentChanges[key] = commonValue;
    changed.push(id);
  }

  // The policy of the launch: the same rule, the same value on every node.
  if (document.launchPolicy !== undefined && input.launchPolicy) {
    const current = await input.launchPolicy.read();
    const same = current.kind === "valid" && canonicalJson(current.policy) === canonicalJson(document.launchPolicy);
    if (same) {
      closeConflict(conflicts, LAUNCH_POLICY_ID);
    } else {
      const kind = previous?.launchPolicy !== undefined && current.kind === "valid"
        && canonicalJson(previous.launchPolicy) !== canonicalJson(current.policy)
        ? "local-change"
        : "adopted";
      conflicts.push({
        id: LAUNCH_POLICY_ID,
        commonValue: null,
        localValue: null,
        kind,
        detectedAt,
        open: true,
        policyChanged: true,
        localPolicy: current.kind === "valid" ? (current.policy ?? null) : null,
        commonPolicy: document.launchPolicy,
      });
      try {
        await input.launchPolicy.replace(document.launchPolicy, current.etag ? { ifMatch: current.etag } : {});
        changed.push(LAUNCH_POLICY_ID);
      } catch (error) {
        return {
          ok: false,
          hostId: input.hostId,
          appliedRevision: input.state.appliedRevision,
          appliedAt: input.state.appliedAt,
          changed: [],
          conflicts,
          reason: `Политика запуска на ноде не записана: ${(error as Error).message}`,
        };
      }
    }
  }

  if (Object.keys(environmentChanges).length > 0) {
    await input.target.applyEnvironment(environmentChanges);
  }

  // The lever of the prohibitions of the hooks: the same rule as the other
  // common settings. The lever of the hooks is not the lever of the automation:
  // the document carries the position of the hooks and never the state of the
  // automation, and the node that reads one never reads the other.
  if (document.hooks !== undefined && input.hooks) {
    const local = await input.hooks.read();
    const commonHooks = {
      prohibitionsEnabled: document.hooks.prohibitionsEnabled,
      disabledHooks: [...document.hooks.disabledHooks].sort(),
    };
    const same = local.known
      && local.prohibitionsEnabled === commonHooks.prohibitionsEnabled
      && canonicalJson([...local.disabledHooks].sort()) === canonicalJson(commonHooks.disabledHooks);
    if (same) {
      closeConflict(conflicts, HOOKS_PROHIBITIONS_ID);
    } else {
      const movedLocally = previous?.hooks !== undefined
        && local.known
        && (previous.hooks.prohibitionsEnabled !== local.prohibitionsEnabled
          || canonicalJson([...previous.hooks.disabledHooks].sort()) !== canonicalJson([...local.disabledHooks].sort()));
      conflicts.push({
        id: HOOKS_PROHIBITIONS_ID,
        commonValue: null,
        localValue: null,
        kind: movedLocally ? "local-change" : "adopted",
        detectedAt,
        open: true,
        hooksChanged: true,
        localHooksState: local.known
          ? { prohibitionsEnabled: local.prohibitionsEnabled, disabledHooks: [...local.disabledHooks].sort() }
          : null,
        commonHooksState: commonHooks,
        ...(local.known ? {} : { note: local.reason ? `Состояние рычага на ноде не прочитано: ${local.reason}` : "Состояние рычага на ноде не прочитано." }),
      });
      const written = await input.hooks.apply(commonHooks);
      if (!written.ok) {
        return {
          ok: false,
          hostId: input.hostId,
          appliedRevision: input.state.appliedRevision,
          appliedAt: input.state.appliedAt,
          changed: [],
          conflicts,
          reason: `Рычаг запретов хуков на ноде не записан: ${written.reason ?? "нода отклонила положение рычага."}`,
        };
      }
      changed.push(HOOKS_PROHIBITIONS_ID);
    }
  }

  return {
    ok: true,
    hostId: input.hostId,
    // The revision of the owner: the node keeps the identity of the document it
    // received and never a revision of its own files, so the owner sees that
    // the node took its document.
    appliedRevision: document.revision,
    appliedAt: detectedAt,
    changed,
    conflicts,
    document,
    reason: undefined,
  };
}

/**
 * A deviation that is not in force any more is closed, not forgotten.
 *
 * The history of the deviations stays visible, and the closed ones are not
 * shown as a conflict of the node.
 */
function closeConflict(conflicts: CommonSettingsConflict[], id: string): void {
  for (const conflict of conflicts) {
    if (conflict.id === id && conflict.open) conflict.open = false;
  }
}

/**
 * The local values put back on this node.
 *
 * The deviation that the common document replaced can be put back on the node
 * that held it: the values were kept when the document was applied. The
 * common value wins again at the next application — the policy is the same on
 * every node.
 */
export async function restoreCommonSettingsLocalValues(input: {
  target: CommonSettingsTarget;
  state: CommonSettingsNodeState;
  hostId: string;
  now?: () => Date;
}): Promise<CommonSettingsApplyResult> {
  const now = input.now ?? (() => new Date());
  const changes: Record<string, string | null> = {};
  for (const conflict of input.state.conflicts) {
    if (!conflict.open || !conflict.id.startsWith("herder.env/")) continue;
    changes[conflict.id.slice("herder.env/".length)] = conflict.localValue;
  }
  if (Object.keys(changes).length === 0) {
    return {
      ok: true,
      hostId: input.hostId,
      appliedRevision: input.state.appliedRevision,
      appliedAt: input.state.appliedAt,
      changed: [],
      conflicts: input.state.conflicts,
      reason: "На ноде нет открытых отклонений: возвращать нечего.",
    };
  }
  await input.target.applyEnvironment(changes);
  const conflicts = input.state.conflicts.map((conflict) => (
    conflict.open && conflict.id.startsWith("herder.env/")
      ? { ...conflict, open: false, restoredAt: now().toISOString() }
      : conflict
  ));
  return {
    ok: true,
    hostId: input.hostId,
    appliedRevision: input.state.appliedRevision,
    appliedAt: input.state.appliedAt,
    changed: Object.keys(changes).map((key) => `herder.env/${key}`),
    conflicts,
  };
}
