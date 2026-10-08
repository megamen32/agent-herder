import { describe, expect, it } from "vitest";
import type { SessionMessageView } from "../src/types/index.js";
import { groupSessionMessages } from "../src/web-ui/message-groups.js";

const message = (id: string, role: SessionMessageView["role"], turnId?: string): SessionMessageView => ({
  id, role, ...(turnId ? { turnId } : {}), text: id, parts: [{ type: "text", text: id }],
});

describe("native assistant answer stacking", () => {
  it("stacks successive parts of one native turn and preserves their order and text", () => {
    const input = [message("progress", "assistant", "turn-1"), message("result", "assistant", "turn-1")];
    const groups = groupSessionMessages(input);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toEqual(input);
    expect(input).toHaveLength(2);
  });

  it("keeps two assistant turns separate even without a user message between them", () => {
    expect(groupSessionMessages([message("a", "assistant", "turn-1"), message("b", "assistant", "turn-2")])).toHaveLength(2);
  });

  it("does not merge unknown turns, user messages or across intervening user messages", () => {
    const input = [message("a", "assistant"), message("b", "assistant"),
      message("c", "assistant", "turn-1"), message("u", "user", "turn-1"), message("d", "assistant", "turn-1")];
    expect(groupSessionMessages(input)).toHaveLength(5);
  });

  it("deduplicates native item IDs but preserves equal text on different native items", () => {
    const first = message("a", "assistant", "turn-1");
    const second = { ...first, id: "b" };
    expect(groupSessionMessages([first, first, second])[0].messages).toEqual([first, second]);
  });

  it("retains the latest snapshot when a native item is updated under the same ID", () => {
    const first = message("a", "assistant", "turn-1");
    const updated = { ...first, text: "complete answer", parts: [{ type: "text" as const, text: "complete answer" }] };
    expect(groupSessionMessages([first, updated])[0].messages).toEqual([updated]);
  });
});
