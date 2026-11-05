import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActivityRows, ToolDetails, groupMessagePartSegments } from "../src/web-ui/message-activity.js";

describe("message activity rows", () => {
  it("does not serialize or render tool payloads while the row is closed", () => {
    const serialize = vi.fn(() => ({ command: "large-input" }));
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: false, showTools: true, parts: [
      { type: "tool_call", name: "read_file", input: { toJSON: serialize } },
      { type: "tool_result", name: "read_file", output: "large-output" },
    ] }));
    expect(html).toContain("Прочитан файл");
    expect(html).not.toContain("large-output");
    expect(serialize).not.toHaveBeenCalled();
  });

  it("renders full input, output and status when a tool row is open", () => {
    const html = renderToStaticMarkup(React.createElement(ToolDetails, { initiallyOpen: true, label: "Прочитан файл", entries: [
      { part: { type: "tool_call", name: "read_file", input: { path: "/example" } }, result: { type: "tool_result", output: "file contents" } },
    ] }));
    expect(html).toContain("/example");
    expect(html).toContain("file contents");
    expect(html).toContain("Готово");
  });
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
    expect(html).toContain("Выполнил команды");
    expect(html).toContain("Прочитан файл");
    expect(html).toContain("tool-actions-failed");
    expect(html).toContain("Субагент");
    expect(html).toContain("Субагент reviewer");
    expect(html).not.toContain("interacted");
    expect(html).not.toContain("command · git status --short");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("Reasoning body");
    expect(html).not.toContain("permission denied");
  });

  it("renders a neighboring call and result as one completed row", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "tool_call", name: "command", input: { command: ["pwd"], cwd: "/workspace" } },
      { type: "tool_result", name: "command", output: "/workspace" },
    ] }));
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain("Выполнил команды");
    expect(html).not.toContain("/workspace");
    expect(html).not.toContain("Вызов</small>");
  });

  it("groups adjacent commands and keeps raw inputs and failures inside details only", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "tool_call", name: "functions.exec_command", input: { cmd: "pwd" } },
      { type: "tool_result", name: "functions.exec_command", output: "failed", error: true },
      { type: "tool_call", name: "command", input: { command: ["git", "status"] } },
    ] }));
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html.match(/<summary[^>]*>(.*?)<\/summary>/g)).toEqual([expect.stringContaining("Выполнил команды")]);
    const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1];
    expect(summary).not.toMatch(/pwd|git|Ошибка|Вызов|⌘/);
    expect(html).toContain("failed");
    expect(html).toContain("tool-actions-failed");
  });

  it("labels image and MCP wrapper actions semantically without executing code", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "tool_call", name: "view_image", input: { path: "/tmp/image.png" } },
      { type: "tool_call", name: "functions.exec", input: "await tools.mcp__agent_herder__mesh_discover({});" },
      { type: "tool_call", name: "mcp__context_mode__ctx_execute", input: {} },
      { type: "tool_call", name: "subagent", input: { agentPath: "reviewer", kind: "completed" } },
    ] }));
    expect(html).toContain("Просмотрено изображение");
    expect(html).toContain("Использовано Agent Herder");
    expect(html).toContain("Использовано Context Mode");
    expect(html).toContain("Субагент reviewer завершил работу");
    expect(html).toContain('data-activity-icon="image"');
    expect(html).toContain('data-activity-icon="integration"');
    expect(html.match(/<summary[^>]*>(.*?)<\/summary>/g)?.join(" ")).not.toMatch(/mesh_discover|ctx_execute|await|⌘/);
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

  it("hides historical empty reasoning while preserving public summaries and the trailing event", () => {
    const html = renderToStaticMarkup(React.createElement(MessageActivityRows, { showReasoning: true, showTools: true, parts: [
      { type: "thinking", text: "  " },
      { type: "tool_call", name: "command", input: { command: "pwd" } },
      { type: "thinking", text: "" },
      { type: "tool_call", name: "command", input: { command: "ls" } },
      { type: "thinking", text: "Public reasoning summary" },
      { type: "thinking", text: "" },
    ] }));
    expect(html.match(/activity-thinking/g)).toHaveLength(2);
    expect(html.match(/tool-action-row/g)).toHaveLength(1);
    expect(html).toContain("Public reasoning summary");
    expect(html).toContain('data-activity-icon="terminal"');
    expect(html.match(/<summary>Думаю<\/summary>/g)).toHaveLength(2);
  });
});
