/**
 * The scope of a setting of the herder: common or machine.
 *
 * One place decides which setting travels to the other nodes of the fleet and
 * which one belongs to the machine it runs on. A common setting means the same
 * thing on every node, so the owner changes it once and every node takes it. A
 * machine setting belongs to the machine: a path, a port, a binary, the
 * identity of the node — it is correct only for the machine it lives on and it
 * never travels.
 *
 * The list is written out and not derived: a setting that is not named here is
 * never propagated. A new setting travels only when a person says so.
 */

import { HERDER_ENV_CATALOG, NODE_CONFIG_CATALOG } from "../web/settings-catalog.js";

/** The scope of a setting: it travels to the fleet or it belongs to the machine. */
export type CommonSettingScope = "common" | "machine";

/** One described setting and the side of the line it lives on. */
export interface CommonSettingScopeEntry {
  /** The id of the setting: `herder.env/KEY` or `node-config/key`. */
  id: string;
  /** Which side of the line the setting lives on. */
  scope: CommonSettingScope;
  /** Why the setting is common or machine, in one line. */
  reason: string;
  /** A secret is never shown: only the fact that it is set and its fingerprint. */
  secret?: boolean;
}

/**
 * The common settings of the herder.
 *
 * Every one of them means the same thing on every node of the fleet: the
 * owner changes one and the change reaches every node that takes the common
 * settings.
 */
export const COMMON_SETTINGS_SCOPE: readonly CommonSettingScopeEntry[] = [
  {
    id: "herder.env/NOTIFY_CENTER_EVENT_URL",
    scope: "common",
    reason: "Адрес центра уведомлений: центр один на весь контур.",
  },
  {
    id: "herder.env/NOTIFY_CENTER_PROJECT",
    scope: "common",
    reason: "Имя проекта herder в центре уведомлений.",
  },
  {
    id: "herder.env/NOTIFY_CENTER_RECIPIENT",
    scope: "common",
    reason: "Получатель уведомлений herder.",
  },
  {
    id: "herder.env/NOTIFY_CENTER_TOKEN",
    scope: "common",
    reason: "Учётная запись herder в центре уведомлений: она одна на весь контур.",
    secret: true,
  },
  {
    id: "herder.env/NOTICEPLACE_HEALTH_LAUNCH_TOKEN",
    scope: "common",
    reason: "Учётная запись herder в health-контуре центра уведомлений.",
    secret: true,
  },
  {
    id: "herder.env/AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT",
    scope: "common",
    reason: "Глубина размышления дозора: предпочтение владельца, а не свойство машины.",
  },
  {
    id: "herder.env/AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD",
    scope: "common",
    reason: "Удержание ожидания на старте: предпочтение владельца.",
  },
];

/**
 * The machine settings: they belong to the machine and never travel.
 *
 * A path, a port, a binary, a socket and the identity of the node are
 * correct only for the machine they live on. Copying one of them to another
 * node makes that node wrong, so the common document never holds them.
 */
export const MACHINE_SETTINGS_SCOPE: readonly CommonSettingScopeEntry[] = [
  {
    id: "herder.env/AGENT_HERDER_BROWSER_WORKER_PORT",
    scope: "machine",
    reason: "Порт воркера браузера: это порт машины.",
  },
  {
    id: "node-config/hostId",
    scope: "machine",
    reason: "Имя узла во флоте: развёртывание владеет им.",
  },
  {
    id: "node-config/sourceSha",
    scope: "machine",
    reason: "Отпечаток источника узла: сборка машины.",
  },
  {
    id: "node-config/harnesses",
    scope: "machine",
    reason: "Среды исполнения, которыми владеет эта машина.",
  },
  {
    id: "node-config/webPort",
    scope: "machine",
    reason: "Порт панели узла: это порт машины.",
  },
  {
    id: "node-config/nodeBin",
    scope: "machine",
    reason: "Путь к исполняемому файлу узла: это путь машины.",
  },
  {
    id: "node-config/codexSocket",
    scope: "machine",
    reason: "Сокет codex: это путь машины.",
  },
  {
    id: "node-config/codexBin",
    scope: "machine",
    reason: "Путь к codex: это путь машины.",
  },
  {
    id: "node-config/catalogs",
    scope: "machine",
    reason: "Каталоги, которые читает эта машина: это пути машины.",
  },
  {
    id: "node-config/stateDir",
    scope: "machine",
    reason: "Каталог состояния: это путь машины.",
  },
  {
    id: "node-config/fleetDir",
    scope: "machine",
    reason: "Каталог флота: это путь машины.",
  },
];

