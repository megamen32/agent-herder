import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The settings of the herder product, managed by the owner from one form.
 *
 * The product is isolated: this module reads and writes the environment file
 * of the herder and the configuration of this node, and nothing else. The
 * files of the other products of the contour are never opened here — not for
 * a read and not for a write — so the isolation of the products cannot be
 * broken by this API.
 *
 * A secret is write-only. Its value is written into the file of the product
 * and it is never returned: the API answers with the fact that the secret is
 * set and with a stable fingerprint of it. The value of a secret never
 * reaches the audit journal, an error message or a log line.
 */

/** The entities of the settings the owner manages. */
export type SettingsEntity = "herder.env" | "node-config";

/** The environment file of the herder product: the source of truth for the services. */
export const HERDER_ENV_FILE = join(homedir(), ".config", "agent-herder", "herder.env");

/** The fleet node configuration of this node: only this node is ever touched. */
export const FLEET_NODE_CONFIG_FILE = join(homedir(), ".local", "share", "agent-herder", "fleet", "node-config.json");

/** The durable state of the settings: the audit journal and the undo stack. */
export const SETTINGS_STATE_DIR = join(homedir(), ".local", "state", "agent-herder", "settings");

/**
 * The keys of the fleet node configuration that the deployment owns.
 *
 * The node checks the identity of its host and the identity of its source at
 * every start, so a change of them from the form would leave the node unable
 * to start. The form reads them and never writes them.
 */
export const MANAGED_NODE_KEYS: ReadonlySet<string> = new Set(["hostId", "sourceSha"]);

/** One known key of the environment of the herder. */
export interface SettingsKeySpec {
  key: string;
  /** A secret is never returned: only the fact that it is set and its fingerprint. */
  secret: boolean;
  /** One line for the form: what the value is for. */
  description: string;
}

/** The keys of the environment of the herder that the owner manages. */
export const HERDER_ENV_KEYS: readonly SettingsKeySpec[] = [
  { key: "NOTIFY_CENTER_EVENT_URL", secret: false, description: "The endpoint of the events of the notification center." },
  { key: "NOTIFY_CENTER_PROJECT", secret: false, description: "The project of the herder in the notification center." },
  { key: "NOTIFY_CENTER_RECIPIENT", secret: false, description: "The recipient of the notices of the herder." },
  { key: "NOTIFY_CENTER_TOKEN", secret: true, description: "The token of the notification center. Write-only: the value is never returned." },
  { key: "NOTICEPLACE_HEALTH_LAUNCH_TOKEN", secret: true, description: "The token of the health launch of the center. Write-only: the value is never returned." },
];

/**
 * The name of a key that holds a secret.
 *
 * A key the herder does not know is treated as a secret when its name says
 * so, so an unknown secret is never exposed by a read of the settings.
 */
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE)/i;

/** A key of an environment file: a name, never a value with a space or a quote in it. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The largest value of a setting of the node configuration. */
const MAX_NODE_VALUE_BYTES = 64 * 1024;

/** The stable fingerprint of a secret: it names the value and never reveals it. */
export function settingsFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/** Whether the key holds a secret, by the known list or by the name of the key. */
export function isSecretKey(key: string): boolean {
  const known = HERDER_ENV_KEYS.find((spec) => spec.key === key);
  if (known) return known.secret;
  return SECRET_NAME_PATTERN.test(key);
}

/** The value of a setting as the API answers it. */
export interface SettingsValueView {
  kind: "value" | "secret";
  /** Whether the key exists in the file at all. */
  present: boolean;
  /** The value of a plain key. A secret never has one. */
  value?: string;
  /** Whether a secret is set. */
  configured?: boolean;
  /** The stable fingerprint of a secret. */
  fingerprint?: string;
  /** One line for the form. */
  description?: string;
}

/** The value of a setting as the audit journal keeps it. */
export interface SettingsAuditValue {
  present: boolean;
  /** The value of a plain key. A secret never has one. */
  value?: string;
  /** Whether a secret is set. */
  configured?: boolean;
  /** The stable fingerprint of a secret. */
  fingerprint?: string;
}

/** One record of the audit journal of the settings. */
export interface SettingsAuditRecord {
  id: string;
  at: string;
  actor: string;
  action: "set" | "delete" | "rollback";
  entity: SettingsEntity;
  key: string;
  kind: "value" | "secret";
  before: SettingsAuditValue;
  after: SettingsAuditValue;
  /** Whether the value of the key really changed. */
  changed: boolean;
  /** The entry of the undo stack that carries the previous value. */
  historyId?: string;
}

