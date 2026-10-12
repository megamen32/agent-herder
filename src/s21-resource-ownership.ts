import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
const execute = promisify(execFile);
const harnesses = new Set(["codex", "claude", "opencode", "hermes", "zcode", "fast-agent", "qoder"]);
export type S21Ownership = {
  resource: "s21"; resourceHost: "roomhacker-server-100"; status: "free" | "held" | "unavailable";
  actor: null | { type: "agent" | "system" | "legacy"; harness: string | null; sessionId: string | null;
    sessionUrl: string | null; task: string; purpose: string; systemUnit: string | null; invocationId: string | null };
  expiresAt: string | null; remainingSeconds: number | null; observedAt: string; message: string | null;
};
const empty = (observedAt: string): S21Ownership => ({ resource: "s21", resourceHost: "roomhacker-server-100",
  status: "unavailable", actor: null, expiresAt: null, remainingSeconds: null, observedAt,
  message: "Не удалось проверить аренду телефона на сервере управления." });
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid state");
  return value;
};
export function parseS21Ownership(raw: string, observedAt = new Date().toISOString()): S21Ownership {
  if (Buffer.byteLength(raw) > 16384) throw new Error("oversized lease state");
  const value = JSON.parse(raw), result = empty(observedAt);
  if (value.status === "free") return { ...result, status: "free", message: null };
  if (value.status !== "held") throw new Error("invalid lease status");
  const task = text(value.owner, 100), purpose = text(value.purpose, 200), expiresAt = text(value.expires_at, 64);
  if (!Number.isFinite(Date.parse(expiresAt)) || !Number.isInteger(value.remaining_seconds) ||
      value.remaining_seconds < 0 || value.remaining_seconds > 14400) throw new Error("invalid expiry");
  const actor = value.actor, type = actor == null ? "legacy" : actor.type;
  if (!["legacy", "agent", "system"].includes(type)) throw new Error("invalid actor");
  let harness: string | null = null, sessionId: string | null = null;
  let systemUnit: string | null = null, invocationId: string | null = null;
  if (type === "agent") {
    harness = text(actor.harness, 20); sessionId = text(actor.session_id, 160);
    if (!harnesses.has(harness) || !/^[A-Za-z0-9_.:-]+$/.test(sessionId)) throw new Error("invalid session");
  } else if (type === "system") {
    systemUnit = text(actor.system_unit, 200); invocationId = text(actor.invocation_id, 32);
    if (!/^[A-Za-z0-9_.:@\\-]+\.service$/.test(systemUnit) || !/^[0-9a-f]{32}$/.test(invocationId)) throw new Error("invalid system origin");
  }
  // Allowlist only: never forward stored URLs, lease IDs or capabilities.
  return { ...result, status: "held", message: null, expiresAt, remainingSeconds: value.remaining_seconds,
    actor: { type, harness, sessionId, task, purpose, systemUnit, invocationId,
      sessionUrl: harness && sessionId ? `https://agent.bezrabotnyi.com/#/session/${encodeURIComponent(harness + ":" + sessionId)}` : null } };
}
export async function readS21Lease(): Promise<string> {
  if (hostname() === "roomhacker-server-100") {
    return (await execute("/usr/local/bin/s21-lease", ["status"], { timeout: 5000, maxBuffer: 16384 })).stdout;
  }
  return (await execute("ssh", ["-oBatchMode=yes", "-oConnectTimeout=3", "roomhacker@192.168.2.100",
    "test \"$(hostname)\" = roomhacker-server-100 && exec /usr/local/bin/s21-lease status"],
    { timeout: 5000, maxBuffer: 16384 })).stdout;
}
export async function getS21Ownership(read: () => Promise<string> = readS21Lease): Promise<S21Ownership> {
  const observedAt = new Date().toISOString();
  try { return parseS21Ownership(await read(), observedAt); } catch { return empty(observedAt); }
}
