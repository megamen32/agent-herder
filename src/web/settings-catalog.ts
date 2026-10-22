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
 * «Применено», «Применено частично», «Узел недоступен».
 */
export type SettingsApplyState = "Записано" | "Применяется" | "Применено" | "Применено частично" | "Узел недоступен";

/**
 * The contract of the value of a setting: what the service accepts.
 *
 * The contract is the contract of the service: the store refuses exactly what
 * the parser of the service refuses, so a value on which the service refuses
 * to start is never written into the file of the product.
 *
 * The contract is declared once, here, and the store and the API read it from
 * here. A second place with the same list of values would be a second truth.
 */
export type SettingsValueContract =
  /**
   * One of the listed values.
   *
   * `compare` is the comparison of the service: `exact` compares the value as
   * it is, `trim-lower` compares it trimmed and lowercased. `empty` is what
   * the service does with an empty value: `allowed` means the service reads
   * it as the absence of the value, `refused` means the service throws on it.
   */
  | { kind: "enum"; values: readonly string[]; compare: "exact" | "trim-lower"; empty: "allowed" | "refused" }
  /**
   * A TCP port of the node.
   *
   * An empty value is accepted: the service reads it as the absence of the
   * value and falls back to its own port.
   */
  | { kind: "tcp-port"; min: number; max: number };

/**
 * A value that the service would refuse.
 *
 * The error carries the key of the setting and the message of the refusal.
 * The value itself is never in the message of a secret.
 */
export class SettingsValueNotAllowedError extends Error {
  readonly code = "SETTINGS_VALUE_NOT_ALLOWED";

  constructor(readonly key: string, message: string) {
    super(message);
    this.name = "SettingsValueNotAllowedError";
  }
}

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
  /**
   * The contract of the value of the setting: the values the service accepts.
   *
   * A setting without a contract is written as it is: the service does not
   * parse its value and does not refuse it.
   */
  valueContract?: SettingsValueContract;
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
  {
    id: "herder.env/AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT",
    humanName: "Дозор незавершённых сессий: глубина размышления",
    action: "Насколько глубоко дознаватель незавершённых сессий размышляет над решением.",
    scope: { kind: "node" },
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Дозор незавершённых сессий"],
    valueContract: { kind: "enum", values: ["low", "high", "max"], compare: "trim-lower", empty: "allowed" },
  },
  {
    id: "herder.env/AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD",
    humanName: "Возобновление после старта: удержание ожидания",
    action: "Удерживать ли ожидание возобновления сессий на старте сервиса.",
    scope: { kind: "node" },
    defaultValue: "disabled",
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Возобновление после старта"],
    valueContract: { kind: "enum", values: ["enabled", "disabled"], compare: "exact", empty: "refused" },
  },
  {
    id: "herder.env/AGENT_HERDER_BROWSER_WORKER_PORT",
    humanName: "Воркер браузера: порт",
    action: "Порт, на котором воркер браузера принимает запросы.",
    scope: { kind: "node" },
    defaultValue: "9012",
    applyMode: "после перезапуска",
    owner: "agent-herder",
    consumers: ["Воркер браузера"],
    valueContract: { kind: "tcp-port", min: 1, max: 65535 },
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

/**
 * The refusal of a value that does not fit the contract of its key.
 *
 * The key is a key of the environment file of the product. The answer is
 * `undefined` when the value fits the contract and the message of the refusal
 * when it does not. The message names the key, the allowed values and the
 * received value; the value of a secret is never in it.
 *
 * The comparison is the comparison of the service: the store refuses exactly
 * what the service would refuse, and nothing more.
 */
export function envValueRefusal(key: string, value: string, options: { secret?: boolean } = {}): string | undefined {
  const entry = catalogEntry(`herder.env/${key}`);
  const contract = entry?.valueContract;
  if (!contract) return undefined;
  if (fitsContract(value, contract)) return undefined;
  const secret = entry.secret === true || options.secret === true;
  const received = secret
    ? "Получено значение, которое не подходит; значение секрета в сообщении не приводится"
    : `Получено: «${value}»`;
  return `Настройка ${key} принимает только: ${describeContract(contract)}. ${received}.`;
}

/** The allowed values of a contract, as the owner reads them. */
function describeContract(contract: SettingsValueContract): string {
  if (contract.kind === "enum") return contract.values.join(", ");
  return `TCP-порт от ${contract.min} до ${contract.max}`;
}

/**
 * Whether the value fits the contract, the way the service reads it.
 *
 * Every branch here is the branch of the parser of the service, so a value
 * the service accepts is never refused and a value the service refuses is
 * never written.
 */
function fitsContract(value: string, contract: SettingsValueContract): boolean {
  if (contract.kind === "tcp-port") {
    // The service reads an empty value as the absence of the value and falls
    // back to its own port; a value with a space in it is a port of zero and
    // the service throws on it.
    if (value === "") return true;
    const port = Number(value);
    return Number.isInteger(port) && port >= contract.min && port <= contract.max;
  }
  if (contract.compare === "trim-lower") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return contract.empty === "allowed";
    return contract.values.includes(normalized);
  }
  if (value === "") return contract.empty === "allowed";
  return contract.values.includes(value);
}
