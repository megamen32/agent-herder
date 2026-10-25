import { open, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { MINIMAX_CODE_SESSION_STORE } from "../adapters/minimax-code-store.js";
import { addressKey, type MeshSession } from "./protocol.js";

/** Harness name of a native MiniMax Code session. */
export const MINIMAX_CODE_HARNESS = "minimax-code";
/** Upper bound of the manifest bytes read from one session directory. */
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Upper bound of the snapshot prefix read for the metadata record. */
const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** Upper bound of the published title. */
const MAX_TITLE_LENGTH = 160;
/** Upper bound of session directories one observation pass may read. */
const MAX_SCAN_DIRECTORIES = 96;
/** Hard bound of the enumeration itself, so a huge store cannot stall a pass. */
const MAX_ENUMERATED_DIRECTORIES = 4096;

interface MinimaxManifest {
  sessionId?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  source?: string;
  layout?: string;
}

interface MinimaxSnapshotRecord {
  sessionId?: string;
  workspaceDir?: string;
  title?: string;
  status?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

/** Store of one native MiniMax Code session, as the observer may prove it. */
export interface MinimaxCodeObservation {
  nativeSessionId: string;
  status: string;
  /** Working directory the store confirms, when the store confirms one. */
  cwd?: string | null;
}

async function readJson<T>(path: string, maxBytes: number): Promise<T | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) return null;
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as T;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Read one top-level object out of a bounded prefix of a file.
 *
 * The session snapshot carries the transcript next to its metadata record, so
 * the whole file is never read: only the prefix that holds the record is, and
 * the record is extracted by brace balance instead of a full parse.
 */
async function readBoundedObject(path: string, key: string, maxBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, maxBytes);
      if (length <= 0) return null;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const text = buffer.toString("utf8");
      const marker = `"${key}"`;
      const at = text.indexOf(marker);
      if (at < 0) return null;
      const start = text.indexOf("{", at + marker.length);
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The local runtime stores every session in a dated directory whose name ends
 * with the base64url encoded session id.
 */
function decodeSessionKey(directoryName: string): string | null {
  const marker = "-session_";
  const index = directoryName.lastIndexOf(marker);
  if (index < 0) return null;
  const encoded = directoryName.slice(index + marker.length);
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded.startsWith("mvs_") ? decoded : null;
  } catch {
    return null;
  }
}

/** Creation time encoded in the dated store path, when it can be read. */
function timestampFromPath(dir: string): number | null {
  const parts = dir.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const [year, month, day] = parts.slice(-4, -1);
  const time = parts[parts.length - 1]!.slice(0, 12);
  const match = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})$/.exec(time);
  if (!match) return null;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(match[1]), Number(match[2]), Number(match[3]));
  return Number.isFinite(at) ? at : null;
}

async function collectSessionDirectories(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Visit newest dated paths before the finite enumeration budget fills.
    entries.sort((a,b)=>b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.name.includes("-session_")) {
        found.push(full);
        if (found.length >= limit) return;
      } else {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** A title may never carry control characters and stays inside the budget. */
function safeTitle(value: unknown, fallback: string): string {
  const flat = typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!flat) return fallback;
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
}

/** The store never states a Herder status, so nothing is invented here. */
function observedStatus(value: unknown): string {
  switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
    case "running":
    case "active":
    case "in_progress":
      return "running";
    case "finished":
    case "completed":
    case "idle":
    case "done":
      return "idle";
    case "stopped":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "stopped";
    case "error":
    case "failed":
    case "failure":
      return "error";
    default:
      return "unknown";
  }
}

function safeCwd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.trim();
  if (!flat || flat.length > 4096 || /[\x00-\x1f\x7f]/.test(flat)) return null;
  return flat;
}

/**
 * Read-only observation of the native MiniMax Code sessions of one machine.
 *
 * Only metadata of the local runtime store is read: the manifest of a session
 * directory and, when the store keeps one, the metadata record of its
 * snapshot. The transcript is never read and never leaves this process, so a
 * published session carries no message text at all.
 *
 * A session that the store cannot describe stays discoverable: its status is
 * `unknown` and its project source is `unverified` instead of a guess.
 */
