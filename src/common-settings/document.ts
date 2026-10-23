/**
 * The document of the common settings of the herder.
 *
 * The document is the one thing that travels between the nodes of the fleet.
 * It holds the common settings of the product — the values that mean the same
 * thing on every node — and nothing else: a machine setting never enters it.
 *
 * The revision of the document is derived from its content alone. Every node
 * that holds the document computes the same revision from the same content, so
 * two nodes agree without talking to each other: the owner compares the
 * revision it wants with the revision a node names.
 */

import { createHash } from "node:crypto";

import { settingsFingerprint } from "../web/settings-store.js";
import {
  assertNoMachineSettings,
  commonEnvironmentKeys,
  isSecretSettingId,
  scopeOfSettingId,
} from "./scope.js";

/** The format of the document: a version of the shape, not of the values. */
export const COMMON_SETTINGS_FORMAT = "common-settings/v1";

/**
 * The state of the lever of the prohibitions of the hooks, as it travels.
 *
 * Only the state of the lever travels: who moved it and when belong to the
 * journal of the node that moved it, and a journal is never copied to another
 * node. The lever of the hooks is a common setting of the herder: it means the
 * same thing on every node, so the owner moves it once and every node takes
 * the same position.
 */
export interface CommonSettingsHooksState {
  /** True forbids the hooks, false permits them to forbid nothing. */
  prohibitionsEnabled: boolean;
  /** The hooks whose own prohibitions are off. */
  disabledHooks: string[];
}

/*
 * The switch of the whole optional hooks runtime is deliberately not part of
 * the common document.
 *
 * The lever of the owner is a node-local decision: the fleet sync may carry
 * the position of the prohibitions, but it can never turn the optional hooks
 * runtime of a node back on. A node that has the hooks off keeps them off,
 * whatever the common document says.
 */

/**
 * The lever of the prohibitions of the hooks, as the common document needs it.
 *
 * The lever lives in the code of the hooks and is not rewritten here: the
 * common settings read it and write it through this interface, so the lever
 * keeps its own document, its own journal and its own rules.
 */
