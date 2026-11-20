import type { CodexHistoryItem, SessionMessagePart, SessionMessageView } from "../types/index.js";

export type CodexHistoryEvent = {
  kind: "codex-item";
  eventId: string;
  turnId: string;
  message: SessionMessageView;
};

export function codexHistoryImage(url: unknown): SessionMessagePart | undefined {
  if (typeof url !== "string" || url.length >= 8 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return undefined;
  return { type: "image", imageUrl: url, fileName: "Изображение" };
}

export function codexHistoryEvent({item, turnId, startedAtMs, completedAtMs}: CodexHistoryItem): CodexHistoryEvent {
  const parts: SessionMessagePart[] = [];
  let role: SessionMessageView["role"] = "assistant";
  if (item.type === "userMessage") {
    role = "user";
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === "text" && typeof part.text === "string") parts.push({type: "text", text: part.text});
      else if (part?.type === "image") {
        const image = codexHistoryImage(part.url);
        if (image) parts.push(image);
      }
      else if (typeof part?.path === "string") parts.push({type: "text", text: part.path});
    }
  } else if (item.type === "agentMessage" || item.type === "plan") {
    if (typeof item.text === "string") parts.push({type: "text", text: item.text});
  } else if (item.type === "reasoning") {
    const text = Array.isArray(item.summary) ? item.summary.filter(value => typeof value === "string").join("\n") : "";
    parts.push({type: "thinking", text});
  } else if (item.type === "functionCallOutput") {
    role = "tool";
    parts.push({type: "tool_result", name: String(item.name ?? item.type), output: typeof item.output === "string" ? item.output : JSON.stringify(item.output)});
  } else {
    const name = typeof item.tool === "string" ? item.tool : item.type;
    const output = item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.error;
    parts.push({type: "tool_call", name, input: item.arguments ?? item.command ?? item});
    if (output != null) parts.push({type: "tool_result", name, output: typeof output === "string" ? output : JSON.stringify(output), error: Boolean(item.error)});
  }
  const time = startedAtMs ?? completedAtMs;
  const timestamp = time == null ? undefined : new Date(time);
  const eventId = JSON.stringify([turnId, item.id]);
  return {kind: "codex-item", eventId, turnId, message: {
    id: eventId, nativeMessageId: item.id, turnId, role, parts,
    ...(timestamp && Number.isFinite(timestamp.getTime()) ? {timestamp: timestamp.toISOString()} : {}),
    ...(typeof item.phase === "string" ? {phase: item.phase} : {}),
    text: parts.filter(part => part.type === "text").map(part => part.text).join("\n"),
  }};
}
