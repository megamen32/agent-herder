import { copyFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The one durable state directory shared by the daemon, the Stop hook and the runner. */
export const AUTOPILOT_STATE_DIR_NAME = "autopilot-live";

/** Earlier server default; its durable files are adopted once and never overwritten. */
export const LEGACY_AUTOPILOT_STATE_DIR_NAME = "autopilot";

/**
 * Durable registries and policy files worth adopting from the earlier default.
 *
 * `receipts.json` and `armed-sessions.json` are durable state, not caches: the
 * core uses the receipt store for terminal deduplication and as the pending
 * notice outbox, and the Stop hook uses the armed set as its admission list.
 * Losing either would re-judge finished turns or drop a pending notice.
 */
const ADOPTED_STATE_FILES = [
  "choices.json",
  "human-requests.json",
  "receipts.json",
  "armed-sessions.json",
  "sessions.json",
  "autopilot-policy.json",
  "unfinished-sessions.json",
  "session-autostart.json",
  "automation-launch-policy.json",
] as const;

/**
 * Registries merged when both directories are populated, each by its own
 * verified key. Skipping one would silently drop an unanswered human question,
 * a terminal decision or a pending notice.
 */
const MERGED_REGISTRY_KINDS = {
  "choices.json": "records",
  "human-requests.json": "records",
  // Terminal decisions and the pending notice outbox.
  "receipts.json": "entries",
  // The Stop hook admission set: the union of both armed lists.
  "armed-sessions.json": "strings",
} as const;

type RegistryKind = (typeof MERGED_REGISTRY_KINDS)[keyof typeof MERGED_REGISTRY_KINDS];

/** File whose verified shape did not allow a merge. */
export class AutopilotStateMergeError extends Error {
  readonly code = "AUTOPILOT_STATE_MERGE_REFUSED";
}

/** Lock files are process-owned and are never adopted or merged. */
const NEVER_ADOPTED_STATE_FILES = ["state.lock"] as const;

/**
 * The single Autopilot state seam.
 *
 * The daemon, the Stop hook and the runner must agree, otherwise a per-session
 * switch written through one process is invisible to the other and a pending
 * question or choice is invisible to the resume port. An explicit environment
 * override always wins; otherwise every entrypoint resolves the same directory.
 */
export function resolveAutopilotStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENT_HERDER_AUTOPILOT_STATE_DIR?.trim();
  if (configured) return configured;
  return join(env.HOME?.trim() || homedir(), ".local", "state", "agent-herder", AUTOPILOT_STATE_DIR_NAME);
}

/**
 * The directory to merge from.
 *
 * An explicitly configured legacy directory is always honoured: that is the
 * operator-declared seam for two populated directories. Otherwise the earlier
 * server default is adopted only while the canonical directory is unpinned, so
 * a deployment that pins its own state directory never pulls anything in.
 */
export function legacyAutopilotStateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR?.trim();
  if (configured) return configured;
  if (env.AGENT_HERDER_AUTOPILOT_STATE_DIR?.trim()) return undefined;
  return join(env.HOME?.trim() || homedir(), ".local", "state", "agent-herder", LEGACY_AUTOPILOT_STATE_DIR_NAME);
}

/** Resolve the durable Human Request registry shared by every Autopilot entrypoint. */
export function resolveHumanRequestStorePath(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HERDER_HUMAN_REQUEST_STORE?.trim() || join(stateDir, "human-requests.json");
}

/** The pre-seam registry location that shipped as a working-directory relative default. */
function legacyHumanRequestStorePath(env: NodeJS.ProcessEnv): string {
  return join(env.AGENT_HERDER_LEGACY_WORKING_DIRECTORY?.trim() || process.cwd(), ".agent-herder", "human-requests.json");
}

/**
 * Adopt pre-seam state without losing or rewriting anything.
 *
 * Adoption is exclusive and atomic: an existing canonical file always wins, so
 * a restart never resets live sessions, pending questions or choices. Returns
 * the canonical file paths that were adopted.
 */
export async function adoptLegacyAutopilotState(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  await mkdir(stateDir, { recursive: true });
  const adopted: string[] = [];
  const legacyDir = legacyAutopilotStateDir(env);
  if (legacyDir) {
    for (const name of ADOPTED_STATE_FILES) {
      const canonical = join(stateDir, name);
      if (await mergeLegacyFile(join(legacyDir, name), canonical, name)) adopted.push(canonical);
    }
  }
  const canonicalHumanRequests = resolveHumanRequestStorePath(stateDir, env);
  if (env.AGENT_HERDER_HUMAN_REQUEST_STORE?.trim()) return adopted;
  if (await mergeLegacyFile(legacyHumanRequestStorePath(env), canonicalHumanRequests, "human-requests.json")) {
    adopted.push(canonicalHumanRequests);
  }
  return adopted;
}

/**
 * Bring one legacy file into the canonical directory without losing records.
 *
 * An absent canonical file is adopted as-is. When both directories are
 * populated, only the two question registries are merged, and only by a
 * verified record identity: the canonical record always wins, a legacy-only
 * record is appended, and an unrecognized shape is left untouched.
 */
