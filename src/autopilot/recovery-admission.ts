import { open } from "node:fs/promises";
import type { AgentSession } from "../types/index.js";

export type RecoveryOperation = "attempt" | "resume" | "send" | "autopilot-send" | "rollover" | "create";
export type RecoveryAdmission = { allowed: true } | { allowed: false; reason: string };
export type RecoveryAdmissionGate = (session: AgentSession, operation: RecoveryOperation) => Promise<RecoveryAdmission>;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const WARNING_INTERVAL_MS = 10 * 60_000;
export const FLEET_MONITOR_STATE = "/home/roomhacker/ServersAdministartion/.tmp/fleet-codex-watch-20261007/monitor/state.json";

/**
 * The one-off Codex recovery campaign of 2026-10-07 produced FLEET_MONITOR_STATE
 * and nothing refreshes it since the campaign ended, so an enforced gate denies
 * every non-ZCode session forever without a word in the log. Retirement is an
 * explicit operator decision, never inferred from an unreadable snapshot.
 */
export function fleetAdmissionMode(env: NodeJS.ProcessEnv = process.env): "enforced" | "retired" {
  return String(env.AGENT_HERDER_FLEET_ADMISSION ?? "").trim().toLowerCase() === "retired" ? "retired" : "enforced";
}

/** The existing fleet registry remains authoritative; this gate never clears or copies blockers. */
export function evaluateFleetAdmission(state: unknown, session: Pick<AgentSession, "id">, now = Date.now(), maxAgeMs = 30 * 60_000, autopilotSend = false): RecoveryAdmission {
  if (!state || typeof state !== "object" || Array.isArray(state)) return { allowed: false, reason: "Fleet admission state is unavailable" };
  const value = state as Record<string, unknown>;
  const heavy = value.heavy;
  if (heavy && typeof heavy === "object" && !Array.isArray(heavy)
    && (heavy as Record<string, unknown>).admission === "DENIED") {
    return { allowed: false, reason: "Existing fleet resource admission is denied" };
  }
  const registry = value.registry;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return { allowed: false, reason: "Fleet admission registry is unavailable" };
  // The historical campaign owns only its registered sessions. An opted-in
  // semantic Stop delivery outside that campaign retains native budgets and
  // human fences, without needing enrolment in an unrelated recovery list.
  if (autopilotSend && !Object.hasOwn(registry, session.id)) return { allowed: true };
  const observed = typeof value.utc === "string" ? Date.parse(value.utc) : NaN;
  if (!Number.isFinite(observed) || now - observed > maxAgeMs || observed > now + 60_000) return { allowed: false, reason: "Fleet admission observation is stale or invalid" };
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
export function createFleetRecoveryAdmissionGate(
  path = FLEET_MONITOR_STATE,
  now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env,
): RecoveryAdmissionGate {
  const mode = fleetAdmissionMode(env);
  let warnedAt = 0;
  // A stale or missing snapshot silently defers every affected session, so the
  // reason is reported at most once per interval instead of being invisible.
  const reportSilentHold = (reason: string): void => {
    const stamp = now();
    if (stamp - warnedAt < WARNING_INTERVAL_MS) return;
    warnedAt = stamp;
    console.error(`[agent-herder] флотовый допуск кампании 07-10.2026 откладывает сессии без записи в журнал: ${reason} (снимок ${path}). Если кампания завершена, сними гейт явно: AGENT_HERDER_FLEET_ADMISSION=retired`);
  };
  return async (session, operation) => {
    if (operation === "create" || operation === "rollover") {
      return { allowed: false, reason: "Fleet authority permits existing-session recovery only" };
    }
    // This snapshot belongs to the one-off Codex recovery campaign, not to
    // ZCode task authority. ZCode native descendants retain their mandatory
    // shared systemd budget; policy/STOP/turn admission are checked by owners.
    if (session.harness === "zcode") return { allowed: true };
    if (mode === "retired") return { allowed: true };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, "r");
      const size = (await file.stat()).size;
      if (size < 1 || size > MAX_STATE_BYTES) {
        reportSilentHold("снимок пуст или превышает бюджет чтения");
        return { allowed: false, reason: "Fleet admission state exceeds its budget" };
      }
      // Read at most the inspected budget even if another writer grows the file.
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== size) {
        reportSilentHold("снимок изменился во время чтения");
        return { allowed: false, reason: "Fleet admission state changed during read" };
      }
      const admission = evaluateFleetAdmission(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), session, now(), undefined, operation === "autopilot-send");
      if (!admission.allowed) reportSilentHold(admission.reason);
      return admission;
    } catch {
      reportSilentHold("снимок недоступен или не разбирается");
      return { allowed: false, reason: "Fleet admission state cannot be verified" };
    } finally {
      await file?.close();
    }
  };
}
