import type { HarnessEvent } from "./types/index.js";
import type { HerderEventBus } from "./herder-events.js";

/**
 * One execution span per (harness, session). OpenCode 2 reports no turnId on
 * session.execution.* events and gives every transition its own event id, so
 * the started transition anchors the span and its id becomes the turn ID the
 * completion and failure receipts publish under. Harnesses that do report an
 * exact turnId keep it directly.
 */
export class NativeTurnSpanTracker {
  private readonly spans = new Map<string, string>();

  private key(harness: string, sessionId: string): string {
    return `${harness}\u0000${sessionId}`;
  }

  turnIdFor(harness: string, sessionId: string, event: HarnessEvent): string | undefined {
    if (event.kind === "turn.started") {
      const data = event.data ?? {};
      const id = typeof data.nativeEventId === "string" ? data.nativeEventId : undefined;
      if (id) this.spans.set(this.key(harness, sessionId), id);
      const exact = typeof data.turnId === "string" ? data.turnId : undefined;
      return exact || id;
    }
    const data = event.data ?? {};
    const exact = typeof data.turnId === "string" ? data.turnId : undefined;
    if (typeof exact === "string" && exact) {
      this.spans.delete(this.key(harness, sessionId));
      return exact;
    }
    const span = this.spans.get(this.key(harness, sessionId));
    if (span) this.spans.delete(this.key(harness, sessionId));
    return span;
  }
}

/** The native turn receipt used by standard MCP Tasks in GPT Admin.
 *
 * Unlike a message-delivery job, this is published only after the harness
 * reports an exact native turn identity. A delivery admission or idle status
 * never creates a receipt, and the receipt carries no model text or
 * credentials. The completion receipt repeats the started receipt's turn ID,
 * so a waiting Task watcher matches started -> terminal on one identity.
 */
export function createNativeTurnReceiptPublisher() {
  const spans = new NativeTurnSpanTracker();
  return function publishNativeTurnReceipt(bus: Pick<HerderEventBus,"publish">, event: HarnessEvent): boolean {
    if (!["turn.started","turn.completed","turn.failed"].includes(event.kind)) return false;
    const sessionId = event.sessionId;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512
      || !/^[a-z][a-z0-9-]*$/.test(event.harness)) return false;
    const turnId = spans.turnIdFor(event.harness, sessionId, event);
    if (typeof turnId !== "string" || !turnId || turnId.length > 256) return false;
    const uri = ["herder://native-turns", event.harness, encodeURIComponent(sessionId), encodeURIComponent(turnId)].join("/");
    bus.publish({
      kind:"sessions", uri, action:"changed", id:turnId,
      source:"native-turn:"+event.kind,
      ...(event.at ? {at:event.at} : {}),
    });
    return true;
  };
}
