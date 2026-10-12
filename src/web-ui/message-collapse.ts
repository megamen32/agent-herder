import type { SessionMessageView } from "../types/index.js";
import { formatJsonPayload, splitSystemBlocks } from "./json-rendering.js";

const STORAGE_KEY = "agent-herder-collapse-long-messages";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** Tool outputs and reasoning have their own disclosures and do not size the answer. */
export function isLongVisibleMessage(message: SessionMessageView, jsonRendering: boolean): boolean {
  const parts = message.parts.length ? message.parts : [{ type: "text", text: message.text }];
  const body = parts.filter(part => part.type === "text").map(part => {
    const visible = splitSystemBlocks(part.text || "").text;
    return (jsonRendering ? formatJsonPayload(visible) : undefined) ?? visible;
  }).join("\n");
  return body.length > 1500 || body.split("\n").length > 24;
}

export function readCollapseLongMessages(storage: Storage): boolean {
  try { return storage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}

export function writeCollapseLongMessages(storage: Storage, enabled: boolean): void {
  try {
    if (enabled) storage.setItem(STORAGE_KEY, "1");
    else storage.removeItem(STORAGE_KEY);
  } catch { /* An unsaved preference must not prevent reading the chat. */ }
}
