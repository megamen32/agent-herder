import { open, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { MINIMAX_CODE_SESSION_STORE } from "../adapters/minimax-code-store.js";
import { getHumanStopStore, type HumanStopStore } from "../human-stop-store.js";
import { addressKey, parseNativeReceipt, type MeshSession, type NativeReceipt } from "./protocol.js";
import type { MeshDelivery } from "./gptadmin.js";
import type { MeshDeliveryLedger } from "./delivery-ledger.js";

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
  const directories = enumerated.sort().reverse().slice(0, MAX_SCAN_DIRECTORIES);
  const sessions: MeshSession[] = [];
  const seen = new Set<string>();
  let found = 0;
  for (const dir of directories) {
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    const manifest = await readJson<MinimaxManifest>(join(dir, "manifest.json"), MAX_MANIFEST_BYTES);
    const id = manifest?.sessionId ?? decodeSessionKey(name);
    if (!id) continue;
    if (nativeSessionId && id !== nativeSessionId) continue;
    found += 1;
    const record = (await readBoundedObject(join(dir, "snapshot.json"), "record", MAX_SNAPSHOT_BYTES)) as MinimaxSnapshotRecord | null;
    // A record of another session never describes this one.
    const trusted = record && (!record.sessionId || record.sessionId === id) ? record : null;
    const createdAtMs = manifest?.createdAtMs ?? trusted?.createdAtMs ?? timestampFromPath(dir) ?? 0;
    const updatedAtMs = manifest?.updatedAtMs ?? trusted?.updatedAtMs ?? createdAtMs;
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
  return { sessions: limited, complete: enumerated.length <= MAX_ENUMERATED_DIRECTORIES && found <= limit };
}

/** One bounded admission into the live MiniMax Code runtime. */
export interface MinimaxCodeAdmission {
  ok: boolean;
  admitted?: boolean;
  turnId?: string;
  admissionUnknown?: boolean;
  error?: string;
}

/** Writer of one native MiniMax Code message. */
export interface MinimaxCodeDeliveryPort {
  /** Queue one message; the receipt must name the admitted turn or queue item. */
  enqueue(id: string, message: string, inputId: string): Promise<MinimaxCodeAdmission>;
}

/** Everything the native delivery lane needs beside the request itself. */
export interface MinimaxCodeDeliveryDeps {
  port: MinimaxCodeDeliveryPort;
  /** Durable intent ledger; the wrapping delivery entry point owns it. */
  ledger?: MeshDeliveryLedger;
  /** Independent native observation; the writer alone never proves identity. */
  observe: (id: string) => Promise<MinimaxCodeObservation | null>;
  stopStore?: HumanStopStore;
  /** Injects the active coordination notes of the target into the message. */
  notes?: (session: { id: string; harness: string; cwd: string; hostId?: string }, message: string) => Promise<string>;
}

/**
 * Deliver one bounded delta into a native MiniMax Code session.
 *
 * The admission must be proven: a confirmed receipt is `admitted`, an
 * unproven one is `unknown` and is never replayed, and a refused one stays
 * `not_attempted`.
 */
export async function deliverMinimaxCode(
  request: MeshDelivery,
  deps: MinimaxCodeDeliveryDeps & { ledger: MeshDeliveryLedger },
): Promise<NativeReceipt & { reason?: string }> {
  return deps.ledger.once(request, () => runMinimaxCodeDelivery(request, deps));
}

/**
 * The delivery itself, without the durable intent ledger around it.
 *
 * A caller that keeps its own ledger uses this one, so one intent is never
 * recorded twice.
 */
export async function runMinimaxCodeDelivery(
  request: MeshDelivery,
  deps: MinimaxCodeDeliveryDeps,
): Promise<NativeReceipt & { reason?: string }> {
  addressKey(request.target);
  addressKey(request.sender);
  const rejected = (reason: string) => ({ state: "not_attempted" as const, inputId: request.inputId, retryable: true, reason });
  if (request.target.harness !== MINIMAX_CODE_HARNESS) return rejected("native_transport_not_registered");
  const stops = deps.stopStore ?? getHumanStopStore();
  if (await stops.isHeld(MINIMAX_CODE_HARNESS, request.target.nativeSessionId)) return rejected("human_stopped_native_session");
  const observation = await deps.observe(request.target.nativeSessionId).catch(() => null);
  if (!observation || observation.nativeSessionId !== request.target.nativeSessionId) return rejected("independent_native_identity_unknown");
  const source = `Источник: ${request.sender.hostId} / ${request.sender.harness} / ${request.sender.nativeSessionId}.\n${request.message}`;
  const message = deps.notes
    ? await deps.notes({ id: request.target.nativeSessionId, harness: MINIMAX_CODE_HARNESS, cwd: observation.cwd ?? "", hostId: request.target.hostId }, source)
    : source;
  let admission: MinimaxCodeAdmission;
  try {
    admission = await deps.port.enqueue(request.target.nativeSessionId, message, request.inputId);
  } catch {
    // A writer that failed without an answer leaves the admission unproven.
    return { state: "unknown", inputId: request.inputId, retryable: false, reason: "native_admission_unknown" };
  }
  return parseNativeReceipt({
    ...admission,
    admitted: admission.ok === true && admission.admitted === true,
    inputId: request.inputId,
  }, request.inputId);
}
