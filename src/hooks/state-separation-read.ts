import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { HOOK_KINDS } from "./catalog.js";
import { hookRuntimeActive } from "./service.js";
import type { HooksProhibitionsDocument } from "./state.js";
import {
  separateStates,
  type SeparationKey,
  type SeparationReading,
  type SeparatedStateView,
} from "./state-separation.js";

const execFileAsync = promisify(execFile);

/**
 * The emergency pause of Notice Place on this node.
 *
 * It is a system unit: it is never stopped, never changed and never disabled
 * by a rollout. The herder only reads it, exactly like the rollout reads it —
 * as information, without touching it.
 */
export const NOTICEPLACE_PAUSE_UNIT = "noticeplace-ai-pause.service";

/**
 * Read the emergency pause of Notice Place, read-only.
 *
 * The unit of a node that has no systemd reads as «неизвестно»: a pause that
 * cannot be seen must not look like a pause that is off.
 */
export async function readNetworkPauseReading(unit: string = NOTICEPLACE_PAUSE_UNIT): Promise<SeparationReading> {
  const source = `systemctl is-active ${unit}`;
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", unit], { timeout: 3000, maxBuffer: 4096 });
    const unitState = String(stdout).trim();
    return {
      known: true,
      active: unitState === "active",
      source,
      reason: unitState === "active"
        ? "Аварийная пауза Notice Place действует"
        : `Аварийная пауза Notice Place не действует (${unitState || "нет ответа systemctl"})`,
      facts: { unit, unitState },
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; code?: unknown };
    const unitState = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
    if (typeof failure.code === "number" && unitState) {
      // systemctl answered and the unit is simply not active.
      return {
        known: true,
        active: false,
        source,
        reason: `Аварийная пауза Notice Place не действует (${unitState})`,
        facts: { unit, unitState },
      };
    }
    return {
      known: false,
      active: false,
      source,
      reason: `Состояние юнита не прочитано: ${failure.message}`,
      facts: { unit },
    };
  }
}

/** The stop of one session: the hold of the human, read from its own store. */
export function sessionStopReading(input: { harness: string; sessionId: string; held: boolean }): SeparationReading {
  return {
    known: true,
    active: input.held,
    source: "human-stops.json (HumanStopStore.isHeld)",
    reason: input.held
      ? "Сессия удержана человеком: автоматический ввод не проходит"
      : "Сессия не удержана человеком",
    facts: { harness: input.harness, sessionId: input.sessionId, held: input.held },
  };
}

/** The stop of one session that could not be read. */
export function sessionStopUnknown(input: { harness?: string; sessionId?: string; reason: string }): SeparationReading {
  return {
    known: false,
    active: false,
    source: "human-stops.json (HumanStopStore.isHeld)",
    reason: input.reason,
    facts: {
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  };
}

/**
 * The prohibitions of the hooks: one field of the document of the hooks.
 *
 * The lever of the prohibitions is not the runtime of the hooks and not the
 * stop of a session. It reads only its own field.
 */
export function prohibitionsReading(input: {
  enabled: boolean;
  known: boolean;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
}): SeparationReading {
  return {
    known: input.known,
    active: input.enabled,
    source: "hooks-prohibitions.json (prohibitionsEnabled)",
    reason: input.known
      ? input.reason || (input.enabled
        ? "Запреты хуков действуют"
        : "Запреты хуков выключены")
      : input.reason || "Запреты хуков не прочитаны",
    facts: {
      prohibitionsEnabled: input.enabled,
      ...(input.changedAt ? { changedAt: input.changedAt } : {}),
      ...(input.changedBy ? { changedBy: input.changedBy } : {}),
    },
  };
}

/**
 * The runtime of the hooks: the other field of the same document.
 *
 * The runtime is off while the prohibitions are on — that is the current
 * behaviour of the product, and the two states stay apart here.
 */
export function hooksReading(input: {
  state: HooksProhibitionsDocument;
  known: boolean;
  reason?: string;
}): SeparationReading {
  const runningHooks = HOOK_KINDS.filter((kind) => hookRuntimeActive(input.state, input.known, kind));
  return {
    known: input.known,
    active: input.known && input.state.hooksEnabled,
    source: "hooks-prohibitions.json (hooksEnabled, disabledHooks, inactiveHooks)",
    reason: input.known
      ? input.reason || (input.state.hooksEnabled
        ? `Рантайм хуков включён, выполняются: ${runningHooks.join(", ") || "нет"}`
        : "Рантайм хуков выключен")
      : input.reason || "Рантайм хуков не прочитан",
    facts: {
      hooksEnabled: input.state.hooksEnabled,
      disabledHooks: [...input.state.disabledHooks],
      inactiveHooks: [...input.state.inactiveHooks],
      runningHooks,
      ...(input.state.changedAt ? { changedAt: input.state.changedAt } : {}),
    },
  };
}

/** The quota policy: the file of the guard of the quota of Codex. */
export function quotaPolicyReading(input: {
  policy: { enabled: boolean; minRemainingPercent: number; onUnknown: string };
  known: boolean;
  revision?: string;
  reason?: string;
}): SeparationReading {
  return {
    known: input.known,
    active: input.known && input.policy.enabled,
    source: "codex-quota-guard.json (policy)",
    reason: input.known
      ? input.reason || (input.policy.enabled
        ? "Квотный гард включён"
        : "Квотный гард выключен")
      : input.reason || "Квотная политика не прочитана",
    facts: {
      enabled: input.policy.enabled,
      minRemainingPercent: input.policy.minRemainingPercent,
      onUnknown: input.policy.onUnknown,
      ...(input.revision ? { revision: input.revision } : {}),
    },
  };
}

/** The five sources, one per state. */
export interface SeparationSources {
  readSessionStop: () => Promise<SeparationReading>;
  readProhibitions: () => Promise<SeparationReading>;
  readHooks: () => Promise<SeparationReading>;
  readQuotaPolicy: () => Promise<SeparationReading>;
  readNetworkPause: () => Promise<SeparationReading>;
}

/** A source that fails does not speak for the other four. */
async function safeRead(key: SeparationKey, read: () => Promise<SeparationReading>): Promise<SeparationReading> {
  try {
    return await read();
  } catch (error) {
    return {
      known: false,
      active: false,
      source: "чтение не выполнено",
      reason: `Чтение состояния не удалось: ${(error as Error).message}`,
      facts: { dimension: key },
    };
  }
}

/**
 * Read the five states, each one from its own source, and put them apart.
 *
 * The sources are read in parallel and every failure stays inside its own
 * state: a broken source makes its state «неизвестно» and leaves the other
 * four as they were read.
 */
export async function readSeparatedStateView(sources: SeparationSources): Promise<SeparatedStateView> {
  const [session_stop, prohibitions, hooks, quota_policy, network_pause] = await Promise.all([
    safeRead("session_stop", sources.readSessionStop),
    safeRead("prohibitions", sources.readProhibitions),
    safeRead("hooks", sources.readHooks),
    safeRead("quota_policy", sources.readQuotaPolicy),
    safeRead("network_pause", sources.readNetworkPause),
  ]);
  return separateStates({ session_stop, prohibitions, hooks, quota_policy, network_pause });
}
