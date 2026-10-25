import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { SessionMessageView } from "../src/types/index.js";
import { isMcpTool, mcpToolUsage, sessionActivityEvents, sessionChangedFiles } from "../src/web-ui/session-activity.js";
import { SessionActivityPanel } from "../src/web-ui/session-activity-panel.js";

const message = (parts: SessionMessageView["parts"], timestamp = "2026-10-25T10:00:00.000Z"): SessionMessageView => ({
  id: `m${parts.length}`,
  role: "assistant",
  timestamp,
  parts,
});

describe("the work of a session, read from the transcript", () => {
  it("reads the kind of the work from the tool call", () => {
    const events = sessionActivityEvents([
      message([{ type: "tool_call", name: "shell", input: { command: "git commit -m 'починка'" } }]),
      message([{ type: "tool_call", name: "shell", input: { command: "npm run test:core" } }]),
      message([{ type: "tool_call", name: "apply_patch", input: { command: "apply_patch src/web/server.ts" } }]),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["git", "test", "files"]);
  });

  it("counts a call once, even when the transcript carries its result too", () => {
    const events = sessionActivityEvents([
      message([{ type: "tool_call", name: "shell", input: { command: "ls" } }]),
      message([{ type: "tool_result", name: "shell", output: "ok" }]),
    ]);
    expect(events).toHaveLength(1);
  });

  it("names the MCP tools of the session and how many times each was called", () => {
    const usage = mcpToolUsage([
      message([{ type: "tool_call", name: "mcp__agent-herder__send_message", input: { command: "send" } }]),
      message([{ type: "tool_call", name: "mcp__agent-herder__send_message", input: { command: "send" } }]),
      message([{ type: "tool_call", name: "mcp__pswd__get_secret", input: { command: "secret" } }]),
      message([{ type: "tool_call", name: "shell", input: { command: "ls" } }]),
    ]);
    expect(usage).toEqual([
      { name: "mcp__agent-herder__send_message", count: 2 },
      { name: "mcp__pswd__get_secret", count: 1 },
    ]);
  });

  it("knows an MCP tool by its name", () => {
    expect(isMcpTool("mcp__agent-herder__send_message")).toBe(true);
    expect(isMcpTool("mcp:pswd:get_secret")).toBe(true);
    expect(isMcpTool("shell")).toBe(false);
    expect(isMcpTool(undefined)).toBe(false);
  });

  it("names the files the session touched", () => {
    const files = sessionChangedFiles([
      message([{ type: "tool_call", name: "apply_patch", input: { command: "apply_patch src/web/server.ts" } }]),
      message([{ type: "tool_call", name: "apply_patch", input: { command: "apply_patch src/web-ui/main.tsx" } }]),
    ]);
    expect(files.map((file) => file.path)).toEqual(["src/web/server.ts", "src/web-ui/main.tsx"]);
  });

  it("says nothing about a session without a transcript", () => {
    expect(sessionActivityEvents(undefined)).toEqual([]);
    expect(mcpToolUsage(undefined)).toEqual([]);
  });
});

describe("the panel of the work of the session", () => {
  it("shows the timeline and the MCP tools of the session", () => {
    const html = renderToStaticMarkup(React.createElement(SessionActivityPanel, {
      messages: [
        message([{ type: "tool_call", name: "shell", input: { command: "apply_patch src/web/server.ts" } }], "2026-10-25T10:00:00.000Z"),
        message([{ type: "tool_call", name: "mcp__agent-herder__send_message", input: { command: "send" } }], "2026-10-25T10:05:00.000Z"),
      ],
    }));
    expect(html).toContain("Таймлайн изменений");
    expect(html).toContain("Изменение файлов");
    expect(html).toContain("MCP");
    expect(html).toContain("mcp__agent-herder__send_message");
  });

  it("says plainly when the transcript is read and holds no actions", () => {
    const html = renderToStaticMarkup(React.createElement(SessionActivityPanel, { messages: [] }));
    expect(html).toContain("инструменты в переписке не вызывались");
    expect(html).toContain("вызовов MCP не зафиксировано");
  });

  it("says plainly when the transcript is not read yet", () => {
    const html = renderToStaticMarkup(React.createElement(SessionActivityPanel, { messages: undefined }));
    expect(html).toContain("переписка не загружена");
    expect(html).not.toContain("не вызывались");
  });
});
