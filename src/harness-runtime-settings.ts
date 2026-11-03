/**
 * The runtime switches of the harnesses of the herder.
 *
 * One document answers two questions of the owner, at once, without a
 * restart: may a harness keep making its background requests to its site,
 * and may the plugin hooks of a harness keep running. The browser harnesses
 * (ChatGPT, Z.ai) are watched by polling — the inventory list, the history
 * prewarm — and a site that answers 429 makes that polling a burden the
 * owner may want to lift for a while. The pause stops the requests the
 * herder initiates; the passive paths (the ChatGPT intercept hook of the
 * page, the local CDP snapshots of the modal-prompt poller) keep running.
 * The native
 * harnesses (Claude Code, Codex, MiniMax Code, …) reach the herder through
 * their plugin hooks instead, so pausing the requests of a site and
 * silencing the hooks of a harness are two independent switches, and the
 * owner decides each one on its own.
 *
 * The document lives next to the durable state of the autopilot. It is read
 * by every process that needs the answer — the server, the pollers of the
 * adapters, the hook scripts of the plugins — and a change of it reaches
 * every reader on its next tick or its next run. The global switch of the
 * hooks runtime keeps its own home (src/hooks/state.ts): the lever of the
 * hooks belongs to the hooks alone; this document only silences the hooks
 * of one harness at a time.
 */
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveAutopilotStateDir } from "./autopilot/state-dir.js";

/** The durable file of the switches, inside the autopilot state directory. */
export const HARNESS_RUNTIME_SETTINGS_FILE_NAME = "harness-runtime-settings.json";

/** The audit journal of the switches: one line per accepted change. */
export const HARNESS_RUNTIME_SETTINGS_AUDIT_FILE_NAME = "harness-runtime-settings.audit.jsonl";

/** The default prewarm budget of one browser harness, in chats. */
export const DEFAULT_PREWARM_LIMIT = 100;

/** The switches of one harness. An absent field inherits its default. */
export interface HarnessRuntimeHarnessEntry {
  /** False pauses every background request this harness makes to its site. */
  pollingEnabled?: boolean;
  /** The ChatGPT modal-prompt poller (periodic CDP snapshots; its own
   * switch — the pause of the site requests does not stop it). */
  promptPollingEnabled?: boolean;
  /** The history prewarm budget of this harness in chats; 0 disables prewarm. */
  prewarmLimit?: number;
  /** False silences the plugin hooks of this harness. */
  hooksEnabled?: boolean;
}

/** The whole document of the runtime switches. */
export interface HarnessRuntimeSettingsDocument {
  version: 1;
  /** The master switch of the browser polling: false pauses every harness. */
  pollingEnabled: boolean;
  /** The per-harness overrides. A harness that is not named inherits. */
  harnesses: Record<string, HarnessRuntimeHarnessEntry>;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
}

/** The change a caller asks for: present fields move, absent fields stay. */
export interface HarnessRuntimeSettingsChange {
  pollingEnabled?: boolean;
  harnesses?: Record<string, HarnessRuntimeHarnessEntryPatch>;
}

/** The patch of one harness: null clears the field back to its inherited value. */
export interface HarnessRuntimeHarnessEntryPatch {
  pollingEnabled?: boolean | null;
  promptPollingEnabled?: boolean | null;
  prewarmLimit?: number | null;
  hooksEnabled?: boolean | null;
}

/** A change the document refuses: the value never reaches the file. */
export class HarnessRuntimeSettingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HarnessRuntimeSettingsError";
    this.code = code;
  }
}

/** The document every harness starts from: everything runs. */
export function emptyHarnessRuntimeSettings(): HarnessRuntimeSettingsDocument {
  return { version: 1, pollingEnabled: true, harnesses: {} };
}

function parseEntry(value: unknown, where: string): HarnessRuntimeHarnessEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessRuntimeSettingsError("invalid_harness_entry", `${where}: запись харнесса должна быть объектом`);
  }
  const entry: HarnessRuntimeHarnessEntry = {};
  const record = value as Record<string, unknown>;
  for (const key of ["pollingEnabled", "promptPollingEnabled", "hooksEnabled"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean") {
        throw new HarnessRuntimeSettingsError("invalid_switch", `${where}.${key}: ожидалось true или false`);
      }
      entry[key] = record[key] as boolean;
    }
  }
  if (record.prewarmLimit !== undefined) {
    const limit = record.prewarmLimit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > DEFAULT_PREWARM_LIMIT) {
      throw new HarnessRuntimeSettingsError(
        "invalid_prewarm_limit",
        `${where}.prewarmLimit: ожидалось целое от 0 до ${DEFAULT_PREWARM_LIMIT}`,
      );
    }
    entry.prewarmLimit = limit;
  }
  return entry;
}