/** Every setting of the catalog of the product, with the side it lives on. */
const ALL_SCOPE_ENTRIES: readonly CommonSettingScopeEntry[] = [
  ...COMMON_SETTINGS_SCOPE,
  ...MACHINE_SETTINGS_SCOPE,
];

/**
 * The scope of a setting.
 *
 * A setting that is not named in the list is a machine setting: an unnamed
 * setting never travels. The rule is the rule of the owner — nothing is
 * copied to another node without a person naming it first.
 */
export function scopeOfSettingId(id: string): CommonSettingScope {
  return COMMON_SETTINGS_SCOPE.some((entry) => entry.id === id) ? "common" : "machine";
}

/** Whether the setting travels to the other nodes of the fleet. */
export function isCommonSettingId(id: string): boolean {
  return scopeOfSettingId(id) === "common";
}

/** Whether the setting holds a secret: its value is never shown. */
export function isSecretSettingId(id: string): boolean {
  return ALL_SCOPE_ENTRIES.find((entry) => entry.id === id)?.secret === true;
}

/**
 * Whether the setting holds a secret, by the classification of the setting.
 *
 * The classification is a property of the setting and not of the name of the
 * field that carries its value: a secret is closed wherever its value is shown,
 * and a setting that is not a secret keeps its value everywhere.
 *
 * The list of the scope decides it, and the catalog of the product is the second
 * voice: a setting that the catalog calls a secret is a secret even when the
 * list of the scope has not named it yet.
 */
export function holdsSecretSetting(id: string): boolean {
  if (isSecretSettingId(id)) return true;
  return HERDER_ENV_CATALOG.find((entry) => entry.id === id)?.secret === true;
}

/**
 * What the setting is for, in one line.
 *
 * The purpose of a setting is shown next to the fact that it holds a secret:
 * the owner sees what the secret is for and never what it is.
 */
export function purposeOfSettingId(id: string): string | null {
  return ALL_SCOPE_ENTRIES.find((entry) => entry.id === id)?.reason ?? null;
}

/** The common keys of the environment file of the product. */
export function commonEnvironmentKeys(): string[] {
  return COMMON_SETTINGS_SCOPE
    .filter((entry) => entry.id.startsWith("herder.env/"))
    .map((entry) => entry.id.slice("herder.env/".length));
}

/** The ids of the settings that never travel to another node. */
export function machineSettingIds(): string[] {
  return ALL_SCOPE_ENTRIES.filter((entry) => entry.scope === "machine").map((entry) => entry.id);
}

/**
 * The refusal of a setting that has no place in the common document.
 *
 * The common document is built from the common settings only, so a machine
 * setting never lands in it. This check is the second line of that rule: a
 * document that carries a machine setting is refused, not silently trimmed.
 */
export class CommonSettingsMachineFieldError extends Error {
  readonly code = "COMMON_SETTINGS_MACHINE_FIELD";

  constructor(readonly field: string) {
    super(`Машинная настройка ${field} не входит в общий документ настроек.`);
    this.name = "CommonSettingsMachineFieldError";
  }
}

/**
 * The machine settings that a document carries.
 *
 * The document names its settings by their id, so the check is exact: a
 * setting that the list calls machine is refused even when it is empty.
 */
export function machineFieldsOfDocument(document: { environment?: Record<string, unknown> }): string[] {
  const fields: string[] = [];
  for (const key of Object.keys(document.environment ?? {})) {
    const id = `herder.env/${key}`;
    if (scopeOfSettingId(id) === "machine") fields.push(id);
  }
  return fields;
}

/**
 * The check of a document: a machine setting never travels.
 *
 * The document is refused, not trimmed: a caller that builds a document with a
 * machine setting has a mistake, and a trimmed document would hide it.
 */
export function assertNoMachineSettings(document: { environment?: Record<string, unknown> }): void {
  const fields = machineFieldsOfDocument(document);
  if (fields.length > 0) throw new CommonSettingsMachineFieldError(fields[0]);
}

/**
 * Every setting of the catalog is placed on one side of the line.
 *
 * A setting of the catalog that is not classified would silently never
 * travel, so the list is checked against the catalog of the product: a new
 * setting of the catalog forces a decision here.
 */
export function unclassifiedCatalogSettings(): string[] {
  const classified = new Set(ALL_SCOPE_ENTRIES.map((entry) => entry.id));
  const ids = [...HERDER_ENV_CATALOG, ...NODE_CONFIG_CATALOG].map((entry) => entry.id);
  return ids.filter((id) => !classified.has(id));
}
