import { describe, expect, it } from "vitest";
import { groupMessagePartSegments } from "../src/web-ui/message-activity.js";
import type { SessionMessagePart } from "../src/types/index.js";

// Verifies that activity grouping (thinking + tool calls) is unchanged by the
// UI overhaul patch: the wrapper <details> sits on top of the existing
// MessageActivityRows, so the segment shape must stay identical.

function part(overrides: Partial<SessionMessagePart>): SessionMessagePart {
  return { type: "text", text: "x", ...overrides } as SessionMessagePart;
}

describe("activity grouping preserves segment shape", () => {
  it("groups consecutive thinking + tool parts into one activity segment", () => {
    const parts: SessionMessagePart[] = [
      part({ type: "thinking", text: "hmm" }),
      part({ type: "tool_call", name: "exec", input: "ls" }),
      part({ type: "tool_result", name: "exec", output: "a\nb" }),
      part({ type: "text", text: "done" }),
    ];
    const segments = groupMessagePartSegments(parts);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.kind).toBe("activity");
    expect(segments[0]!.parts).toHaveLength(3);
    expect(segments[1]!.kind).toBe("content");
    expect(segments[1]!.parts).toHaveLength(1);
  });

  it("counts the activity items for the wrapper summary", () => {
    const parts: SessionMessagePart[] = [
      part({ type: "thinking", text: "a" }),
      part({ type: "thinking", text: "b" }),
      part({ type: "tool_call", name: "x", input: "" }),
      part({ type: "tool_result", name: "x", output: "" }),
    ];
    const segments = groupMessagePartSegments(parts);
    expect(segments).toHaveLength(1);
    const activity = segments[0]!;
    const count = activity.parts.filter((p) => p.type === "thinking" || p.type === "tool_call" || p.type === "tool_result").length;
    expect(count).toBe(4);
  });

  it("emits no activity segment when only text parts are present", () => {
    const segments = groupMessagePartSegments([part({ type: "text", text: "hello" })]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("content");
  });
});