/**
 * One entry of the undo stack.
 *
 * The entry keeps the value the key had before the change, so the rollback
 * restores it. The value of a secret is kept here and only here: the undo
 * stack is a file of the owner with the same protection as the environment
 * file itself, and the value never leaves it — the API and the audit journal
 * name the secret by its fingerprint only.
 */
interface SettingsHistoryEntry {
  id: string;
  at: string;
  actor: string;
  entity: SettingsEntity;
  key: string;
  kind: "value" | "secret";
  /** Whether the key existed before the change. */
  previousPresent: boolean;
  /** The value the key had before the change. */
  previousValue?: unknown;
  /** The record of the audit journal of this change. */
  auditId: string;
  /** Set when the change was rolled back. */
  rolledBackBy?: string;
}

export interface SettingsStoreOptions {
  /** The environment file of the herder. Only this file is ever touched. */
  envPath?: string;
  /** The fleet node configuration of this node. */
  nodeConfigPath?: string;
  /** The durable state of the settings. */
  stateDir?: string;
  /** Who makes the change: the owner of this node. */
  actor?: string;
  /** The hostname of this node: the node configuration must keep naming it. */
  hostId?: string;
  /** The clock of the audit journal. */
  now?: () => Date;
}

/** One line of an environment file. */
interface EnvEntry {
  kind: "raw" | "kv";
  raw?: string;
  key?: string;
  value?: string;
}

/**
 * Parse an environment file.
 *
 * The format is the format of the systemd environment file: `KEY=value` per
 * line, `#` starts a comment, a value may be quoted. The lines that are not
 * a key are kept, so a write of the form does not drop the comments of the
 * owner.
 */
export function parseEnvFile(text: string): { entries: EnvEntry[]; values: Map<string, string> } {
  const entries: EnvEntry[] = [];
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ kind: "raw", raw: line });
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      entries.push({ kind: "raw", raw: line });
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      entries.push({ kind: "raw", raw: line });
      continue;
    }
    const value = parseEnvValue(line.slice(separator + 1));
    entries.push({ kind: "kv", key, value });
    values.set(key, value);
  }
  return { entries, values };
}

/** The value of a line of an environment file, without its quotes. */
function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  return value;
}

