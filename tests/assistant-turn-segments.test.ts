import { describe, expect, it } from "vitest";
import { joinAssistantTurnMessages } from "../src/web-ui/message-groups.js";
import { groupMessagePartSegments } from "../src/web-ui/message-activity.js";
import type { SessionMessageView } from "../src/types/index.js";

describe("native assistant turn rendering", () => {
  const item = (id: string, parts: SessionMessageView["parts"], turnId = "turn-1"): SessionMessageView => ({ id, role: "assistant", text: "", parts, turnId });
  it("retains commentary between compact activity groups across native records", () => {
    const joined = joinAssistantTurnMessages([
      item("a", [{ type: "text", text: "Начинаю" }]),
      item("b", [{ type: "tool_call", name: "command", input: "pwd" }]),
      item("c", [{ type: "tool_result", name: "command", output: "/workspace" }]),
      item("d", [{ type: "text", text: "Продолжаю" }]),
    ]);
    expect(joined).toHaveLength(1);
    expect(groupMessagePartSegments(joined[0]!.parts).map(segment => segment.kind)).toEqual(["content", "activity", "content"]);
    expect(joined[0]!.parts.map(part => part.type)).toEqual(["text", "tool_call", "tool_result", "text"]);
  });
  it("preserves unknown turns, different turns and service note boundaries", () => {
    const values = [item("a", [], ""), item("b", []), item("note", []), item("c", []), item("d", [], "turn-2")];
    expect(joinAssistantTurnMessages(values, value => value.id === "note")).toHaveLength(5);
  });
});