async function mergeLegacyFile(source: string, canonical: string, name: string): Promise<boolean> {
  if (normalizePath(source) === normalizePath(canonical)) return false;
  if (!await isRegularFile(source)) return false;
  if (!await exists(canonical)) return adoptFile(source, canonical);
  const kind = MERGED_REGISTRY_KINDS[name as keyof typeof MERGED_REGISTRY_KINDS];
  if (!kind) return false;
  const [legacy, current] = await Promise.all([readRegistry(source, kind), readRegistry(canonical, kind)]);
  if (!legacy || !current) return false;
  const merged = kind === "records"
    ? mergeRecordRegistry(legacy, current)
    : kind === "entries"
      ? mergeEntryRegistry(legacy, current)
      : mergeStringSet(legacy, current);
  if (merged === undefined) return false;
  await writeMergedRecords(canonical, merged);
  return true;
}

/** Canonical wins per request identity; a legacy-only question is appended. */
function mergeRecordRegistry(
  legacy: RegistryRead,
  current: RegistryRead,
): Record<string, unknown> | undefined {
  const identities = new Set(
    current.records.map((record) => (record as { requestId?: unknown }).requestId).filter((id): id is string => typeof id === "string"),
  );
  const missing = legacy.records.filter((record) => !identities.has((record as { requestId?: unknown }).requestId as string));
  if (missing.length === 0) return undefined;
  return { ...current.raw, requests: [...current.records, ...missing] };
}

/** Canonical wins per receipt key: a legacy terminal decision or notice never overwrites it. */
function mergeEntryRegistry(
  legacy: RegistryRead,
  current: RegistryRead,
): Record<string, unknown> | undefined {
  const missing = legacy.records.filter((key) => !(key as string in current.raw));
  if (missing.length === 0) return undefined;
  const merged: Record<string, unknown> = { ...current.raw };
  for (const key of missing) merged[key as string] = legacy.raw[key as string];
  return merged;
}

/** The armed admission set is the union of both directories, in its own shape. */
function mergeStringSet(
  legacy: RegistryRead,
  current: RegistryRead,
): unknown[] | Record<string, unknown> | undefined {
  const existing = new Set(current.records);
  const missing = legacy.records.filter((value) => !existing.has(value));
  if (missing.length === 0) return undefined;
  if (Array.isArray(legacy.parsed) && Array.isArray(current.parsed)) return [...current.parsed, ...missing];
  if (Array.isArray(current.parsed) || Array.isArray(legacy.parsed)) return undefined;
  const merged: Record<string, unknown> = { ...current.raw };
  for (const value of missing) merged[value as string] = true;
  return merged;
}

/** Copy one legacy file into place only when the canonical file does not exist yet. */
async function adoptFile(source: string, canonical: string): Promise<boolean> {
  await mkdir(join(canonical, ".."), { recursive: true });
  const temporary = join(join(canonical, ".."), `.${nameOf(canonical)}.adopt.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    try {
      // A hard link is atomic and never replaces an existing canonical file.
      await link(temporary, canonical);
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
      await copyFile(temporary, canonical, constants.COPYFILE_EXCL);
    }
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

interface RegistryRead {
  /** The exact parsed document, so a merge can preserve its own shape. */
  parsed: unknown;
  raw: Record<string, unknown>;
  records: unknown[];
}

/** Read a known registry by its verified shape, or undefined when it is not verified. */
async function readRegistry(path: string, kind: RegistryKind): Promise<RegistryRead | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  // The armed admission set is the only registry stored as a JSON list.
  if (kind === "strings" && Array.isArray(parsed)) {
    if (!parsed.every((value) => typeof value === "string" && value.length > 0)) return undefined;
    return { parsed, raw: { list: parsed }, records: parsed };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (kind === "records") {
    const file = parsed as { version?: unknown; requests?: unknown };
    if (file.version !== 1 || !Array.isArray(file.requests)) return undefined;
    const records: unknown[] = [];
    for (const entry of file.requests) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const record = entry as Record<string, unknown>;
      if (typeof record.requestId !== "string" || record.requestId.length === 0) return undefined;
      if (typeof record.status !== "string" || record.status.length === 0) return undefined;
      records.push(entry);
    }
    return { parsed, raw: file as Record<string, unknown>, records };
  }
  if (kind === "entries") {
    // A receipt store is a flat map of receipt key to terminal decision.
    const entries = Object.entries(parsed);
    if (entries.some(([, value]) => !value || typeof value !== "object" || typeof (value as Record<string, unknown>).kind !== "string")) {
      return undefined;
    }
    return { parsed, raw: parsed as Record<string, unknown>, records: entries.map(([key]) => key) };
  }
  if (!Object.values(parsed).every((value) => value === true)) return undefined;
  return { parsed, raw: parsed as Record<string, unknown>, records: Object.keys(parsed) };
}

/** Publish a merged registry atomically and keep the previous canonical copy. */
async function writeMergedRecords(path: string, value: unknown): Promise<void> {
  const directory = join(path, "..");
  const temporary = join(directory, `.${nameOf(path)}.merge.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await copyFile(path, `${path}.pre-merge`).catch(() => undefined);
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || "state";
}

/** Files that are process-owned and never adopted; exported so tests agree on the seam. */
export const AUTOPILOT_NEVER_ADOPTED_STATE_FILES: readonly string[] = NEVER_ADOPTED_STATE_FILES;