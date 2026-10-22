/**
 * The catalog of the settings of the herder.
 *
 * Every setting of the product is described once: its human name, what it
 * does, the scope it lives in, the value it has when the owner never touched
 * it, and how a change of it reaches the running product. The description
 * lives here and only here, so a line of the model is not edited in three
 * places: the API, the form and the journal all read it from here.
 */

/** The scope a setting lives in. */
export type SettingsScopeKind = "mesh" | "project" | "node" | "user";

/** The scope of a setting, with the place it lives in. */
export interface SettingsScope {
  kind: SettingsScopeKind;
  path?: string;
}

/** Where the value of a setting comes from. */
export type SettingsSource = "default" | "inherited" | "override";

/**
 * When a change of a setting reaches the running product.
 *
 * The names are the names of the contract: сразу, к новым задачам, после
 * перезапуска.
 */
export type SettingsApplyMode = "сразу" | "к новым задачам" | "после перезапуска";

/**
 * What the running product did with the change.
 *
 * The names are the names of the contract: «Записано», «Применяется»,
 * «Применено», «Применено частично», «Ошибка».
 */
export type SettingsApplyState = "Записано" | "Применяется" | "Применено" | "Применено частично" | "Ошибка";

/** One described setting of the product. */
export interface SettingsCatalogEntry {
  /** The stable id of the setting: the entity and the key. */
  id: string;
  /** The human name of the setting: what the owner reads in the form. */
  humanName: string;
  /** What the setting does, in one line. */
  action: string;
  /** The scope the setting lives in. */
  scope: SettingsScope;
  /** The value the setting has when the owner never touched it. */
  defaultValue?: string;
  /** A secret is never returned: only the fact that it is set and its fingerprint. */
  secret?: boolean;
  /** When a change of the setting reaches the running product. */
  applyMode: SettingsApplyMode;
  /** The places of the herder that use this setting. */
  consumers?: string[];
  /**
   * The product that owns the setting.
   *
   * One setting — one owner. A setting of another product never lives here:
   * the panel shows the link to its owner instead of a second field.
   */
  owner: "agent-herder" | "notice-place" | "omniroute" | "gptadmin";
  /**
   * The setting of another product that this setting refers to.
   *
   * The panel shows the link «Открыть в <продукт>» and never a second field
   * with a competing value.
   */
  refersTo?: { product: string; label: string; href?: string };
}

/** The known settings of the environment of the herder product. */
export const HERDER_ENV_CATALOG: readonly SettingsCatalogEntry[] = [
  {
    id: "herder.env/NOTIFY_CENTER_EVENT_URL",
    humanName: "Подключение к центру уведомлений: адрес",
    action: "Куда herder отправляет события о своей работе.",
    scope: { kind: "node" },
    defaultValue: "http://127.0.0.1:8091/v1/events",
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Отправитель уведомлений herder", "Дозор незавершённых сессий"],
  },
  {
    id: "herder.env/NOTIFY_CENTER_PROJECT",
    humanName: "Подключение к центру уведомлений: проект",
    action: "Имя проекта, от имени которого центр получает события herder.",
    scope: { kind: "node" },
    defaultValue: "agent-herder",
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Отправитель уведомлений herder", "Дозор незавершённых сессий"],
  },
  {
    id: "herder.env/NOTIFY_CENTER_RECIPIENT",
    humanName: "Подключение к центру уведомлений: получатель",
    action: "Кому центр доставляет уведомления herder.",
    scope: { kind: "node" },
    defaultValue: "me",
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Отправитель уведомлений herder", "Дозор незавершённых сессий"],
  },
  {
    id: "herder.env/NOTIFY_CENTER_TOKEN",
    humanName: "Подключение к центру уведомлений: ключ",
    action: "Ключ, которым herder подписывает события для центра уведомлений.",
    scope: { kind: "node" },
    secret: true,
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Отправитель уведомлений herder", "Дозор незавершённых сессий"],
  },
  {
    id: "herder.env/NOTICEPLACE_HEALTH_LAUNCH_TOKEN",
    humanName: "Подключение к центру уведомлений: ключ health-контура",
    action: "Ключ, которым herder запускает health-контур центра уведомлений.",
    scope: { kind: "node" },
    secret: true,
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Запуск health-контура"],
  },
];

/** The known settings of the configuration of the node. */
export const NODE_CONFIG_CATALOG: readonly SettingsCatalogEntry[] = [
  {
    id: "node-config/hostId",
    humanName: "Имя узла во флоте",
    action: "Имя, под которым узел известен во флоте. Развёртывание владеет им.",
    scope: { kind: "node" },
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Регистрация узла во флоте"],
  },
  {
    id: "node-config/sourceSha",
    humanName: "Отпечаток источника узла",
    action: "Коммит, из которого собран узел. Развёртывание владеет им.",
    scope: { kind: "node" },
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Регистрация узла во флоте"],
  },
  {
    id: "node-config/harnesses",
    humanName: "Среды исполнения узла",
    action: "Среды, которыми этот узел действительно владеет.",
    scope: { kind: "node" },
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Панель herder", "Кабинет флота"],
  },
  {
    id: "node-config/webPort",
    humanName: "Порт панели узла",
    action: "Порт, на котором панель этого узла слушает запросы.",
    scope: { kind: "node" },
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Панель herder"],
  },
];

/** A named profile of the AI: a reusable entity of the mesh. */
export interface SettingsProfile {
  /** The stable id of the profile: the launch policy refers to it by this id. */
  id: string;
  /** The human name of the profile. */
  humanName: string;
  /** What the profile is for, in one line. */
  action: string;
  /** The scope of the profile: a profile of the mesh is reused by many projects. */
  scope: SettingsScope;
  /** The environment the profile runs in. */
  harness: string;
  /** The model of the profile. */
  model?: string;
  /** The models the profile falls back to. */
  fallbackModels?: string[];
  /** The tools the profile is allowed to use. */
  allowedTools?: string[];
  /** The limits of the profile. */
  limits?: Record<string, unknown>;
}

/** The profiles of the mesh that already exist. */
export const DEFAULT_PROFILES: readonly SettingsProfile[] = [
  {
    id: "profile/codex",
    humanName: "Профиль Codex",
    action: "Среда codex с моделью по умолчанию.",
    scope: { kind: "mesh" },
    harness: "codex",
    model: "gpt-5.6-sol",
  },
  {
    id: "profile/opencode",
    humanName: "Профиль OpenCode",
    action: "Среда opencode через комбо-модель.",
    scope: { kind: "mesh" },
    harness: "opencode",
    model: "omniroute/minimax-combo-m3.1",
  },
];

/** The catalog of the whole product, by the entity of the setting. */
export function catalogFor(entity: "herder.env" | "node-config"): readonly SettingsCatalogEntry[] {
  return entity === "herder.env" ? HERDER_ENV_CATALOG : NODE_CONFIG_CATALOG;
}

/** The described setting with this id, when the catalog knows it. */
export function catalogEntry(id: string): SettingsCatalogEntry | undefined {
  return [...HERDER_ENV_CATALOG, ...NODE_CONFIG_CATALOG].find((entry) => entry.id === id);
}
