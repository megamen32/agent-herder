import { copyFile, link, mkdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The one durable state directory shared by the daemon, the Stop hook and the runner. */
export const AUTOPILOT_STATE_DIR_NAME = "autopilot-live";

/** Earlier server default; its durable files are adopted once and never overwritten. */
export const LEGACY_AUTOPILOT_STATE_DIR_NAME = "autopilot";

/** Durable registries and policy files worth adopting from the earlier default. */
const ADOPTED_STATE_FILES = [
  "choices.json",
  "sessions.json",
  "autopilot-policy.json",
  "unfinished-sessions.json",
  "session-autostart.json",
  "automation-launch-policy.json",
  "human-requests.json",
] as const;

/** Turn caches are re-derived by a fresh process and are never adopted. */
const TRANSIENT_STATE_FILES = ["receipts.json", "armed-sessions.json", "state.lock"] as const;

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

/** The earlier server default, adopted once when it is not pinned explicitly. */
export function legacyAutopilotStateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENT_HERDER_AUTOPILOT_STATE_DIR?.trim()) return undefined;
  const configured = env.AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR?.trim();
  if (configured) return configured;
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
      if (await adoptOnce(join(legacyDir, name), canonical)) adopted.push(canonical);
    }
  }
  const canonicalHumanRequests = resolveHumanRequestStorePath(stateDir, env);
  if (env.AGENT_HERDER_HUMAN_REQUEST_STORE?.trim()) return adopted;
  if (await adoptOnce(legacyHumanRequestStorePath(env), canonicalHumanRequests)) adopted.push(canonicalHumanRequests);
  return adopted;
}

/** Copy one legacy file into place only when the canonical file does not exist yet. */
async function adoptOnce(source: string, canonical: string): Promise<boolean> {
  if (normalizePath(source) === normalizePath(canonical)) return false;
  if (!await isRegularFile(source)) return false;
  if (await exists(canonical)) return false;
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

/** Files a fresh process rebuilds; exported so callers and tests agree on the seam. */
export const AUTOPILOT_TRANSIENT_STATE_FILES: readonly string[] = TRANSIENT_STATE_FILES;