/** A value that needs no quotes in an environment file. */
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/** The value of a key as it is written into an environment file. */
function formatEnvValue(value: string): string {
  if (PLAIN_ENV_VALUE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

/** Render the entries of an environment file back into its text. */
export function renderEnvFile(entries: EnvEntry[]): string {
  const lines = entries.map((entry) => entry.kind === "raw"
    ? (entry.raw ?? "")
    : `${entry.key}=${formatEnvValue(entry.value ?? "")}`);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/** What one change of the API does to one key. */
interface SettingsChange {
  key: string;
  /** The new value; `undefined` removes the key. */
  value?: unknown;
  /** `null` removes the key as well. */
  remove: boolean;
  /** The action of the record of the audit journal. */
  action?: "set" | "delete" | "rollback";
  /** The entry of the undo stack this change rolls back. */
  rollbackOf?: string;
}

/**
 * The durable settings of the herder product.
 *
 * Every change is written atomically, recorded in the audit journal and kept
 * in the undo stack, so the owner can roll a change back to the value the
 * key had before it.
 */
export class SettingsStore {
  readonly envPath: string;
  readonly nodeConfigPath: string;
  readonly stateDir: string;
  private readonly actor: string;
  private readonly hostId: string;
  private readonly now: () => Date;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: SettingsStoreOptions = {}) {
    this.envPath = options.envPath ?? HERDER_ENV_FILE;
    this.nodeConfigPath = options.nodeConfigPath ?? FLEET_NODE_CONFIG_FILE;
    this.stateDir = options.stateDir ?? SETTINGS_STATE_DIR;
    this.actor = options.actor ?? "owner";
    this.hostId = options.hostId ?? "unknown-host";
    this.now = options.now ?? (() => new Date());
  }

  /** The journal of the changes. */
  get auditPath(): string {
    return join(this.stateDir, "audit.jsonl");
  }

  /** The undo stack of the changes. */
  get historyPath(): string {
    return join(this.stateDir, "history.json");
  }

  /** The environment of the herder as the API answers it. */
  async readEnvironment(): Promise<{
    path: string;
    present: boolean;
    mode?: string;
    values: Record<string, SettingsValueView>;
  }> {
    let text = "";
    let present = false;
    let mode: string | undefined;
    try {
      const info = await stat(this.envPath);
      if (!info.isFile()) throw new Error("the environment file is not a regular file");
      present = true;
      mode = `0${(info.mode & 0o777).toString(8).padStart(3, "0")}`;
      text = await readFile(this.envPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const { values } = parseEnvFile(text);
    const view: Record<string, SettingsValueView> = {};
    for (const spec of HERDER_ENV_KEYS) {
      const value = values.get(spec.key);
      view[spec.key] = spec.secret
        ? {
          kind: "secret",
          present: value !== undefined,
          configured: value !== undefined && value.length > 0,
          ...(value !== undefined && value.length > 0 ? { fingerprint: settingsFingerprint(value) } : {}),
          description: spec.description,
        }
        : {
          kind: "value",
          present: value !== undefined,
          ...(value !== undefined ? { value } : {}),
          description: spec.description,
        };
    }
    // A key the herder does not know is shown too: a setting the owner has
    // added by hand is still a setting of the product. A key whose name says
    // it holds a secret is shown as a secret and never as a value.
    for (const [key, value] of values) {
      if (view[key]) continue;
      view[key] = isSecretKey(key)
        ? {
          kind: "secret",
          present: true,
          configured: value.length > 0,
          ...(value.length > 0 ? { fingerprint: settingsFingerprint(value) } : {}),
          description: "A key of the environment file that the herder does not know by name.",
        }
        : {
          kind: "value",
          present: true,
          value,
          description: "A key of the environment file that the herder does not know by name.",
        };
    }
    return { path: this.envPath, present, ...(mode ? { mode } : {}), values: view };
  }

  /** The fleet node configuration of this node as the API answers it. */
  async readNodeConfig(): Promise<{
    path: string;
    present: boolean;
    config: Record<string, unknown> | null;
    managedKeys: string[];
  }> {
    let raw: string;
    try {
      raw = await readFile(this.nodeConfigPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: this.nodeConfigPath, present: false, config: null, managedKeys: [...MANAGED_NODE_KEYS] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the fleet node configuration is not a JSON object");
    }
    return {
      path: this.nodeConfigPath,
      present: true,
      config: parsed as Record<string, unknown>,
      managedKeys: [...MANAGED_NODE_KEYS],
    };
  }

  /** The journal of the changes, the newest record last. */
  async readAudit(limit = 50): Promise<SettingsAuditRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.auditPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: SettingsAuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as SettingsAuditRecord);
      } catch {
        // A broken line of the journal never breaks the read of the journal.
      }
    }
    return records.slice(-Math.max(1, Math.min(limit, 500)));
  }

  /**
   * Check the changes without writing anything.
   *
   * The API checks every change before the first write, so a refused value
   * never leaves a half applied change behind.
   */
  async validate(changes: { environment?: Record<string, unknown>; fleetNode?: Record<string, unknown> }): Promise<void> {
    if (changes.environment) {
      for (const [key, change] of Object.entries(changes.environment)) {
        if (!ENV_KEY_PATTERN.test(key)) throw new Error(`the name of the setting is not a key of an environment file: ${key}`);
        if (typeof change !== "string" && change !== null) throw new Error(`the value of the setting ${key} must be a string or null`);
        if (typeof change === "string" && /[\r\n\0]/.test(change)) {
          throw new Error(`the value of the setting ${key} must not contain a line break`);
        }
      }
    }
    if (changes.fleetNode) {
      // The configuration of the node is created by the deployment of the
      // node: a form never invents one.
      try {
        await readFile(this.nodeConfigPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("this node has no fleet node configuration; the deployment creates it");
        }
        throw error;
      }
      for (const [key, change] of Object.entries(changes.fleetNode)) {
        if (MANAGED_NODE_KEYS.has(key)) {
          throw new Error(`the setting ${key} is managed by the deployment of the node and is not changed from the form`);
        }
        if (change !== null) assertBoundedNodeValue(key, change);
      }
    }
  }

  /**
   * Write the values of the environment of the herder.
   *
   * A value of `null` removes the key. The value of a secret is written into
   * the file of the product and is never returned: the answer names it by
   * its fingerprint only.
   */
  async applyEnvironment(changes: Record<string, string | null>): Promise<SettingsAuditRecord[]> {
    return await this.serial(async () => await this.applyEnvironmentUnsafe(changes));
  }

  /**
   * Write the values of the fleet node configuration of this node.
   *
   * Only the configuration of this node is touched, and only the keys of the
   * deployment are refused: the identity of the node and the identity of its
   * source are checked by the node itself at every start, so a form must not
   * change them.
   */
  async applyNodeConfig(changes: Record<string, unknown>): Promise<SettingsAuditRecord[]> {
    return await this.serial(async () => await this.applyNodeConfigUnsafe(changes));
  }

  /**
   * Roll a change back to the value the key had before it.
   *
   * The rollback is a change of its own: it is written, audited and it can be
   * rolled back again.
   */
  async rollback(target: { entity: SettingsEntity; key: string; historyId?: string }): Promise<SettingsAuditRecord> {
    return await this.serial(async () => {
      const history = await this.readHistory();
      const candidates = history.filter((entry) =>
        entry.entity === target.entity
        && entry.key === target.key
        && !entry.rolledBackBy
        && (target.historyId === undefined || entry.auditId === target.historyId || entry.id === target.historyId));
      const entry = candidates[candidates.length - 1];
      if (!entry) throw new Error("there is no change of this setting to roll back");
      const restore = entry.previousPresent ? entry.previousValue : undefined;
      const change: SettingsChange = {
        key: entry.key,
        value: restore,
        remove: restore === undefined,
        action: "rollback",
        rollbackOf: entry.id,
      };
      const records = entry.entity === "herder.env"
        ? await this.applyEnvironmentUnsafe({ [entry.key]: restore === undefined ? null : String(restore) }, change)
        : await this.applyNodeConfigUnsafe({ [entry.key]: restore === undefined ? null : restore }, change);
      const record = records[0];
      if (!record) throw new Error("the rollback did not change the setting");
      entry.rolledBackBy = record.id;
      await this.writeHistory(history);
      return record;
    });
  }

  /** The write of the environment without the lock of the store. */
  private async applyEnvironmentUnsafe(
    changes: Record<string, string | null>,
    context?: SettingsChange,
  ): Promise<SettingsAuditRecord[]> {
    let text = "";
    try {
      text = await readFile(this.envPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const { entries, values } = parseEnvFile(text);
    const records: SettingsAuditRecord[] = [];
    const pendingHistory: SettingsHistoryEntry[] = [];
    for (const [key, change] of Object.entries(changes)) {
      if (!ENV_KEY_PATTERN.test(key)) throw new Error(`the name of the setting is not a key of an environment file: ${key}`);
      if (typeof change !== "string" && change !== null) throw new Error(`the value of the setting ${key} must be a string or null`);
      if (typeof change === "string" && /[\r\n\0]/.test(change)) {
        throw new Error(`the value of the setting ${key} must not contain a line break`);
      }
      const secret = isSecretKey(key);
      const previous = values.get(key);
      const before = secret
        ? { present: previous !== undefined, configured: previous !== undefined && previous.length > 0, ...(previous ? { fingerprint: settingsFingerprint(previous) } : {}) }
        : { present: previous !== undefined, ...(previous !== undefined ? { value: previous } : {}) };
      const next = change === null ? undefined : change;
      const after = secret
        ? { present: next !== undefined, configured: next !== undefined && next.length > 0, ...(next ? { fingerprint: settingsFingerprint(next) } : {}) }
        : { present: next !== undefined, ...(next !== undefined ? { value: next } : {}) };
      const changed = previous !== next;
      const historyId = changed && !context?.rollbackOf ? randomUUID() : undefined;
      const record: SettingsAuditRecord = {
        id: randomUUID(),
        at: this.now().toISOString(),
        actor: this.actor,
        action: context?.action ?? (next === undefined ? "delete" : "set"),
        entity: "herder.env",
        key,
        kind: secret ? "secret" : "value",
        before,
        after,
        changed,
        ...(historyId ? { historyId } : {}),
        ...(context?.rollbackOf ? { historyId: context.rollbackOf } : {}),
      };
      if (historyId) {
        pendingHistory.push({
          id: historyId,
          at: record.at,
          actor: this.actor,
          entity: "herder.env",
          key,
          kind: secret ? "secret" : "value",
          previousPresent: previous !== undefined,
          previousValue: previous,
          auditId: record.id,
        });
      }
      records.push(record);
      const index = entries.findIndex((entry) => entry.kind === "kv" && entry.key === key);
      if (next === undefined) {
        if (index >= 0) entries.splice(index, 1);
        values.delete(key);
      } else if (index >= 0) {
        entries[index] = { kind: "kv", key, value: next };
        values.set(key, next);
      } else {
        entries.push({ kind: "kv", key, value: next });
        values.set(key, next);
      }
    }
    // The file of the product is written before the journal claims the
    // change: a refused write leaves no record of a change that never
    // happened.
    await this.writeEnvFile(renderEnvFile(entries));
    for (const entry of pendingHistory) await this.pushHistory(entry);
    for (const record of records) await this.appendAudit(record);
    return records;
  }

  /** The write of the node configuration without the lock of the store. */
  private async applyNodeConfigUnsafe(
    changes: Record<string, unknown>,
    context?: SettingsChange,
  ): Promise<SettingsAuditRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.nodeConfigPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("this node has no fleet node configuration; the deployment creates it");
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the fleet node configuration is not a JSON object");
    }
    const config = parsed as Record<string, unknown>;
    const records: SettingsAuditRecord[] = [];
    const pendingHistory: SettingsHistoryEntry[] = [];
    for (const [key, change] of Object.entries(changes)) {
      if (MANAGED_NODE_KEYS.has(key)) {
        throw new Error(`the setting ${key} is managed by the deployment of the node and is not changed from the form`);
      }
      if (change !== null) assertBoundedNodeValue(key, change);
      const previous = config[key];
      const before: SettingsAuditValue = { present: previous !== undefined, ...(previous !== undefined ? { value: auditValue(previous) } : {}) };
      const next = change === null ? undefined : change;
      const after: SettingsAuditValue = { present: next !== undefined, ...(next !== undefined ? { value: auditValue(next) } : {}) };
      const changed = JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null);
      const record: SettingsAuditRecord = {
        id: randomUUID(),
        at: this.now().toISOString(),
        actor: this.actor,
        action: context?.action ?? (next === undefined ? "delete" : "set"),
        entity: "node-config",
        key,
        kind: "value",
        before,
        after,
        changed,
      };
      if (changed && !context?.rollbackOf) {
        pendingHistory.push({
          id: randomUUID(),
          at: record.at,
          actor: this.actor,
          entity: "node-config",
          key,
          kind: "value",
          previousPresent: previous !== undefined,
          previousValue: previous,
          auditId: record.id,
        });
        record.historyId = pendingHistory[pendingHistory.length - 1]!.id;
      }
      if (context?.rollbackOf) record.historyId = context.rollbackOf;
      records.push(record);
      if (next === undefined) delete config[key];
      else config[key] = next;
    }
    // The configuration is written before the journal claims the change.
    await this.writeNodeConfig(config);
    for (const entry of pendingHistory) await this.pushHistory(entry);
    for (const record of records) await this.appendAudit(record);
    return records;
  }

  /** The undo stack of the changes. */
  private async readHistory(): Promise<SettingsHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed as SettingsHistoryEntry[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Add one entry to the undo stack. */
  private async pushHistory(entry: SettingsHistoryEntry): Promise<void> {
    const history = await this.readHistory();
    history.push(entry);
    await this.writeHistory(history);
  }

  /** Write the undo stack. */
  private async writeHistory(history: SettingsHistoryEntry[]): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.historyPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.historyPath);
  }

  /** Add one record to the audit journal. */
  private async appendAudit(record: SettingsAuditRecord): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  /** Write the environment file of the herder atomically. */
  private async writeEnvFile(text: string): Promise<void> {
    await mkdir(dirname(this.envPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.envPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, this.envPath);
  }

  /** Write the fleet node configuration of this node atomically. */
  private async writeNodeConfig(config: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.nodeConfigPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.nodeConfigPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.nodeConfigPath);
  }

  /** The writes of the settings are one after another. */
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/** The value of a setting of the node configuration as the audit journal names it. */
function auditValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unreadable value]";
  }
}

/** A value of the node configuration that is small and of a known shape. */
function assertBoundedNodeValue(key: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    throw new Error(`the value of the setting ${key} cannot be written as JSON`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_NODE_VALUE_BYTES) {
    throw new Error(`the value of the setting ${key} is too large`);
  }
}
