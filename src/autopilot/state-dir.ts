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
 * Record registries merged by request identity when both directories are
 * populated. Skipping one would silently drop an unanswered human question.
 */
const MERGED_RECORD_FILES: Readonly<Record<string, "choices" | "human-requests">> = {
  "choices.json": "choices",
  "human-requests.json": "human-requests",
};

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
  const mergeable = MERGED_RECORD_FILES[name];
  if (!mergeable) return false;
  const [legacy, current] = await Promise.all([readRecords(source, mergeable), readRecords(canonical, mergeable)]);
  if (!legacy || !current) return false;
  const identities = new Set(current.requests.map((record) => record.requestId));
  const missing = legacy.requests.filter((record) => !identities.has(record.requestId));
  if (missing.length === 0) return false;
  const merged = { version: 1, requests: [...current.requests, ...missing] };
  await writeMergedRecords(canonical, merged);
  return true;
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

/** Read a known record registry, or undefined when the shape is not verified. */
async function readRecords(
  path: string,
  kind: "choices" | "human-requests",
): Promise<{ version: 1; requests: Array<Record<string, unknown> & { requestId: string }> } | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const file = parsed as { version?: unknown; requests?: unknown };
  if (file.version !== 1 || !Array.isArray(file.requests)) return undefined;
  const records: Array<Record<string, unknown> & { requestId: string }> = [];
  for (const entry of file.requests) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.requestId !== "string" || record.requestId.length === 0) return undefined;
    if (typeof record.status !== "string" || record.status.length === 0) return undefined;
    records.push(record as Record<string, unknown> & { requestId: string });
  }
  void kind;
  return { version: 1, requests: records };
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