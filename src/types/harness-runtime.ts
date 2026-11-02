/** Per-harness runtime capabilities: each adapter declares its own next to the
class that owns them, and this module is an accumulator populated at module
load via `registerHarnessRuntimeCapabilities()`. There is no God file: adding
a harness means creating its adapter file, not editing a central table.

Control-plane capabilities (cancelTurn, detach, resume, ...) live on each
adapter instance via `controlCapabilities` because they can vary per transport
implementation. Runtime capabilities — how a harness participates in autopilot
dispatch, whether it is a browser chat with no CLI, whether it publishes native
Stop hooks — are static per `HarnessType`, so each adapter file knows them at
module load and registers them once.
*/
import type { HarnessType } from "./common.js";

/** How the autopilot runner dispatches a continuation for a harness. */
export type AutopilotDispatch =
  /** Runner returns `{decision:"continue", next_goal}` and the caller
   *  (BackgroundAutopilotStop) delivers the goal through `options.deliver`. */
  | "returnNextGoal"
  /** Runner calls `deliverAutopilotGoal` itself with the OpenCode inbox
   *  adapter and the agent-resume fallback. */
  | "deliverInRunner"
  /** Runner falls through to `deliverAutopilotGoal` -> `deliverThroughResume`
   *  (the durable agent-resume transport). */
  | "agentResume";

export interface HarnessRuntimeCapabilities {
  /** Autopilot continuation dispatch path used by the runner. */
  readonly autopilotDispatch: AutopilotDispatch;
  /** Harness publishes native Stop hook events (codex/claude/zcode/opencode/hermes/qoder);
   *  browser chats (chatgpt/zai) are observed instead via BrowserTurnAutopilotObserver. */
  readonly hookDrivenStop: boolean;
  /** Browser-chat harness with no CLI: `supervisor.sendMessage` -> `adapter.sendMessage`. */
  readonly browserChat: boolean;
  /** Eligible for the autopilot Stop allowlist (BackgroundAutopilotStop.submit). */
  readonly autopilotEligible: boolean;
  /** Hermes-style local-inject `resume_status` tag on the continuation receipt. */
  readonly localInject: boolean;
  /** Codex/Zcode/OpenCode expose the human-stop observer; other harnesses do not. */
  readonly humanStopObserver: boolean;
}

const REGISTRY = new Map<string, HarnessRuntimeCapabilities>();

/** Each adapter file calls this at module load to publish its runtime
 *  capabilities. The registry is an accumulator, not a source of truth. */
export function registerHarnessRuntimeCapabilities(type: string, caps: HarnessRuntimeCapabilities): void {
  REGISTRY.set(type, caps);
}

/** Look up runtime capabilities for a harness type. Throws on unknowns so a
 *  typo or a missing adapter import cannot silently fall through to a default. */
export function harnessRuntimeCapabilities(type: string): HarnessRuntimeCapabilities {
  const caps = REGISTRY.get(type);
  if (!caps) {
    throw new Error(
      `unknown harness type: ${type}; register it via registerHarnessRuntimeCapabilities in its adapter file`,
    );
  }
  return caps;
}

/** Prefer this helper when an adapter instance is in scope: it reads
 *  `adapter.runtimeCapabilities` directly and only falls back to the registry
 *  when the adapter has not declared its own (e.g. a third-party adapter). */
export function getHarnessRuntimeCapabilities(adapter: {
  type: string;
  runtimeCapabilities?: HarnessRuntimeCapabilities;
}): HarnessRuntimeCapabilities {
  return adapter.runtimeCapabilities ?? harnessRuntimeCapabilities(adapter.type);
}