/** Read the document from its JSON text. A text that is not a valid document
 * of this version is refused by name: the caller decides whether the
 * defaults apply, and both callers read the refusal the same way. */
export function parseHarnessRuntimeSettings(raw: string): HarnessRuntimeSettingsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessRuntimeSettingsError("invalid_json", "файл настроек харнессов не является корректным JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarnessRuntimeSettingsError("invalid_document", "файл настроек харнессов должен быть объектом");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new HarnessRuntimeSettingsError("unsupported_version", "неизвестная версия файла настроек харнессов");
  }
  const document = emptyHarnessRuntimeSettings();
  if (record.pollingEnabled !== undefined) {
    if (typeof record.pollingEnabled !== "boolean") {
      throw new HarnessRuntimeSettingsError("invalid_switch", "pollingEnabled: ожидалось true или false");
    }
    document.pollingEnabled = record.pollingEnabled;
  }
  if (record.harnesses !== undefined) {
    if (!record.harnesses || typeof record.harnesses !== "object" || Array.isArray(record.harnesses)) {
      throw new HarnessRuntimeSettingsError("invalid_harnesses", "harnesses: ожидался объект харнессов");
    }
    for (const [harness, entry] of Object.entries(record.harnesses)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(harness)) {
        throw new HarnessRuntimeSettingsError("invalid_harness_id", `harnesses.${harness}: недопустимое имя харнесса`);
      }
      const parsedEntry = parseEntry(entry, `harnesses.${harness}`);
      if (Object.keys(parsedEntry).length) document.harnesses[harness] = parsedEntry;
    }
  }
  if (typeof record.changedAt === "string") document.changedAt = record.changedAt;
  if (typeof record.changedBy === "string") document.changedBy = record.changedBy;
  if (typeof record.reason === "string") document.reason = record.reason;
  return document;
}

/** May this harness make its background requests? The global switch is the
 * default; a per-harness override wins either way — `true` enables a
 * harness even when the global switch is off, `false` pauses one harness
 * even when the global switch is on. ChatGPT's 429 (which only an owner
 * mapped to a global pause) no longer reaches Z.ai. */
export function harnessPollingEnabled(document: HarnessRuntimeSettingsDocument, harness: string): boolean {
  const override = document.harnesses[harness]?.pollingEnabled;
  return override ?? document.pollingEnabled;
}

/** May the ChatGPT modal-prompt poller run? Its snapshots read the local
 * page through CDP and send nothing to the site, so the poller stands on its
 * own switch: the pause of the site requests does not silence the watcher
 * of the permission prompts and the "Continue in Work?" dialog. */
export function harnessPromptPollingEnabled(document: HarnessRuntimeSettingsDocument, harness: string): boolean {
  return document.harnesses[harness]?.promptPollingEnabled !== false;
}

/** The history prewarm budget of one harness, in chats. The override of the
 * harness wins, then the environment of the node, then the product default.
 * Zero is an explicit pause of the prewarm. */
export function harnessPrewarmLimit(
  document: HarnessRuntimeSettingsDocument,
  harness: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = document.harnesses[harness]?.prewarmLimit;
  if (typeof override === "number") return override;
  const configured = Number(env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(DEFAULT_PREWARM_LIMIT, Math.floor(configured));
  }
  return DEFAULT_PREWARM_LIMIT;
}

/** May the plugin hooks of this harness run? The global runtime of the hooks
 * keeps its own lever (src/hooks/state.ts); this switch only silences one
 * harness at a time and defaults to running. */
export function harnessHooksEnabled(document: HarnessRuntimeSettingsDocument, harness: string): boolean {
  return document.harnesses[harness]?.hooksEnabled !== false;
}

// ---------------------------------------------------------------------------
// The live view: what a poller or a hook script reads on every tick.
// ---------------------------------------------------------------------------

let livePathOverride: string | undefined;
let liveCache: { path: string; mtimeMs: number; document: HarnessRuntimeSettingsDocument } | undefined;
let warnedUnreadable = "";

/** Point the live view at another file. Production never calls this; a test
 * keeps its private file away from the state directory of the host. */
export function setHarnessRuntimeSettingsPathForTests(path: string | undefined): void {
  livePathOverride = path;
  liveCache = undefined;
}

/** The file the live view reads now. */
export function harnessRuntimeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return livePathOverride ?? join(resolveAutopilotStateDir(env), HARNESS_RUNTIME_SETTINGS_FILE_NAME);
}

