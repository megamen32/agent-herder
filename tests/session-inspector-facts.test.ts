import { describe, expect, it } from "vitest";
import { childSessionName, commandPaths, sessionInspectFacts, toolKind } from "../src/session-visualization.js";
import type { SessionDetails } from "../src/types/index.js";

function details(overrides: Partial<SessionDetails> = {}): SessionDetails {
  return {
    session: { id: "s1", harness: "codex", title: "Работа", status: "running", cwd: "/repo", model: "gpt-6.1-sol", lastActivity: "" },
    lineage: { kind: "root" },
    children: [],
    messages: [],
    history: { source: "acp-load", complete: true },
    ...overrides,
  } as SessionDetails;
}

describe("session inspector facts", () => {
  it("reports the last action of the agent in plain words", () => {
    const facts = sessionInspectFacts(details({
      messages: [{
        id: "m1", role: "assistant", timestamp: "2026-10-23T10:00:00Z", parts: [
          { type: "tool_call", name: "shell", input: { command: "git status" } },
        ],
      }],
    }));
    expect(facts.lastAction?.label).toBe("Работа с git");
    expect(facts.lastAction?.tool).toBe("shell");
  });

  it("says there is no action when the transcript proves none", () => {
    expect(sessionInspectFacts(details()).lastAction).toBeNull();
  });

  it("lists the files the transcript proves were written", () => {
    const facts = sessionInspectFacts(details({
      messages: [{
        id: "m1", role: "assistant", timestamp: "2026-10-23T10:00:00Z", parts: [
          { type: "tool_call", name: "write", input: { command: "apply_patch src/web/server.ts" } },
        ],
      }],
    }));
    expect(facts.files.map((file) => file.path)).toContain("src/web/server.ts");
  });

  it("does not invent files when the transcript proves none", () => {
    expect(sessionInspectFacts(details()).files).toEqual([]);
  });

  it("counts child sessions and names them from the task when the provider did not", () => {
    const facts = sessionInspectFacts(details({
      children: [
        { id: "c1", harness: "codex", title: "Untitled session", status: "running", cwd: "", lastActivity: "" },
        { id: "c2", harness: "codex", title: "Проверить отчёт", status: "idle", cwd: "", lastActivity: "", meta: { task: "Проверить отчёт" } },
      ],
    }));
    expect(facts.subagents.count).toBe(2);
    expect(facts.subagents.items[0]).toMatchObject({ name: "название не сохранилось", named: false });
    expect(facts.subagents.items[1]).toMatchObject({ name: "Проверить отчёт", named: true });
  });

  it("keeps the model's own value and never claims a switch happened", () => {
    const facts = sessionInspectFacts(details());
    expect(facts.model.native).toBe("gpt-6.1-sol");
  });

  it("reports when the history is not complete", () => {
    expect(sessionInspectFacts(details({ history: { source: "live-cache", complete: false } })).history).toEqual({
      source: "live-cache", complete: false,
    });
  });
});

describe("child session names", () => {
  it("prefers the recorded task over a provider placeholder", () => {
    expect(childSessionName({ title: "Untitled session", meta: { task: "Собрать отчёт" } })).toEqual({ name: "Собрать отчёт", named: true });
  });

  it("says the name was not kept instead of showing a placeholder", () => {
    expect(childSessionName({ title: "Untitled session" })).toEqual({ name: "название не сохранилось", named: false });
  });

  it("keeps a real provider title", () => {
    expect(childSessionName({ title: "Отчёт по флоту" })).toEqual({ name: "Отчёт по флоту", named: true });
  });
});

describe("command reading", () => {
  it("finds the file a command touches", () => {
    expect(commandPaths("apply_patch src/web/server.ts")).toContain("src/web/server.ts");
  });

  it("tells a file change from a test run", () => {
    const file = toolKind({ type: "tool_call", name: "write", input: { command: "apply_patch src/a.ts" } }, "apply_patch src/a.ts", ["src/a.ts"]);
    const test = toolKind({ type: "tool_call", name: "shell", input: { command: "npx vitest run" } }, "npx vitest run", []);
    expect(file).toBe("files");
    expect(test).toBe("test");
  });
});
