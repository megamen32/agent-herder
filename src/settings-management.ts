import {
  settingsFingerprint,
  type SettingsAuditRecord,
  type SettingsEntity,
  type SettingsStore,
  type SettingsValueView,
} from "./web/settings-store.js";

/**
 * The management of the settings of the herder, in one place.
 *
 * The web, the MCP tool and the CLI call these functions, so all three read
 * the same values, change them the same way and keep one truth about them.
 * The store is the seam the web uses; this module adds nothing to it except
 * the precondition of a change.
 */

/** The version of one value, as the precondition names it. */
export type SettingsValueVersion = string;

/**
 * The version of the value as it stands now.
 *
 * A value that is not there has the version `absent`; a secret is named by the
 * fingerprint the store gives it; a plain value is named by the fingerprint of
 * its text. The fingerprint is the store's own primitive, so the scheme of the
 * versions is the scheme of the settings and not a second one.
 */
export function settingsValueVersion(view: SettingsValueView): SettingsValueVersion {
  if (!view.present) return "absent";
  if (view.kind === "secret") return view.fingerprint ?? "unknown";
  return settingsFingerprint(view.value ?? "");
}

/** The version of one key of the configuration of the fleet node. */
export function nodeConfigValueVersion(value: unknown, present: boolean): SettingsValueVersion {
  if (!present) return "absent";
  return settingsFingerprint(JSON.stringify(value ?? null));
}

/** The answer of a change that was refused. */
export interface SettingsRefusal {
  ok: false;
  code: "precondition_required" | "precondition_failed" | "invalid_request" | "not_available";
  error: string;
  /** The version of the value as it stands now, when it is known. */
  current?: SettingsValueVersion;
}

/** The answer of a change that was applied. */
export interface SettingsApplied {
  ok: true;
  entity: SettingsEntity;
  key: string;
  /** The version the value has after the change. */
  version: SettingsValueVersion;
  applied: SettingsAuditRecord[];
}

/** The answer of a read: the values of the contour and their versions. */
export interface SettingsReadView {
  ok: true;
  environment: {
    entity: "herder.env";
    path: string;
    present: boolean;
    /** The values of the file and the version of each of them. */
    values: Record<string, { kind: "value" | "secret"; present: boolean; version: SettingsValueVersion }>;
  };
  fleetNode: {
    entity: "node-config";
    path: string;
    present: boolean;
    managedKeys: string[];
    /** The configuration and the version of each of its keys. */
    values: Record<string, { present: boolean; version: SettingsValueVersion }>;
  };
  audit: SettingsAuditRecord[];
}

/** Read the values of the contour and the version of each of them. */
export async function readSettings(store: SettingsStore): Promise<SettingsReadView> {
  const environment = await store.readEnvironment();
  const fleetNode = await store.readNodeConfig();
  const audit = await store.readAudit(20);
  const values: SettingsReadView["environment"]["values"] = {};
  for (const [key, view] of Object.entries(environment.values)) {
    values[key] = { kind: view.kind, present: view.present, version: settingsValueVersion(view) };
  }
  const nodeValues: SettingsReadView["fleetNode"]["values"] = {};
  for (const [key, value] of Object.entries(fleetNode.config ?? {})) {
    nodeValues[key] = { present: true, version: nodeConfigValueVersion(value, true) };
  }
  return {
    ok: true,
    environment: {
      entity: "herder.env",
      path: environment.path,
      present: environment.present,
      values,
    },
    fleetNode: {
      entity: "node-config",
      path: fleetNode.path,
      present: fleetNode.present,
      managedKeys: fleetNode.managedKeys,
      values: nodeValues,
    },
    audit,
  };
}

/** The version of one key as it stands now. */
export async function currentSettingsVersion(
  store: SettingsStore,
  entity: SettingsEntity,
  key: string,
): Promise<SettingsValueVersion> {
  if (entity === "herder.env") {
    const environment = await store.readEnvironment();
    const view = environment.values[key];
    return view ? settingsValueVersion(view) : "absent";
  }
  const fleetNode = await store.readNodeConfig();
  const config = fleetNode.config ?? {};
  const present = Object.prototype.hasOwnProperty.call(config, key);
  return nodeConfigValueVersion(present ? config[key] : undefined, present);
}

/**
 * Change one value of the settings.
 *
 * A change states the version of the value as it was read. Without it the
 * change is refused, and a value that changed in the meantime is not
 * overwritten: the same rule the policy of the launch keeps at its own
 * endpoint, with the same shape of the answer.
 */