/** Read the document the pollers must obey right now.
 *
 * The file is stat'ed on every call and parsed only when its mtime moved:
 * a poller asks on every tick, and the answer must cost a stat, not a read.
 * A file that cannot be read answers with the defaults — the same fail-open
 * rule as the store — and says so in the log once per distinct refusal. */
export function readHarnessRuntimeSettingsLive(env: NodeJS.ProcessEnv = process.env): HarnessRuntimeSettingsDocument {
  const path = harnessRuntimeSettingsPath(env);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (liveCache && liveCache.path === path && liveCache.mtimeMs === mtimeMs) return liveCache.document;
  let document = emptyHarnessRuntimeSettings();
  if (mtimeMs >= 0) {
    try {
      document = parseHarnessRuntimeSettings(readFileSync(path, "utf8"));
      warnedUnreadable = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (warnedUnreadable !== message) {
        warnedUnreadable = message;
        console.warn("[agent-herder] harness runtime settings unreadable; the defaults apply: " + message);
      }
    }
  }
  liveCache = { path, mtimeMs, document };
  return document;
}

/** May this harness poll its site right now? */
export function liveHarnessPollingEnabled(harness: string): boolean {
  return harnessPollingEnabled(readHarnessRuntimeSettingsLive(), harness);
}

/** May the ChatGPT modal-prompt poller run right now? */
export function liveHarnessPromptPollingEnabled(harness: string): boolean {
  return harnessPromptPollingEnabled(readHarnessRuntimeSettingsLive(), harness);
}

/** The prewarm budget of this harness right now. */
export function liveHarnessPrewarmLimit(harness: string): number {
  return harnessPrewarmLimit(readHarnessRuntimeSettingsLive(), harness);
}

/** May the plugin hooks of this harness run right now? */
export function liveHarnessHooksEnabled(harness: string): boolean {
  return harnessHooksEnabled(readHarnessRuntimeSettingsLive(), harness);
}

// ---------------------------------------------------------------------------
// The store: what the owner's panel writes.
// ---------------------------------------------------------------------------

/** One line of the audit journal. */
export interface HarnessRuntimeSettingsAuditRecord {
  at: string;
  by: string;
  reason: string;
  before: HarnessRuntimeSettingsDocument;
  after: HarnessRuntimeSettingsDocument;
}

export class HarnessRuntimeSettingsStore {
  constructor(readonly path: string) {}

  /** The store of one autopilot state directory. */
  static at(stateDir: string): HarnessRuntimeSettingsStore {
    return new HarnessRuntimeSettingsStore(join(stateDir, HARNESS_RUNTIME_SETTINGS_FILE_NAME));
  }

  /** The store of the configured runtime state directory. */
  static forRuntime(env: NodeJS.ProcessEnv = process.env): HarnessRuntimeSettingsStore {
    return HarnessRuntimeSettingsStore.at(resolveAutopilotStateDir(env));
  }

  private auditPath(): string {
    return join(this.path, "..", HARNESS_RUNTIME_SETTINGS_AUDIT_FILE_NAME);
  }

