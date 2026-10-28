import type { SessionMessageView } from "../types/index.js";

export type MessageGroup = { id: string; role: SessionMessageView["role"]; timestamp?: string; messages: SessionMessageView[] };

/** Render one native assistant turn as ordered content/activity segments, without
 * introducing an artificial row boundary for every persisted tool record. */
export function joinAssistantTurnMessages(messages: SessionMessageView[], isBoundary: (message: SessionMessageView) => boolean = () => false): SessionMessageView[] {
  const joined: SessionMessageView[] = [];
  const parts = (message: SessionMessageView) => message.parts.length ? message.parts : message.text ? [{ type: "text" as const, text: message.text }] : [];
  for (const message of messages) {
    const previous = joined[joined.length - 1];
    if (previous?.role === "assistant" && message.role === "assistant" && message.turnId
      && previous.turnId === message.turnId && !isBoundary(previous) && !isBoundary(message)) {
      joined[joined.length - 1] = { ...previous, text: "", parts: [...parts(previous), ...parts(message)] };
    } else joined.push(message);
  }
  return joined;
}

/** Stack only assistant messages whose native turn identity is known. */
export function groupSessionMessages(messages: SessionMessageView[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const unique = new Map(messages.map((message) => [message.id, message]));
  for (const message of unique.values()) {
    // A refresh can repeat the same native item; equal text is not a duplicate.
    const previous = groups[groups.length - 1];
    const last = previous?.messages[previous.messages.length - 1];
    if (message.role === "assistant" && last?.role === "assistant"
      && message.turnId && message.turnId === last.turnId) {
      previous.messages.push(message);
    } else {
      groups.push({ id: message.id, role: message.role, timestamp: message.timestamp, messages: [message] });
    }
  }
  return groups;
}