export async function observeMinimaxCode(
  limit = 12,
  sessionStore = process.env.MINIMAX_CODE_SESSION_STORE?.trim() || MINIMAX_CODE_SESSION_STORE,
  hostId = hostname(),
  nativeSessionId?: string,
): Promise<{ sessions: MeshSession[]; complete: boolean }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error("MiniMax Code discovery limit must be 1..12");
  const root = await stat(sessionStore).catch(() => null);
  if (!root?.isDirectory()) throw new Error(`MiniMax Code session store not found at ${sessionStore}`);
  // The dated store path orders the sessions chronologically, so the newest
  // window is read first instead of the oldest one.
  const enumerated = await collectSessionDirectories(sessionStore, MAX_ENUMERATED_DIRECTORIES);
  // A dated directory says when the session was created, not last used.
  // Stat metadata only: a long-running old session must survive the window.
  const candidates: Array<{dir:string;messageAt:number;manifest:MinimaxManifest|null;rankAt:number}> = [];
  const selected = enumerated.filter(dir => !nativeSessionId || decodeSessionKey(dir.slice(dir.lastIndexOf("/") + 1)) === nativeSessionId);
  for (let offset=0;offset<selected.length;offset+=32) {
    candidates.push(...await Promise.all(selected.slice(offset,offset+32).map(async dir => {
      const [manifest, messages] = await Promise.all([
        readJson<MinimaxManifest>(join(dir,"manifest.json"),MAX_MANIFEST_BYTES),
        stat(join(dir,"messages.jsonl")).catch(()=>null),
      ]);
      const messageAt = messages?.mtimeMs ?? 0;
      return {dir,manifest,messageAt,rankAt:Math.max(manifest?.updatedAtMs ?? manifest?.createdAtMs ?? timestampFromPath(dir) ?? 0,messageAt)};
    })));
  }
  candidates.sort((a,b) => b.rankAt - a.rankAt || b.dir.localeCompare(a.dir));
  const directories = candidates.slice(0, MAX_SCAN_DIRECTORIES);
  const sessions: MeshSession[] = [];
  const seen = new Set<string>();
  let found = 0;
  for (const {dir, messageAt, manifest} of directories) {
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    const id = manifest?.sessionId ?? decodeSessionKey(name);
    if (!id) continue;
    if (nativeSessionId && id !== nativeSessionId) continue;
    found += 1;
    const record = (await readBoundedObject(join(dir, "snapshot.json"), "record", MAX_SNAPSHOT_BYTES)) as MinimaxSnapshotRecord | null;
    // A record of another session never describes this one.
    const trusted = record && (!record.sessionId || record.sessionId === id) ? record : null;
    const createdAtMs = manifest?.createdAtMs ?? trusted?.createdAtMs ?? timestampFromPath(dir) ?? 0;
    const updatedAtMs = Math.max(manifest?.updatedAtMs ?? trusted?.updatedAtMs ?? createdAtMs, messageAt);
    const cwd = safeCwd(trusted?.workspaceDir);
    const address = { hostId, harness: MINIMAX_CODE_HARNESS, nativeSessionId: id };
    const key = addressKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({
      address,
      project: { launchCwd: cwd, currentCwd: cwd, source: cwd ? "native_session_store" : "unverified" },
      status: observedStatus(trusted?.status),
      title: safeTitle(trusted?.title, `MiniMax Code session ${id.slice(-8)}`),
      lastActivity: new Date(updatedAtMs || createdAtMs || 0).toISOString(),
      ...(createdAtMs ? { createdAt: new Date(createdAtMs).toISOString() } : {}),
    });
    // An exact lookup reads one session and stops.
    if (nativeSessionId) break;
  }
  sessions.sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
  const limited = sessions.slice(0, limit);
  // More sessions than the window or the limit means an incomplete answer.
  return { sessions: limited, complete: enumerated.length < MAX_ENUMERATED_DIRECTORIES && candidates.length <= MAX_SCAN_DIRECTORIES && found <= limit };
}
