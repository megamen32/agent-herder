import { describe, expect, it } from "vitest";
import { convertHermesExport } from "../src/hermes-conversion.js";

describe("Hermes export conversion bridge", () => {
  it("converts text, tool calls, and tool results to a neutral conversation", () => {
    const result = convertHermesExport({
      target: "codex",
      export: {
        session_id: "hermes-42",
        cwd: "/workspace/demo",
        model: "hermes-model",
        messages: [
          { id: "u1", role: "user", content: "Inspect the project" },
          { id: "a1", role: "assistant", content: [{ type: "text", text: "I will inspect it." }, { type: "tool_use", id: "call-1", name: "list_files", input: { path: "." } }] },
          { id: "t1", role: "tool", tool_call_id: "call-1", content: "README.md", is_error: false },
        ],
      },
    });

    expect(result.capabilities.transcriptConversion).toMatchObject({ supported: true, mode: "export-to-neutral-conversation" });
    expect(result.capabilities.liveSessionConversion.supported).toBe(false);
    expect(result.capabilities.liveSessionResume.supported).toBe(false);
    expect(result.conversation).toMatchObject({ sourceHarness: "hermes", targetHarness: "codex", id: "hermes-42", cwd: "/workspace/demo" });
    expect(result.conversation?.messages[1]?.parts).toEqual([
      { type: "text", text: "I will inspect it." },
      { type: "tool_call", id: "call-1", name: "list_files", input: { path: "." }, finished: false },
    ]);
    expect(result.conversation?.messages[2]?.parts).toEqual([{ type: "tool_result", toolCallId: "call-1", content: "README.md", isError: false }]);
  });

  it("retains unknown payloads and reports them instead of silently dropping them", () => {
    const unknown = { type: "future_hermes_block", value: 7 };
    const result = convertHermesExport({ target: "claude", export: { messages: [{ role: "assistant", content: [unknown] }] } });

    expect(result.conversation?.messages).toHaveLength(1);
    expect(result.unknownPayloads).toContain(unknown);
    expect(result.conversation?.meta?.unknownPayloads).toContain(unknown);
    expect(result.warnings).toContain("Unknown Hermes payload at message 0 part 0");
  });
});
