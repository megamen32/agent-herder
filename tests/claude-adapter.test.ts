import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude.js";

describe("Claude Code adapter", () => {
  it("discovers current top-level JSONL sessions and preserves legacy sessions layout", async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), "agent-herder-claude-adapter-"));
    const currentProject = join(claudeDir, "projects", "-workspace-current");
    const legacyProject = join(claudeDir, "projects", "-workspace-legacy", "sessions");
    await mkdir(currentProject, { recursive: true });
    await mkdir(legacyProject, { recursive: true });
    await writeFile(join(currentProject, "current-session.jsonl"), [
      JSON.stringify({ type: "user", uuid: "user-current", cwd: "/workspace/current", message: { role: "user", content: "Проверь текущий формат." } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-current", cwd: "/workspace/current", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "Текущий формат найден." }] } }),
    ].join("\n"));
    await writeFile(join(legacyProject, "legacy-session.jsonl"), [
      JSON.stringify({ type: "human", uuid: "user-legacy", cwd: "/workspace/legacy", message: { role: "user", content: "Проверь legacy формат." } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-legacy", cwd: "/workspace/legacy", message: { role: "assistant", content: [{ type: "text", text: "Legacy формат найден." }] } }),
    ].join("\n"));

    const adapter = new ClaudeCodeAdapter({ claudeDir });
    const sessions = await adapter.listSessions();

    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "current-session", harness: "claude", cwd: "/workspace/current", title: "Проверь текущий формат.", lastMessage: "Текущий формат найден." }),
      expect.objectContaining({ id: "legacy-session", harness: "claude", cwd: "/workspace/legacy", title: "Проверь legacy формат.", lastMessage: "Legacy формат найден." }),
    ]));
    await expect(adapter.getTranscript("current-session")).resolves.toContain("User: Проверь текущий формат.");
    await expect(adapter.getRawTranscript("current-session")).resolves.toMatchObject({ complete: true, source: { format: "jsonl" } });
  });
});
