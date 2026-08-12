#!/usr/bin/env node
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { runAutopilotCommand, type AutopilotRunnerInput } from "./autopilot-runner.js";

export type ClaudeStopHookInput = {
  hook_event_name: "Stop";
  session_id: string;
  cwd: string;
  transcript_path?: string | null;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
};

type Runner = (input: AutopilotRunnerInput) => Promise<Record<string, unknown>>;

export async function runClaudeAutopilotHook(
  input: ClaudeStopHookInput,
  runner: Runner = runAutopilotCommand,
): Promise<{ decision: "block"; reason: string } | Record<string, never>> {
  if (input.hook_event_name !== "Stop") return {};
  if (!input.session_id?.trim() || !input.cwd?.trim()) throw new Error("Claude Stop hook requires session_id and cwd");

  const context = await readTranscriptContext(input.transcript_path ?? null);
  if (isAutopilotControlTurn(context.lastUserMessage)) return {};
  const lastAssistant = input.last_assistant_message ?? context.lastAssistantMessage;
  const turnId = context.lastUserId
    ? `claude:${context.lastUserId}`
    : `claude:${createHash("sha256").update(`${input.session_id}\n${lastAssistant ?? ""}`).digest("hex").slice(0, 24)}`;
  const result = await runner({
    command: "stop",
    harness: "claude",
    sessionId: input.session_id,
    cwd: input.cwd,
    turnId,
    lastUserMessage: context.lastUserMessage,
    lastAssistantMessage: lastAssistant ?? null,
    transcriptPath: input.transcript_path ?? null,
    stopHookActive: input.stop_hook_active ?? false,
  });
  if (result.decision === "continue" && typeof result.next_goal === "string" && result.next_goal.trim()) {
    return { decision: "block", reason: result.next_goal.trim() };
  }
  return {};
}

function isAutopilotControlTurn(message: string | null): boolean {
  if (!message) return false;
  return /<command-name>\/(?:agent-herder:)?autopilot<\/command-name>/i.test(message)
    || /^\s*\/(?:agent-herder:)?autopilot(?:\s|$)/i.test(message);
}

async function readTranscriptContext(path: string | null): Promise<{
  lastUserMessage: string | null;
  lastUserId: string | null;
  lastAssistantMessage: string | null;
  lastAssistantId: string | null;
}> {
  if (!path) return { lastUserMessage: null, lastUserId: null, lastAssistantMessage: null, lastAssistantId: null };
  try {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      const maxBytes = 512 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
      const entries = text.split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
      let lastUserMessage: string | null = null;
      let lastUserId: string | null = null;
      let lastAssistantMessage: string | null = null;
      let lastAssistantId: string | null = null;
      for (const entry of entries) {
        const message = object(entry.message);
        const role = string(message.role) || string(entry.type);
        const content = textContent(message.content);
        if ((role === "user" || role === "human") && content) {
          lastUserMessage = content;
          lastUserId = string(entry.uuid) || string(entry.id) || lastUserId;
        }
        if (role === "assistant" && content) {
          lastAssistantMessage = content;
          lastAssistantId = string(entry.uuid) || string(entry.id) || lastAssistantId;
        }
      }
      return { lastUserMessage, lastUserId, lastAssistantMessage, lastAssistantId };
    } finally {
      await handle.close();
    }
  } catch {
    return { lastUserMessage: null, lastUserId: null, lastAssistantMessage: null, lastAssistantId: null };
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return string(value);
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((item) => {
    const block = object(item);
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n").trim();
  return text || null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as ClaudeStopHookInput;
  process.stdout.write(`${JSON.stringify(await runClaudeAutopilotHook(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
