import type { SessionMessageView } from "../types/index.js";

export type MessageGroup = { id: string; role: SessionMessageView["role"]; timestamp?: string; messages: SessionMessageView[] };

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
