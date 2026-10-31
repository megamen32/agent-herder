import type { HarnessEvent } from "./types/index.js";
import type { HerderEventBus } from "./herder-events.js";

/** The native turn receipt used by standard MCP Tasks in GPT Admin.
 *
 * Unlike a message-delivery job, this is published only after the harness
 * reports an exact native turn ID. A missing turn ID cannot be interpreted
 * as completion, and the receipt carries no model text or credentials.
 *
 * OpenCode 2 does not report a turnId on session.execution.* events; its
 * per-event native id (data.nativeEventId) is the exact transition identity
 * the harness does publish, so it is the turn ID of last resort. A delivery
 * admission or idle status still never creates a receipt.
 */
export function publishNativeTurnReceipt(bus: Pick<HerderEventBus,"publish">, event: HarnessEvent): boolean {
  if (!["turn.started","turn.completed","turn.failed"].includes(event.kind)) return false;
  const sessionId = event.sessionId;
  const data = event.data ?? {};
  const turnId = typeof data.turnId === "string" && data.turnId
    ? data.turnId
    : typeof data.nativeEventId === "string" ? data.nativeEventId : undefined;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512
    || typeof turnId !== "string" || !turnId || turnId.length > 256
    || !/^[a-z][a-z0-9-]*$/.test(event.harness)) return false;
  const uri = ["herder://native-turns", event.harness, encodeURIComponent(sessionId), encodeURIComponent(turnId)].join("/");
  bus.publish({
    kind:"sessions", uri, action:"changed", id:turnId,
    source:"native-turn:"+event.kind,
    ...(event.at ? {at:event.at} : {}),
  });
  return true;
}
