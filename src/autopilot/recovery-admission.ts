import { open } from "node:fs/promises";
import type { AgentSession } from "../types/index.js";

export type RecoveryOperation = "attempt" | "resume" | "send" | "rollover" | "create";
export type RecoveryAdmission = { allowed: true } | { allowed: false; reason: string };
export type RecoveryAdmissionGate = (session: AgentSession, operation: RecoveryOperation) => Promise<RecoveryAdmission>;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
export const FLEET_MONITOR_STATE = "/home/roomhacker/ServersAdministartion/.tmp/fleet-codex-watch-20261007/monitor/state.json";

/** The existing fleet registry remains authoritative; this gate never clears or copies blockers. */
export function evaluateFleetAdmission(state: unknown, session: Pick<AgentSession, "id">, now = Date.now(), maxAgeMs = 30 * 60_000): RecoveryAdmission {
  if (!state || typeof state !== "object" || Array.isArray(state)) return { allowed: false, reason: "Fleet admission state is unavailable" };
  const value = state as Record<string, unknown>;
  const observed = typeof value.utc === "string" ? Date.parse(value.utc) : NaN;
  if (!Number.isFinite(observed) || now - observed > maxAgeMs || observed > now + 60_000) return { allowed: false, reason: "Fleet admission observation is stale or invalid" };
  const heavy = value.heavy;
  if (heavy && typeof heavy === "object" && !Array.isArray(heavy)
    && (heavy as Record<string, unknown>).admission === "DENIED") {
    return { allowed: false, reason: "Existing fleet resource admission is denied" };
  }
  const registry = value.registry;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return { allowed: false, reason: "Fleet admission registry is unavailable" };
  const target = (registry as Record<string, unknown>)[session.id];
  if (!target || typeof target !== "object" || Array.isArray(target)) return { allowed: false, reason: "Session has no fleet recovery authorization" };
  const entry = target as Record<string, unknown>;
  if (entry.taskState !== "active") return { allowed: false, reason: "Fleet task is paused, blocked, completed, or awaiting integration" };
  for (const field of ["recoveryBlockedReason", "resourceBlockedReason", "stdioBlocker"]) {
    if (typeof entry[field] === "string" && entry[field].trim()) return { allowed: false, reason: `Fleet task retains ${field}` };
  }
  return { allowed: true };
}

/** Re-read the existing protected snapshot at each admission boundary; errors hold recovery. */
export function createFleetRecoveryAdmissionGate(path = FLEET_MONITOR_STATE, now: () => number = Date.now): RecoveryAdmissionGate {
  return async (session, operation) => {
    if (operation === "create" || operation === "rollover") {
      return { allowed: false, reason: "Fleet authority permits existing-session recovery only" };
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, "r");
      const size = (await file.stat()).size;
      if (size < 1 || size > MAX_STATE_BYTES) return { allowed: false, reason: "Fleet admission state exceeds its budget" };
      // Read at most the inspected budget even if another writer grows the file.
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== size) return { allowed: false, reason: "Fleet admission state changed during read" };
      return evaluateFleetAdmission(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), session, now());
    } catch {
      return { allowed: false, reason: "Fleet admission state cannot be verified" };
    } finally {
      await file?.close();
    }
  };
}