export async function applySettingsValue(
  store: SettingsStore,
  input: {
    entity: SettingsEntity;
    key: string;
    /** The new value: a string for the environment, any JSON for the node configuration. */
    value: unknown;
    /** The version of the value as it was read. */
    ifMatch?: string;
    actor?: string;
  },
): Promise<SettingsApplied | SettingsRefusal> {
  const key = input.key.trim();
  if (!key) {
    return { ok: false, code: "invalid_request", error: "Ключ настройки обязателен." };
  }
  const current = await currentSettingsVersion(store, input.entity, key);
  if (!input.ifMatch) {
    return {
      ok: false,
      code: "precondition_required",
      error: "Укажите версию значения (ifMatch) — так же, как при записи политики запуска.",
      current,
    };
  }
  if (input.ifMatch !== current) {
    return {
      ok: false,
      code: "precondition_failed",
      error: "Значение изменилось после того, как его прочитали.",
      current,
    };
  }
  if (input.entity === "herder.env") {
    if (input.value !== undefined && input.value !== null && typeof input.value !== "string") {
      return { ok: false, code: "invalid_request", error: "Значение окружения — строка.", current };
    }
    await store.validate({ environment: { [key]: input.value ?? null } });
    const applied = await store.applyEnvironment({ [key]: input.value ?? null });
    return { ok: true, entity: input.entity, key, version: await currentSettingsVersion(store, input.entity, key), applied };
  }  await store.validate({ fleetNode: { [key]: input.value } });
  const applied = await store.applyNodeConfig({ [key]: input.value });
  return { ok: true, entity: input.entity, key, version: await currentSettingsVersion(store, input.entity, key), applied };
}

/**
 * Roll a change back to the value the key had before it.
 *
 * The rollback is a change of its own: it is written, audited and it can be
 * rolled back again.
 */
export async function rollbackSettingsValue(
  store: SettingsStore,
  input: { entity: SettingsEntity; key: string; historyId?: string },
): Promise<SettingsApplied | SettingsRefusal> {
  const key = input.key.trim();
  if (!key) {
    return { ok: false, code: "invalid_request", error: "Ключ настройки обязателен." };
  }
  try {
    const applied = await store.rollback({ entity: input.entity, key, ...(input.historyId ? { historyId: input.historyId } : {}) });
    return {
      ok: true,
      entity: input.entity,
      key,
      version: await currentSettingsVersion(store, input.entity, key),
      applied: [applied],
    };
  } catch (error) {
    return { ok: false, code: "invalid_request", error: (error as Error).message };
  }
}

/**
 * The command of the settings: `settings read|apply|rollback`.
 *
 * The command is the third door to the same implementation: the web, the MCP
 * tool of the node and this command read the same values, change them the
 * same way and keep one audit journal. A change states the version of the
 * value as it was read, exactly as the MCP tool does.
 *
 * The answer is the exit code of the command: zero when the command did what
 * it was asked, one when a change was refused, two when the command was
 * called wrongly.
 */
export async function runSettingsCommand(
  argv: string[],
  store: SettingsStore,
  print: (text: string) => void = (text) => console.log(text),
  fail: (text: string) => void = (text) => console.error(text),
): Promise<number> {
  const op = argv[0] ?? "read";
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  if (op === "read") {
    print(JSON.stringify(await readSettings(store), null, 2));
    return 0;
  }
  const entity = argv[1];
  const key = argv[2];
  if ((entity !== "herder.env" && entity !== "node-config") || !key) {
    fail("Использование: agent-herder settings apply|rollback <herder.env|node-config> <ключ> [значение] [--if-match <версия>]");
    return 2;
  }
  if (op === "rollback") {
    const rolled = await rollbackSettingsValue(store, { entity, key, historyId: flag("--history") });
    if (!rolled.ok) {
      fail(JSON.stringify(rolled));
      return 1;
    }
    print(JSON.stringify(rolled, null, 2));
    return 0;
  }
  if (op !== "apply") {
    fail("Использование: agent-herder settings read|apply|rollback");
    return 2;
  }
  const raw = argv[3];
  let value: unknown = raw ?? null;
  if (entity === "node-config" && raw !== undefined) {
    try {
      value = JSON.parse(raw);
    } catch {
      fail("Значение конфигурации узла — JSON.");
      return 2;
    }
  }
  const applied = await applySettingsValue(store, { entity, key, value, ifMatch: flag("--if-match") });
  if (!applied.ok) {
    fail(JSON.stringify(applied));
    return 1;
  }
  print(JSON.stringify(applied, null, 2));
  return 0;
}
