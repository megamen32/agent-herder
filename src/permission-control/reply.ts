import { open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { AgentSession, HarnessAdapter } from "../types/index.js";

type PermissionResponse = "allow" | "deny";
type ReplyState = "claimed" | "accepted" | "rejected" | "unknown";
interface ReplyEntry {
  hostId: string;
  harness: string;
  sessionId: string;
  requestId: string;
  response: PermissionResponse;
  state: ReplyState;
  updatedAt: string;
}
type ReplyLedger = Record<string, ReplyEntry>;

function ledgerPath(): string {
  return process.env.AGENT_HERDER_PERMISSION_REPLY_LEDGER
    || join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || join(homedir(), ".local", "state", "agent-herder"), "permission-replies.json");
}

function keyOf(hostId: string, harness: string, sessionId: string, requestId: string): string {
  return JSON.stringify([hostId, harness, sessionId, requestId]);
}

async function readLedger(path: string): Promise<ReplyLedger> {
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ReplyLedger : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeLedger(path: string, ledger: ReplyLedger): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function isPending(session: AgentSession, requestId: string): boolean {
  if (!session.needsPermission) return false;
  if (session.permissionDetails?.id === requestId) return true;
  const pending = session.meta?.pendingRequestIds;
  return Array.isArray(pending) && pending.some((id) => id === requestId);
}

/**
 * Answer only an exact request from a fresh native session read. The durable
 * claim is written before the native call, so a crash or thrown transport
 * outcome can never cause an automatic replay.
 */
export async function respondToNativePermission(
  adapter: HarnessAdapter,
  harness: string,
  sessionId: string,
  requestId: string,
  response: PermissionResponse,
  remember = false,
): Promise<{ ok: boolean; error?: string }> {
  if (!adapter.getSession) return { ok: false, error: "Native session state is unavailable." };
  const path = ledgerPath();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  const handle = await open(path, "a", 0o600);
  await handle.close();
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
  try {
    let current: AgentSession | null;
    try {
      current = await adapter.getSession(sessionId);
    } catch {
      return { ok: false, error: "Could not verify the current native session." };
    }
    if (!current || current.id !== sessionId || current.harness !== harness || !current.hostId) {
      return { ok: false, error: "The permission request does not belong to this native session." };
    }
    const ledger = await readLedger(path);
    const key = keyOf(current.hostId, harness, sessionId, requestId);
    const prior = ledger[key];
    if (prior && prior.state !== "rejected") {
      if (prior.state === "accepted" && prior.response === response) return { ok: true };
      return { ok: false, error: prior.response === response
        ? "This permission response was already attempted and will not be replayed."
        : "A different response was already admitted for this permission request." };
    }
    if (!isPending(current, requestId)) {
      return { ok: false, error: "The permission request is no longer pending for this native session." };
    }

    const entry: ReplyEntry = {
      hostId: current.hostId,
      harness,
      sessionId,
      requestId,
      response,
      state: "claimed",
      updatedAt: new Date().toISOString(),
    };
    ledger[key] = entry;
    await writeLedger(path, ledger);

    let result: { ok: boolean; error?: string };
    try {
      result = await adapter.respondPermission(sessionId, requestId, response, remember);
    } catch {
      entry.state = "unknown";
      entry.updatedAt = new Date().toISOString();
      await writeLedger(path, ledger);
      return { ok: false, error: "The native response outcome is unknown; it will not be replayed." };
    }
    entry.state = result.ok ? "accepted" : "rejected";
    entry.updatedAt = new Date().toISOString();
    await writeLedger(path, ledger);
    return result;
  } finally {
    await release();
  }
}
