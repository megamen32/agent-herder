/**
 * The client of the lever of the owner for the hook scripts.
 *
 * Every hook asks the herder whether it may forbid something before it
 * forbids it. The answer is fail-open in every failure: an unreachable
 * service, a timeout or an unknown state means the hook forbids nothing,
 * because a hook that cannot learn the decision of the owner must stay
 * quiet rather than guess. The owner complained exactly about this: a hook
 * that does not work still gets in the way.
 *
 * Every failure is written to the journal of the hook, so the owner can see
 * why a hook did nothing. The journal is a trail, never a gate.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The default address of the herder on the node. */
export const DEFAULT_HERDER_ENDPOINT = "http://127.0.0.1:18787";

/** The read of the state is short: the hook must not hold the session. */
export const READ_TIMEOUT_MS = 1200;

/** The address of the herder the hook asks. */
export function herderEndpoint(env = process.env) {
  return env.AGENT_HERDER_URL?.trim() || DEFAULT_HERDER_ENDPOINT;
}

/** The directory of the journal of the hooks. */
export function hooksStateDir(env = process.env) {
  return env.AGENT_HERDER_HOOK_STATE_DIR?.trim()
    || join(env.HOME?.trim() || homedir(), ".local", "state", "agent-herder", "hooks");
}

/**
 * Append one line to the journal of the hook.
 *
 * The journal is a trail, not a gate: a failed write never fails the hook.
 */
export async function journal(kind, record) {
  try {
    const directory = hooksStateDir();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(
      join(directory, `${kind}.jsonl`),
      `${JSON.stringify({ at: new Date().toISOString(), hook: kind, ...record })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // The journal must never break the session.
  }
}

/**
 * Ask the herder whether the optional hooks runtime runs, and whether this
 * hook may forbid something.
 *
 * Two answers come back. `hooksEnabled` says whether the optional hooks
 * runtime of the herder runs at all: while it is off, the hook does nothing
 * — it does not forbid anything and it does not carry any context into the
 * session. `enabled` says whether this hook may forbid something, which also
 * needs the runtime to be on and this hook to be named in no disabled set.
 *
 * The answer is fail-open in every failure: an unreachable service, a timeout
 * or an unknown state means the hook does nothing, because a hook that cannot
 * learn the decision of the owner must stay quiet rather than guess. The
 * owner complained exactly about this: a hook that does not work still gets
 * in the way.
 *
 * Every failure is written to the journal of the hook, so the owner can see
 * why a hook did nothing. The journal is a trail, never a gate.
 */
export async function readProhibitions(kind, options = {}) {
  const endpoint = options.endpoint ?? herderEndpoint();
  try {
    const response = await fetch(`${endpoint}/api/hooks/prohibitions?kind=${encodeURIComponent(kind)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the herder answered ${response.status}`);
    const body = await response.json();
    const known = body?.known === true;
    const disabled = Array.isArray(body?.disabledHooks) ? body.disabledHooks : [];
    // The whole optional runtime first: while it is off, no hook runs.
    const hooksEnabled = known && body?.hooksEnabled === true;
    // The hook itself may be switched off on its own, even when the runtime
    // of the other hooks is on.
    const active = hooksEnabled && body?.active === true;
    const enabled = active && body?.prohibitionsEnabled === true && !disabled.includes(kind);
    if (!known) {
      await journal(kind, {
        event: "state-unknown",
        reason: typeof body?.reason === "string" && body.reason ? body.reason : "the herder did not name the state",
      });
    }
    return {
      known,
      hooksEnabled,
      active,
      enabled,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
    };
  } catch (error) {
    await journal(kind, { event: "state-unavailable", reason: String(error?.message ?? error) });
    return { known: false, hooksEnabled: false, active: false, enabled: false, reason: "состояние запретов хуков недоступно" };
  }
}

/**
 * Report to the herder that the hook fired or refused something.
 *
 * The report is best effort: it never fails the session. Only a refusal
 * carries a reason; an ordinary firing is a timestamp.
 */
export async function reportActivity(kind, payload = {}, options = {}) {
  const endpoint = options.endpoint ?? herderEndpoint();
  try {
    const response = await fetch(`${endpoint}/api/hooks/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook: kind, ...payload }),
      signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
