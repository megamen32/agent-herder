import type { HerderEventBus } from "./herder-events.js";
import type { HarnessAdapter } from "./types/index.js";

export interface CodexTurnState {
  sessionId: string;
  turnId: string;
  parentThreadId?: string;
  state: "running" | "finished";
  outcome: "completed" | "failed" | "stopped" | "needs_input" | null;
  finishedAt: string | null;
  lastAssistantMessage: string | null;
}

export function recordCodexTurn(bus: HerderEventBus, turn: CodexTurnState): void {
  const prefix = `herder://completions/codex/${encodeURIComponent(turn.sessionId)}/${encodeURIComponent(turn.turnId)}/`;
  if (bus.revision(prefix + "finished") || bus.revision(prefix + turn.state)) return;
  bus.publish({kind: "sessions", uri: prefix + turn.state, action: "changed",
    type: turn.state === "finished" ? "turn.completed" : "turn.started", turn,
    ...(turn.finishedAt ? {at: turn.finishedAt} : {})});
}

export function completionStatus(bus: HerderEventBus, sessionId: string) {
  const event = bus.latestCodexTurn(sessionId);
  if (event?.turn) return {...event.turn, revision: event.sequence};
  return {sessionId, state: "unobserved", outcome: null, finishedAt: null, lastAssistantMessage: null, revision: 0};
}

// Read only the latest native turn. A notification received during this read
// wins over the potentially older snapshot.
export async function refreshCodexTurn(bus: HerderEventBus, adapter: HarnessAdapter | undefined, id: string) {
  const before = bus.latestCodexTurn(id);
  const observed = await adapter?.readCompletionState?.(id);
  if (observed && observed.sessionId === id && before === bus.latestCodexTurn(id)) recordCodexTurn(bus, observed);
}

export async function awaitCompletion(bus: HerderEventBus, ids: string[], after: number | undefined,
  timeoutMs: number, signal: AbortSignal, resolveAdapter?: (id: string) => Promise<HarnessAdapter | undefined>) {
  const watched = new Set(ids);
  const deadline = Date.now() + timeoutMs;
  const adapters = new Map<string, HarnessAdapter | undefined>();
  if (resolveAdapter) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...watched].map(async id => adapters.set(id, await resolveAdapter(id)))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Completion route lookup timed out")), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const oldest = bus.oldestSequence();
  const truncated = after !== undefined && oldest !== null && after < oldest - 1;
  const result = (sequence: number, turn: CodexTurnState | null) => ({completion: turn, cursor: sequence, truncated});
  if (after !== undefined) {
    const event = bus.firstCompletionAfter(after, watched);
    if (event?.turn) return result(event.sequence, event.turn);
  } else {
    // The first result must not advance the cursor past another ready thread.
    const ready = [...watched].map(id => bus.latestCodexTurn(id))
      .filter(event => event?.turn?.state === "finished")
      .sort((left, right) => left!.sequence - right!.sequence)[0];
    if (ready?.turn) return result(ready.sequence, ready.turn);
  }
  return new Promise<ReturnType<typeof result>>((resolve, reject) => {
    const nativeListeners: Array<() => void> = [];
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      for (const remove of nativeListeners) remove();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(new Error("Completion wait cancelled")); };
    const unsubscribe = bus.subscribe(event => {
      if (event.turn?.state !== "finished" || !watched.has(event.turn.sessionId) || event.sequence <= (after ?? 0)) return;
      cleanup();
      resolve(result(event.sequence, event.turn));
    });
    const timer = setTimeout(() => { cleanup(); resolve(result(Math.max(after ?? 0, bus.latestSequence()), null)); }, Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) return abort();
    for (const adapter of new Set(adapters.values())) {
      const remove = adapter?.subscribeEvents?.(event => {
        const turn = event.completionState;
        if (turn && adapters.get(turn.sessionId) === adapter) recordCodexTurn(bus, turn);
      });
      if (remove) nativeListeners.push(remove);
    }
    for (const [id, adapter] of adapters) void refreshCodexTurn(bus, adapter, id).catch(() => {});
  });
}
