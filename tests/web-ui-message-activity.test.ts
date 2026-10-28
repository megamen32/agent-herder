import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActivityRows, groupMessagePartSegments } from "../src/web-ui/message-activity.js";

describe("message activity rows", () => {
  it("preserves text-tool-text order while separating collapsible content from activity", () => {
    const parts = [
      { type: "text" as const, text: "Before" },
      { type: "tool_call" as const, name: "shell_exec", input: { command: "pwd" } },
      { type: "text" as const, text: "After" },
    ];
    const segments = groupMessagePartSegments(parts);
    expect(segments.map((segment) => segment.kind)).toEqual(["content", "activity", "content"]);
    expect(segments.map((segment) => segment.parts)).toEqual([[parts[0]], [parts[1]], [parts[2]]]);
  });

  it("shows named reasoning and tool events as individually collapsed rows with truthful status", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "thinking", text: "Reasoning body" },
      { type: "tool_call", name: "shell_exec", input: { command: "pwd" } },
      { type: "tool_result", name: "shell_exec", output: "/workspace" },
      { type: "tool_result", name: "read_file", output: "permission denied", error: true },
      { type: "tool_call", name: "subagent", input: { kind: "interacted", agentThreadId: "child-1", agentPath: "reviewer" } },
      { type: "tool_call", name: "command", input: { command: ["git", "status", "--short"] } },
    ] }));

    expect(html).toContain("Думаю");
    expect(html).toContain("shell_exec");
    expect(html).toContain("read_file");
    expect(html).toContain("Вызов");
    expect(html).toContain("Готово");
    expect(html).toContain("Ошибка");
    expect(html).toContain("Субагент");
    expect(html).toContain("Субагент · reviewer");
    expect(html).toContain("Взаимодействие");
    expect(html).toContain("interacted");
    expect(html).toContain("command · git status --short");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("Reasoning body");
    expect(html).toContain("permission denied");
  });

  it("renders a neighboring call and result as one completed row", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "tool_call", name: "command", input: { command: ["pwd"], cwd: "/workspace" } },
      { type: "tool_result", name: "command", output: "/workspace" },
    ] }));
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain("command · pwd");
    expect(html).toContain("Готово");
    expect(html).toContain("/workspace");
    expect(html).not.toContain("Вызов</small>");
  });

  it("respects saved visibility controls", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: false, showTools: false, parts: [
      { type: "thinking", text: "hidden" },
      { type: "tool_call", name: "shell_exec", input: "hidden" },
    ] }));
    expect(html).not.toContain("Думаю");
    expect(html).not.toContain("shell_exec");
  });

  it("keeps an empty public reasoning event visible without inventing its contents", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "thinking", text: "" },
    ] }));
    expect(html).toContain("Думаю");
    expect(html).toContain("Codex не сохранил публичную сводку этого события.");
  });
});
