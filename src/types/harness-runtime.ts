/** Per-harness-type runtime capabilities: one registry for switch-by-name sites.

Control-plane capabilities (cancelTurn, detach, resume, ...) live on each
adapter instance via `controlCapabilities` because they can vary per transport
implementation. Runtime capabilities — how a harness participates in
autopilot dispatch, whether it is a browser chat with no CLI, whether it
publishes native Stop hooks, whether it is eligible for the autopilot
allowlist — are static per `HarnessType` and belong in exactly one place.

Every switch-by-name site that used to enumerate `harness === "codex" ||
harness === "claude" || ...` now asks this registry instead, so a new harness
or a changed behaviour only edits one row.
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

/** The one source of truth. Order follows `HarnessType` for readability. */
export const HARNESS_RUNTIME_CAPABILITIES: Record<HarnessType, HarnessRuntimeCapabilities> = {
  codex:          { autopilotDispatch: "returnNextGoal",  hookDrivenStop: true,  browserChat: false, autopilotEligible: true,  localInject: false, humanStopObserver: true  },
  opencode:       { autopilotDispatch: "deliverInRunner", hookDrivenStop: true,  browserChat: false, autopilotEligible: true,  localInject: false, humanStopObserver: true  },
  claude:         { autopilotDispatch: "returnNextGoal",  hookDrivenStop: true,  browserChat: false, autopilotEligible: true,  localInject: false, humanStopObserver: false },
  qoder:          { autopilotDispatch: "agentResume",     hookDrivenStop: true,  browserChat: false, autopilotEligible: false, localInject: false, humanStopObserver: false },
  hermes:         { autopilotDispatch: "returnNextGoal",  hookDrivenStop: true,  browserChat: false, autopilotEligible: true,  localInject: true,  humanStopObserver: false },
  zcode:          { autopilotDispatch: "returnNextGoal",  hookDrivenStop: true,  browserChat: false, autopilotEligible: true,  localInject: false, humanStopObserver: true  },
  "fast-agent":   { autopilotDispatch: "agentResume",     hookDrivenStop: false, browserChat: false, autopilotEligible: false, localInject: false, humanStopObserver: false },
  chatgpt:        { autopilotDispatch: "returnNextGoal",  hookDrivenStop: false, browserChat: true,  autopilotEligible: true,  localInject: false, humanStopObserver: false },
  zai:            { autopilotDispatch: "returnNextGoal",  hookDrivenStop: false, browserChat: true,  autopilotEligible: true,  localInject: false, humanStopObserver: false },
  "browser-chat": { autopilotDispatch: "returnNextGoal",  hookDrivenStop: false, browserChat: true,  autopilotEligible: false, localInject: false, humanStopObserver: false },
  "minimax-code": { autopilotDispatch: "agentResume",     hookDrivenStop: false, browserChat: false, autopilotEligible: false, localInject: false, humanStopObserver: false },
};

/** Look up the runtime capabilities for a harness type. Throws on unknowns so a
 *  typo cannot silently fall through to a default. */
export function harnessRuntimeCapabilities(type: string): HarnessRuntimeCapabilities {
  const caps = (HARNESS_RUNTIME_CAPABILITIES as Record<string, HarnessRuntimeCapabilities>)[type];
  if (!caps) throw new Error(`unknown harness type: ${type}`);
  return caps;
}
