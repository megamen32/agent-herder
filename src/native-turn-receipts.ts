import type { HarnessEvent } from "./types/index.js";
import type { HerderEventBus } from "./herder-events.js";

/** The native turn receipt used by standard MCP Tasks in GPT Admin.
 *
 * Unlike a message-delivery job, this is published only after the harness
 * reports an exact native turn ID. A missing turn ID cannot be interpreted
 * as completion, and the receipt carries no model text or credentials.
 */
export function publishNativeTurnReceipt(bus: Pick<HerderEventBus,"publish">, event: HarnessEvent): boolean {
  if (!["turn.started","turn.completed","turn.failed"].includes(event.kind)) return false;
  const sessionId = event.sessionId;
  const turnId = event.data?.turnId;
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
