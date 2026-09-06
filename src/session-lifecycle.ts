import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { sessionMessagesResourceUri, sessionResourceUri } from "./herder-resource-uris.js";

/** In-process session lifecycle registry fed by harness hooks.
 *
 * Hooks observe real session events (start, turn boundaries, session end)
 * and report them here; adapters prefer this observed state over the stale
 * persisted status that task indexes keep for interactive sessions.
 * In-memory by design: after a daemon restart the adapters fall back to
 * recency heuristics until hooks fire again.
 */

export type SessionLifecycleState = "running" | "idle" | "ended";
export type SessionLifecycleEvent = "start" | "turn-start" | "turn-end" | "end";

interface LifecycleEntry {
  state: SessionLifecycleState;
  cwd?: string;
  at: number;
}

const registry = new Map<string, LifecycleEntry>();
const STALE_MS = 24 * 60 * 60 * 1000;

function key(harness: string, sessionId: string): string {
  return `${harness}:${sessionId}`;
}

function prune(): void {
  const now = Date.now();
  for (const [entryKey, entry] of registry) {
    if (now - entry.at > STALE_MS) registry.delete(entryKey);
  }
}

export function markLifecycleEvent(
  harness: string,
  sessionId: string,
  event: SessionLifecycleEvent,
  cwd?: string,
  events: HerderEventBus = herderEvents,
): void {
  if (!harness.trim() || !sessionId.trim()) return;
  prune();
  const state: SessionLifecycleState =
    event === "start" || event === "turn-start" ? "running" : event === "turn-end" ? "idle" : "ended";
  registry.set(key(harness, sessionId), { state, ...(cwd ? { cwd } : {}), at: Date.now() });
  events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed", id: sessionId, source: "lifecycle-hook" });
  events.publish({ kind: "sessions", uri: sessionResourceUri(harness, sessionId), action: "changed", id: sessionId, source: "lifecycle-hook" });
  if (event === "turn-end" || event === "end") {
    events.publish({ kind: "sessions", uri: sessionMessagesResourceUri(harness, sessionId), action: "changed", id: sessionId, source: "lifecycle-hook" });
  }
}

export function lifecycleStateFor(harness: string, sessionId: string): SessionLifecycleState | undefined {
  prune();
  return registry.get(key(harness, sessionId))?.state;
}