export interface CommonSettingsHooksLever {
  /** The state of the lever on this node, and whether it could be read. */
  read(): Promise<{ known: boolean; prohibitionsEnabled: boolean; disabledHooks: string[]; reason?: string }>;
  /** The write of the state of the lever on this node. */
  apply(state: CommonSettingsHooksState): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * The store of the lever of the prohibitions of the hooks.
 *
 * The shape is the shape of the store of the hooks, and it is written out here
 * so the common settings do not depend on the code of the hooks: the store of
 * the hooks is passed as it is, and nothing of `src/hooks` is rewritten.
 */
export interface HooksProhibitionsStoreLike {
  /** The state of the lever and whether it could be read. */
  readState(): Promise<{
    state: { prohibitionsEnabled: boolean; disabledHooks: string[] };
    known: boolean;
    reason?: string;
  }>;
  /** The write of the lever by an explicit action of the owner. */
  apply(change: {
    source: "owner";
    actor?: string;
    prohibitionsEnabled?: boolean;
    disabledHooks?: string[];
    reason?: string;
  }): Promise<{ ok: boolean; reason?: string; changed?: boolean }>;
}

/**
 * The lever of the hooks, as the common document needs it.
 *
 * The store of the hooks keeps its own journal and its own rules; the common
 * document only carries the position of the lever.
 */
export function hooksLeverFromStore(store: HooksProhibitionsStoreLike): CommonSettingsHooksLever {
  return {
    read: async () => {
      const state = await store.readState();
      return {
        known: state.known,
        prohibitionsEnabled: state.state.prohibitionsEnabled,
        disabledHooks: [...state.state.disabledHooks].sort(),
        ...(state.reason ? { reason: state.reason } : {}),
      };
    },
    apply: async (state) => {
      const result = await store.apply({
        source: "owner",
        actor: "common-settings",
        prohibitionsEnabled: state.prohibitionsEnabled,
        disabledHooks: [...state.disabledHooks].sort(),
        reason: "Общие настройки флота: рычаг запретов хуков приведён к общему значению.",
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "Нода не приняла положение рычака." };
    },
  };
}

/**
 * The document of the common settings.
 *
 * `environment` holds every common key of the environment file of the product.
 * A key whose value is `null` is not set on the owner, and the node that
 * applies the document removes it: the owner and the node hold the same
 * settings, and a setting the owner cleared is cleared everywhere.
 */
export interface CommonSettingsDocument {
  /** The shape of the document. */
  format: typeof COMMON_SETTINGS_FORMAT;
  /** The revision of the content: the same content has the same revision everywhere. */
  revision: string;
  /** The node that owns the document: the source of truth. */
  owner: string;
  /** When the owner built the document. */
  createdAt: string;
  /** The common values of the environment of the product. */
  environment: Record<string, string | null>;
  /** The policy of the launch, when the owner has one. */
  launchPolicy?: unknown;
  /** The position of the lever of the prohibitions of the hooks. */
  hooks?: CommonSettingsHooksState;
}

/** The refusal of a document that is not the document. */
export class CommonSettingsDocumentError extends Error {
  readonly code = "COMMON_SETTINGS_DOCUMENT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CommonSettingsDocumentError";
  }
}

/**
 * The canonical form of a value: the keys of every object are sorted.
 *
 * Two nodes that hold the same values must compute the same revision, and the
 * order of the keys of an object is not a value. The canonical form removes
 * that difference.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * The revision of the content of the document.
 *
 * The revision is the identity of the content: the same values have the same
 * revision on every node, and a changed value has another revision.
 */
export function commonSettingsRevision(input: { environment: Record<string, string | null>; launchPolicy?: unknown; hooks?: CommonSettingsHooksState }): string {
  const content = canonicalJson({
    environment: input.environment,
    launchPolicy: input.launchPolicy ?? null,
    hooks: input.hooks ?? null,
  });
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
}

/**
 * The document of the owner.
 *
 * Only the common settings enter the document: a machine setting of the
 * environment file is dropped here, and the configuration of the node never
 * enters it at all.
 */
export function buildCommonDocument(input: {
  owner: string;
  createdAt?: string;
  /** The raw values of the environment file of the owner. */
  environment?: Record<string, string | null | undefined>;
  /** The policy of the launch of the owner. */
  launchPolicy?: unknown;
  /** The position of the lever of the prohibitions of the hooks. */
  hooks?: CommonSettingsHooksState;
}): CommonSettingsDocument {
  const environment: Record<string, string | null> = {};
  for (const key of commonEnvironmentKeys()) {
    const value = input.environment?.[key];
    environment[key] = value === undefined ? null : value;
  }
  const revision = commonSettingsRevision({
    environment,
    ...(input.launchPolicy !== undefined ? { launchPolicy: input.launchPolicy } : {}),
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
  });
  const document: CommonSettingsDocument = {
    format: COMMON_SETTINGS_FORMAT,
    revision,
    owner: input.owner,
    createdAt: input.createdAt ?? new Date().toISOString(),
    environment,
  };
  if (input.launchPolicy !== undefined) document.launchPolicy = input.launchPolicy;
  if (input.hooks !== undefined) document.hooks = input.hooks;
  assertNoMachineSettings(document);
  return document;
}

/**
 * The document of the owner, read from the files of the owner.
 *
 * The values of the secrets are read from the file of the product: a secret
 * has to travel to the node, otherwise the nodes would hold different
 * settings. The value never appears in an answer of the panel — only the fact
 * that it is set and its fingerprint.
 */
export async function readOwnerDocument(input: {
  owner: string;
  /** The store of the settings of this node. */
  store: {
    readEnvironment(): Promise<{ values: Record<string, { present: boolean; value?: string }> }>;
    readSecretValue?(key: string): Promise<string | undefined>;
  };
  /** The policy of the launch of the owner, when it has one. */
  launchPolicy?: { read(): Promise<{ kind: "valid" | "absent" | "invalid"; policy?: unknown }> };
  /** The lever of the prohibitions of the hooks, when the node has one. */
  hooks?: CommonSettingsHooksLever;
  now?: () => Date;
}): Promise<CommonSettingsDocument> {
  const environment = await input.store.readEnvironment();
  const values: Record<string, string | null> = {};
  for (const key of commonEnvironmentKeys()) {
    const id = `herder.env/${key}`;
    if (isSecretSettingId(id)) {
      const secret = await input.store.readSecretValue?.(key);
      values[key] = secret ?? null;
      continue;
    }
    const view = environment.values[key];
    values[key] = view?.present ? (view.value ?? null) : null;
  }
  let launchPolicy: unknown;
  if (input.launchPolicy) {
    const policy = await input.launchPolicy.read();
    if (policy.kind === "valid") launchPolicy = policy.policy;
  }
  let hooks: CommonSettingsHooksState | undefined;
  if (input.hooks) {
    // The lever of the hooks is part of the common document: the position of
    // the lever travels, its journal stays on the node that moved it.
    const lever = await input.hooks.read();
    if (lever.known) hooks = { prohibitionsEnabled: lever.prohibitionsEnabled, disabledHooks: [...lever.disabledHooks].sort() };
  }
  return buildCommonDocument({
    owner: input.owner,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    environment: values,
    ...(launchPolicy !== undefined ? { launchPolicy } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

/**
 * The document as the owner reads it.
 *
 * A secret is never shown: the answer names the fact that it is set and its
 * fingerprint. The value of a secret leaves the node only inside the document
 * that travels between the nodes.
 */
export interface CommonSettingsDocumentView {
  format: typeof COMMON_SETTINGS_FORMAT;
  revision: string;
  owner: string;
  createdAt: string;
  environment: Record<string, { value: string | null; secret: boolean; fingerprint?: string }>;
  launchPolicy?: unknown;
  hooks?: CommonSettingsHooksState;
}

/** The document as the owner reads it, with the secrets closed. */
export function redactCommonDocument(document: CommonSettingsDocument): CommonSettingsDocumentView {
  const environment: Record<string, { value: string | null; secret: boolean; fingerprint?: string }> = {};
  for (const [key, value] of Object.entries(document.environment)) {
    const id = `herder.env/${key}`;
    if (!isSecretSettingId(id)) {
      environment[key] = { value, secret: false };
      continue;
    }
    environment[key] = value === null
      ? { value: null, secret: true }
      : { value: null, secret: true, fingerprint: settingsFingerprint(value) };
  }
  return {
    format: document.format,
    revision: document.revision,
    owner: document.owner,
    createdAt: document.createdAt,
    environment,
    ...(document.launchPolicy !== undefined ? { launchPolicy: document.launchPolicy } : {}),
    ...(document.hooks !== undefined ? { hooks: document.hooks } : {}),
  };
}

/**
 * The document as it arrived from another node.
 *
 * A document that does not hold its own revision is refused: a document that
 * was changed on the way would carry a revision that does not describe it.
 */
export function parseCommonSettingsDocument(value: unknown): CommonSettingsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommonSettingsDocumentError("Общий документ настроек не прочитан: это не объект.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.format !== COMMON_SETTINGS_FORMAT) {
    throw new CommonSettingsDocumentError(`Общий документ настроек имеет неизвестный формат: ${String(raw.format)}.`);
  }
  if (typeof raw.owner !== "string" || !raw.owner) {
    throw new CommonSettingsDocumentError("Общий документ настроек не называет узел-владелец.");
  }
  if (typeof raw.createdAt !== "string" || !raw.createdAt) {
    throw new CommonSettingsDocumentError("Общий документ настроек не называет время сборки.");
  }
  if (!raw.environment || typeof raw.environment !== "object" || Array.isArray(raw.environment)) {
    throw new CommonSettingsDocumentError("Общий документ настроек не содержит значений окружения.");
  }
  const environment: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(raw.environment as Record<string, unknown>)) {
    if (item !== null && typeof item !== "string") {
      throw new CommonSettingsDocumentError(`Общий документ настроек: значение ${key} не строка и не отсутствие.`);
    }
    if (scopeOfSettingId(`herder.env/${key}`) !== "common") {
      throw new CommonSettingsDocumentError(`Машинная настройка herder.env/${key} не входит в общий документ настроек.`);
    }
    environment[key] = item as string | null;
  }
  const launchPolicy = raw.launchPolicy;
  let hooks: CommonSettingsHooksState | undefined;
  if (raw.hooks !== undefined && raw.hooks !== null) {
    if (typeof raw.hooks !== "object" || Array.isArray(raw.hooks)) {
      throw new CommonSettingsDocumentError("Рычаг запретов хуков в общем документе должен быть объектом.");
    }
    const lever = raw.hooks as Record<string, unknown>;
    if (typeof lever.prohibitionsEnabled !== "boolean") {
      throw new CommonSettingsDocumentError("Рычаг запретов хуков в общем документе должен называть положение рычага.");
    }
    const disabled = lever.disabledHooks === undefined ? [] : lever.disabledHooks;
    if (!Array.isArray(disabled) || disabled.some((kind) => typeof kind !== "string")) {
      throw new CommonSettingsDocumentError("Рычаг запретов хуков в общем документе должен называть список хуков строками.");
    }
    hooks = { prohibitionsEnabled: lever.prohibitionsEnabled, disabledHooks: [...(disabled as string[])].sort() };
  }
  const revision = commonSettingsRevision({
    environment,
    ...(launchPolicy !== undefined ? { launchPolicy } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });
  if (typeof raw.revision !== "string" || raw.revision !== revision) {
    throw new CommonSettingsDocumentError(
      `Общий документ настроек не соответствует своей ревизии (${String(raw.revision)} вместо ${revision}).`,
    );
  }
  const document: CommonSettingsDocument = {
    format: COMMON_SETTINGS_FORMAT,
    revision,
    owner: raw.owner,
    createdAt: raw.createdAt,
    environment,
  };
  if (launchPolicy !== undefined) document.launchPolicy = launchPolicy;
  if (hooks !== undefined) document.hooks = hooks;
  assertNoMachineSettings(document);
  return document;
}