  /** The document of the store; an absent or unreadable file is the defaults. */
  async read(): Promise<HarnessRuntimeSettingsDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return emptyHarnessRuntimeSettings();
    }
    try {
      return parseHarnessRuntimeSettings(raw);
    } catch (error) {
      console.warn("[agent-herder] harness runtime settings unreadable; the defaults apply: " + (error instanceof Error ? error.message : String(error)));
      return emptyHarnessRuntimeSettings();
    }
  }

  /** Apply one change: present fields move, absent fields stay, null clears.
   * The next document is written atomically and journalled before it answers. */
  async update(
    change: HarnessRuntimeSettingsChange,
    meta: { by: string; reason?: string } = { by: "owner" },
  ): Promise<HarnessRuntimeSettingsDocument> {
    if (change.pollingEnabled !== undefined && typeof change.pollingEnabled !== "boolean") {
      throw new HarnessRuntimeSettingsError("invalid_switch", "pollingEnabled: ожидалось true или false");
    }
    const before = await this.read();
    const after: HarnessRuntimeSettingsDocument = {
      version: 1,
      pollingEnabled: change.pollingEnabled ?? before.pollingEnabled,
      harnesses: { ...before.harnesses },
      changedAt: new Date().toISOString(),
      changedBy: meta.by,
      ...(meta.reason ? { reason: meta.reason } : {}),
    };
    if (change.harnesses !== undefined) {
      if (!change.harnesses || typeof change.harnesses !== "object" || Array.isArray(change.harnesses)) {
        throw new HarnessRuntimeSettingsError("invalid_harnesses", "harnesses: ожидался объект харнессов");
      }
      for (const [harness, patch] of Object.entries(change.harnesses)) {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(harness)) {
          throw new HarnessRuntimeSettingsError("invalid_harness_id", `harnesses.${harness}: недопустимое имя харнесса`);
        }
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          throw new HarnessRuntimeSettingsError("invalid_harness_entry", `harnesses.${harness}: запись должна быть объектом`);
        }
        const entry: HarnessRuntimeHarnessEntry = { ...(before.harnesses[harness] ?? {}) };
        for (const key of ["pollingEnabled", "promptPollingEnabled", "hooksEnabled"] as const) {
          const value = (patch as HarnessRuntimeHarnessEntryPatch)[key];
          if (value === null) delete entry[key];
          else if (value !== undefined) {
            if (typeof value !== "boolean") {
              throw new HarnessRuntimeSettingsError("invalid_switch", `harnesses.${harness}.${key}: ожидалось true, false или null`);
            }
            entry[key] = value;
          }
        }
        const limit = (patch as HarnessRuntimeHarnessEntryPatch).prewarmLimit;
        if (limit === null) delete entry.prewarmLimit;
        else if (limit !== undefined) {
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > DEFAULT_PREWARM_LIMIT) {
            throw new HarnessRuntimeSettingsError(
              "invalid_prewarm_limit",
              `harnesses.${harness}.prewarmLimit: ожидалось целое от 0 до ${DEFAULT_PREWARM_LIMIT} или null`,
            );
          }
          entry.prewarmLimit = limit;
        }
        if (Object.keys(entry).length) after.harnesses[harness] = entry;
        else delete after.harnesses[harness];
      }
    }
    await mkdir(join(this.path, ".."), { recursive: true });
    const temporary = this.path + ".tmp-" + process.pid;
    try {
      await writeFile(temporary, JSON.stringify(after, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const record: HarnessRuntimeSettingsAuditRecord = { at: after.changedAt!, by: meta.by, reason: meta.reason ?? "", before, after };
    await appendFile(this.auditPath(), JSON.stringify(record) + "\n", { mode: 0o600 }).catch(() => undefined);
    return after;
  }
}

// ---------------------------------------------------------------------------
// The view of the panel: every harness with its effective switches.
// ---------------------------------------------------------------------------

/** One harness as the settings page reads it. */
export interface HarnessRuntimeHarnessView {
  id: string;
  name: string | null;
  /** The effective switch; the override is what the document says, or null
   * when the harness inherits. */
  pollingEnabled: boolean;
  pollingOverride: boolean | null;
  promptPollingEnabled: boolean;
  promptPollingOverride: boolean | null;
  prewarmLimit: number;
  prewarmLimitOverride: number | null;
  hooksEnabled: boolean;
  hooksOverride: boolean | null;
}

/** The whole page of the settings: the master switches and every harness. */
export interface HarnessRuntimeView {
  ok: true;
  pollingEnabled: boolean;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
  harnesses: HarnessRuntimeHarnessView[];
}

/** Build the page view: every known adapter plus every harness that carries
 * an override, each with its effective switches and its overrides. */
export function harnessRuntimeView(
  document: HarnessRuntimeSettingsDocument,
  adapters: Iterable<{ id: string; name?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): HarnessRuntimeView {
  const ordered: { id: string; name: string | null }[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.id)) continue;
    seen.add(adapter.id);
    ordered.push({ id: adapter.id, name: typeof adapter.name === "string" && adapter.name ? adapter.name : null });
  }
  for (const harness of Object.keys(document.harnesses).sort()) {
    if (!seen.has(harness)) {
      seen.add(harness);
      ordered.push({ id: harness, name: null });
    }
  }
  return {
    ok: true,
    pollingEnabled: document.pollingEnabled,
    ...(document.changedAt ? { changedAt: document.changedAt } : {}),
    ...(document.changedBy ? { changedBy: document.changedBy } : {}),
    ...(document.reason ? { reason: document.reason } : {}),
    harnesses: ordered.map(({ id, name }) => {
      const entry = document.harnesses[id];
      return {
        id,
        name,
        pollingEnabled: harnessPollingEnabled(document, id),
        pollingOverride: entry?.pollingEnabled ?? null,
        promptPollingEnabled: harnessPromptPollingEnabled(document, id),
        promptPollingOverride: entry?.promptPollingEnabled ?? null,
        prewarmLimit: harnessPrewarmLimit(document, id, env),
        prewarmLimitOverride: entry?.prewarmLimit ?? null,
        hooksEnabled: harnessHooksEnabled(document, id),
        hooksOverride: entry?.hooksEnabled ?? null,
      };
    }),
  };
}
