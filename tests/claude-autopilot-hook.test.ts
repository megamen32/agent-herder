import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runClaudeAutopilotHook } from "../src/claude-autopilot-hook.js";

describe("Claude Code autopilot Stop hook", () => {
  it("passes the exact session context to the shared runner and blocks Stop with its next goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-claude-hook-"));
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "user", uuid: "user-1", message: { role: "user", content: "Почини доставку." } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "Исправление пока не проверено." }] } }),
    ].join("\n"));
    const runner = vi.fn(async () => ({ decision: "continue", next_goal: "Проверь исправление в той же сессии." }));

    await expect(runClaudeAutopilotHook({
      hook_event_name: "Stop",
      session_id: "claude-session-1",
      cwd: "/workspace/app",
      transcript_path: transcriptPath,
      stop_hook_active: true,
      last_assistant_message: "Исправление пока не проверено.",
    }, runner)).resolves.toEqual({
      decision: "block",
      reason: "Проверь исправление в той же сессии.",
    });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: "stop",
      harness: "claude",
      sessionId: "claude-session-1",
      cwd: "/workspace/app",
      turnId: "claude:user-1",
      lastUserMessage: "Почини доставку.",
      lastAssistantMessage: "Исправление пока не проверено.",
      transcriptPath,
      stopHookActive: true,
    }));
  });

  it("allows Claude to stop when the judge is terminal or waiting for a choice", async () => {
    const input = {
      hook_event_name: "Stop" as const,
      session_id: "claude-session-2",
      cwd: "/workspace/app",
      transcript_path: null,
      stop_hook_active: false,
      last_assistant_message: "Готово.",
    };
    await expect(runClaudeAutopilotHook(input, async () => ({ decision: "terminal" }))).resolves.toEqual({});
    await expect(runClaudeAutopilotHook(input, async () => ({ decision: "choice", request_id: "choice-1" }))).resolves.toEqual({});
  });

  it("skips the /autopilot control turn so enabling itself cannot enter a loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-claude-control-hook-"));
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(transcriptPath, JSON.stringify({
      type: "user",
      uuid: "control-1",
      message: { role: "user", content: "<command-name>/agent-herder:autopilot</command-name> <command-args>on</command-args>" },
    }));
    const runner = vi.fn(async () => ({ decision: "continue", next_goal: "Should not run" }));

    await expect(runClaudeAutopilotHook({
      hook_event_name: "Stop",
      session_id: "claude-control-session",
      cwd: "/workspace/app",
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: null,
    }, runner)).resolves.toEqual({});
    expect(runner).not.toHaveBeenCalled();
  });
});
