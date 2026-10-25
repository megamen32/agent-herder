import { open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { HarnessAdapter, HarnessPermissionState } from "../types/index.js";

type PermissionResponse = "allow" | "deny";
type ReplyState = "claimed" | "accepted" | "rejected" | "unknown";
interface ReplyEntry {
  kind?: "reply";
  hostId: string;
  harness: string;
  sessionId: string;
  requestId: string;
  response: PermissionResponse;
  state: ReplyState;
  updatedAt: string;
}
type ModeState = "claimed" | "accepted" | "unknown";
interface ModeEntry {
  kind: "mode";
  hostId: string;
  harness: string;
  sessionId: string;
  inputId: string;
  expectedCurrentMode: string;
  mode: string;
  state: ModeState;
  observedAt?: string;
  error?: string;
  updatedAt: string;
}
type ReplyLedger = Record<string, ReplyEntry | ModeEntry>;

function ledgerPath(): string {
  return process.env.AGENT_HERDER_PERMISSION_REPLY_LEDGER
    || join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || join(homedir(), ".local", "state", "agent-herder"), "permission-replies.json");
}

function keyOf(hostId: string, harness: string, sessionId: string, requestId: string): string {
  return JSON.stringify([hostId, harness, sessionId, requestId]);
}

function modeKeyOf(hostId: string, harness: string, sessionId: string, inputId: string): string {
  // A fifth, typed key segment keeps existing permission-reply readers from
  // ever interpreting a mode receipt as an answer to a native request.
  return JSON.stringify(["mode", hostId, harness, sessionId, inputId]);
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

async function observeNativeTarget(
  adapter: HarnessAdapter,
  harness: string,
  sessionId: string,
  requestId: string,
  expectedHostId?: string,
): Promise<{ hostId: string; pending: boolean } | undefined> {
  if (!adapter.getPermissionState) return undefined;
  const state = await adapter.getPermissionState(sessionId);
  if (!state || state.target.harness !== harness || state.target.sessionId !== sessionId
    || !state.target.hostId || (expectedHostId !== undefined && state.target.hostId !== expectedHostId)) return undefined;
  const pendingRequest = state.pendingRequests.find((request) => request.id === requestId);
  return { hostId: state.target.hostId, pending: Boolean(pendingRequest) && pendingRequest?.canRespond === true };
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
  expectedHostId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!adapter.getPermissionState) return { ok: false, error: "Typed native permission state is unavailable." };
  const path = ledgerPath();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  const handle = await open(path, "a", 0o600);
  await handle.close();
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
  try {
    let observed: { hostId: string; pending: boolean } | undefined;
    try { observed = await observeNativeTarget(adapter, harness, sessionId, requestId, expectedHostId); }
    catch { return { ok: false, error: "Could not verify the current native permission state." }; }
    if (!observed) return { ok: false, error: "The permission request does not belong to this native session." };
    const ledger = await readLedger(path);
    const key = keyOf(observed.hostId, harness, sessionId, requestId);
    const prior = ledger[key] as ReplyEntry | undefined;
    if (prior) {
      if (prior.state === "accepted" && prior.response === response) return { ok: true };
      return { ok: false, error: prior.response === response
        ? "This permission response was already attempted and will not be replayed."
        : "A different response was already admitted for this permission request." };
    }
    if (!observed.pending) return { ok: false, error: "The permission request is no longer pending for this native session." };

    const entry: ReplyEntry = {
      hostId: observed.hostId,
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
    entry.state = result.ok ? "accepted" : "unknown";
    entry.updatedAt = new Date().toISOString();
    await writeLedger(path, ledger);
    return result;
  } finally {
    await release();
  }
}

function sameModePayload(entry: ModeEntry, input: {
  hostId: string; harness: string; sessionId: string; inputId: string;
  expectedCurrentMode: string; mode: string;
}): boolean {
  return entry.kind === "mode" && entry.hostId === input.hostId && entry.harness === input.harness
    && entry.sessionId === input.sessionId && entry.inputId === input.inputId
    && entry.expectedCurrentMode === input.expectedCurrentMode && entry.mode === input.mode;
}

function exactModeState(
  state: HarnessPermissionState | null,
  input: { hostId: string; harness: string; sessionId: string },
): state is HarnessPermissionState {
  return Boolean(state && state.target.hostId === input.hostId && state.target.harness === input.harness
    && state.target.sessionId === input.sessionId);
}

/**
 * Change one exact session's native mode once. Reusing the permission reply
 * ledger lock and atomic write keeps mode changes separate from reply records
 * while making an ambiguous native outcome terminal for this inputId.
 */
export async function setNativePermissionModeOnce(
  adapter: HarnessAdapter,
  input: {
    hostId: string;
    harness: string;
    sessionId: string;
    inputId: string;
    expectedCurrentMode: string;
    mode: string;
  },
): Promise<{ ok: boolean; state: "accepted" | "unknown" | "not_attempted"; permissionState?: HarnessPermissionState; error?: string; duplicate?: boolean }> {
  if (!adapter.getPermissionState || typeof adapter.setPermissions !== "function") {
    return { ok: false, state: "not_attempted", error: "Native permission mode control is unavailable." };
  }
  const path = ledgerPath();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  const handle = await open(path, "a", 0o600);
  await handle.close();
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
  try {
    const ledger = await readLedger(path);
    const key = modeKeyOf(input.hostId, input.harness, input.sessionId, input.inputId);
    const prior = ledger[key] as ModeEntry | undefined;
    if (prior) {
      if (!sameModePayload(prior, input)) {
        return { ok: false, state: "unknown", error: "This inputId was already used for a different permission mode request.", duplicate: true };
      }
      if (prior.state === "accepted") {
        return { ok: true, state: "accepted", duplicate: true };
      }
      return { ok: false, state: "unknown", error: "This permission mode change was already attempted; its native outcome is unknown and it will not be replayed.", duplicate: true };
    }

    let before: HarnessPermissionState | null;
    try { before = await adapter.getPermissionState(input.sessionId); }
    catch { return { ok: false, state: "not_attempted", error: "Could not verify the current native permission state." }; }
    if (!exactModeState(before, input)) return { ok: false, state: "not_attempted", error: "The permission state does not belong to this exact native host and session." };
    if (before.scope !== "session") return { ok: false, state: "not_attempted", permissionState: before, error: "Permission mode changes are supported only for this session." };
    if (!before.canSetMode || !before.supportedModes?.includes(input.mode)) {
      return { ok: false, state: "not_attempted", permissionState: before, error: "This native session does not support the requested permission mode." };
    }
    if (before.currentMode !== input.expectedCurrentMode) {
      return { ok: false, state: "not_attempted", permissionState: before, error: "The current permission mode changed. Refresh the session state before choosing again." };
    }
    if (input.mode === input.expectedCurrentMode) {
      return { ok: false, state: "not_attempted", permissionState: before, error: "The requested permission mode is already active." };
    }
    if (before.pendingRequests.length > 0) {
      return { ok: false, state: "not_attempted", permissionState: before, error: "Resolve pending permission requests before changing the session mode." };
    }

    const entry: ModeEntry = {
      kind: "mode",
      hostId: input.hostId,
      harness: input.harness,
      sessionId: input.sessionId,
      inputId: input.inputId,
      expectedCurrentMode: input.expectedCurrentMode,
      mode: input.mode,
      state: "claimed",
      updatedAt: new Date().toISOString(),
    };
    ledger[key] = entry;
    await writeLedger(path, ledger);

    let callError: string | undefined;
    try {
      const result = await adapter.setPermissions(input.sessionId, { mode: input.mode });
      if (!result.ok) callError = result.error || "Native permission mode call did not confirm success.";
    } catch (error) {
      callError = error instanceof Error ? error.message : String(error);
    }

    let after: HarnessPermissionState | null = null;
    try { after = await adapter.getPermissionState(input.sessionId); }
    catch (error) { callError ??= error instanceof Error ? error.message : String(error); }
    if (exactModeState(after, input) && after.scope === "session" && after.currentMode === input.mode) {
      entry.state = "accepted";
      entry.observedAt = after.observedAt;
    } else {
      entry.state = "unknown";
      entry.error = callError || "Exact native permission mode readback did not confirm the requested mode.";
    }
    entry.updatedAt = new Date().toISOString();
    await writeLedger(path, ledger);
    if (entry.state === "accepted") return { ok: true, state: "accepted", permissionState: after!, duplicate: false };
    return { ok: false, state: "unknown", error: "The native permission mode outcome could not be confirmed; it will not be replayed.", ...(exactModeState(after, input) ? { permissionState: after } : {}), duplicate: false };
  } finally {
    await release();
  }
}
