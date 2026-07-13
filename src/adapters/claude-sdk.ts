import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import {
  listSessions,
  getSessionInfo,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSessionInfo, PermissionResult, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code adapter via the official Claude Agent SDK (TypeScript).
 *
 * Uses listSessions(), getSessionInfo(), query() for direct session management.
 * Supports session listing, resumption, permission callbacks, and message streaming.
 * Falls back to reading JSONL files from disk for transcript/lastMessage extraction.
 */
export class ClaudeSDKAdapter implements HarnessAdapter {
  readonly type = "claude" as const;
  readonly name = "Claude Code (SDK)";

  /** Track permission callbacks so respondPermission can resolve them */
  private pendingPermissions = new Map<
    string,
    {
      toolName: string;
      input: Record<string, unknown>;
      resolve: (result: PermissionResult) => void;
    }
  >();

  private claudeDir = join(homedir(), ".claude");

  async init(): Promise<void> {
    try {
      await listSessions({ limit: 1 });
    } catch (err) {
      throw new Error(
        `Claude Agent SDK init failed: ${(err as Error).message}. Ensure Claude Code is authenticated.`
      );
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await listSessions({ limit: 100 });
    return Promise.all(sessions.map(async (s) => {
      const mapped = this.mapSession(s);
      // Try to get lastMessage from disk
      mapped.lastMessage = await this.getLastMessageFromDisk(s.sessionId);
      // Try to get model from disk (SDK may not always expose it)
      if (!mapped.model) {
        mapped.model = await this.getModelFromDisk(s.sessionId);
      }
      return mapped;
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    try {
      const info = await getSessionInfo(id);
      if (!info) return null;
      const mapped = this.mapSession(info);
      mapped.lastMessage = await this.getLastMessageFromDisk(id);
      if (!mapped.model) {
        mapped.model = await this.getModelFromDisk(id);
      }
      return mapped;
    } catch {
      return null;
    }
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const sessionInfo = await getSessionInfo(id).catch(() => null);
    const cwd = sessionInfo?.cwd;

    try {
      const q = query({
        prompt: options.message,
        options: {
          resume: id,
          cwd,
          canUseTool: options.steer
            ? undefined
            : (toolName, input, _opts) => {
                const permId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                if (this.pendingPermissions.size > 0) {
                  return Promise.resolve<PermissionResult>({ behavior: "deny", message: "Another permission is pending" });
                }

                return new Promise<PermissionResult>((resolve) => {
                  this.pendingPermissions.set(permId, { toolName, input, resolve });

                  setTimeout(() => {
                    if (this.pendingPermissions.has(permId)) {
                      this.pendingPermissions.delete(permId);
                      resolve({ behavior: "deny", message: "Permission timed out" });
                    }
                  }, 300_000);
                });
              },
          ...(options.queue
            ? { permissionMode: "bypassPermissions" as PermissionMode, maxTurns: 1 }
            : {}),
        },
      });

      if (options.queue) {
        (async () => {
          try {
            for await (const _msg of q) { /* drain */ }
          } catch { /* ignore */ }
        })();
        return { ok: true };
      }

      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype && msg.subtype.startsWith("error")) {
            return { ok: false, error: `Agent ended with: ${msg.subtype}` };
          }
        }
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(_id: string): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error:
        "Claude Agent SDK does not expose a stop API for in-flight sessions. " +
        "Use Ctrl+C in the terminal where the session is running.",
    };
  }

  async respondPermission(
    _sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    _remember?: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      return { ok: false, error: `No pending permission found with ID '${permissionId}'` };
    }

    if (response === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }
    this.pendingPermissions.delete(permissionId);
    return { ok: true };
  }

  async setPermissions(_sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.allowedTools || options.mode) {
      return {
        ok: false,
        error:
          "Claude SDK permissions are set per-query, not per-session. " +
          "Configure in .claude/settings.json or pass allowedTools when sending a message.",
      };
    }
    return { ok: true };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    // Claude SDK: model can be set per-query via the query() options.
    // For changing the default model, it goes into settings.
    // Here we store the preferred model and use it on next sendMessage.
    this._preferredModel = model;
    return {
      ok: false,
      error: `Model will be set to '${model}' on the NEXT message sent to session ${sessionId}. Claude does not support changing the model of an in-flight session.`,
    };
  }

  async listModels(): Promise<string[]> {
    return [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250115",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-haiku-20240307",
    ];
  }

  /**
   * Get transcript from the JSONL session file on disk.
   */
  async getTranscript(id: string): Promise<string | null> {
    const filePath = await this.findSessionFile(id);
    if (!filePath) return null;
    return this.extractTranscriptText(filePath);
  }

  /** Preferred model for next query */
  private _preferredModel?: string;

  /** Get pending permission requests for external polling */
  getPendingPermissionRequests(): Array<{
    id: string;
    toolName: string;
    description: string;
    details: string;
  }> {
    return [...this.pendingPermissions.entries()].map(([id, p]) => ({
      id,
      toolName: p.toolName,
      description: `Claude wants to use tool: ${p.toolName}`,
      details: JSON.stringify(p.input, null, 2),
    }));
  }

  // ---- Internal helpers ----

  private mapSession(info: SDKSessionInfo): AgentSession {
    const now = Date.now();
    const lastMod = info.lastModified || now;
    const isRecent = (now - lastMod) < 60_000;

    // Extract model from SDKSessionInfo if available
    const model = (info as Record<string, unknown>).model as string | undefined;

    return {
      id: info.sessionId,
      harness: "claude",
      status: isRecent ? "running" : "stopped",
      title: info.summary || info.firstPrompt || info.customTitle || "Untitled session",
      cwd: info.cwd || process.cwd(),
      lastActivity: new Date(lastMod).toISOString(),
      model,
      needsPermission: this.pendingPermissions.size > 0,
      durationSec: info.createdAt ? (now - info.createdAt) / 1000 : undefined,
      meta: {
        gitBranch: info.gitBranch,
        tag: info.tag,
        fileSize: info.fileSize,
        customTitle: info.customTitle,
        createdAt: info.createdAt ? new Date(info.createdAt).toISOString() : undefined,
      },
    };
  }

  /**
   * Find the JSONL file path for a session by scanning project hashes.
   */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    const projectsDir = join(this.claudeDir, "projects");
    try {
      const projectHashes = await readdir(projectsDir);
      for (const hash of projectHashes) {
        const filePath = join(projectsDir, hash, "sessions", `${sessionId}.jsonl`);
        try {
          await access(filePath);
          return filePath;
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Read the last message from the JSONL file on disk.
   */
  private async getLastMessageFromDisk(sessionId: string): Promise<string | undefined> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return undefined;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      let lastAssistantMsg = "";
      let lastHumanMsg = "";

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "human" && entry.message?.content) {
            const c = Array.isArray(entry.message.content)
              ? entry.message.content.find((b: { type: string; text?: string }) => b.type === "text")
              : null;
            if (c?.text) lastHumanMsg = c.text;
          }
          if (entry.type === "assistant" && entry.message?.content) {
            const parts: string[] = [];
            if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === "text" && block.text) parts.push(block.text);
                else if (block.type === "tool_use" && block.name) parts.push(`[Tool: ${block.name}]`);
              }
            }
            if (parts.length > 0) lastAssistantMsg = parts.join(" ");
          }
        } catch { /* skip */ }
      }

      const msg = lastAssistantMsg || lastHumanMsg;
      if (msg && msg.length > 300) return msg.slice(0, 300) + "...";
      return msg || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the model name from the JSONL file on disk.
   */
  private async getModelFromDisk(sessionId: string): Promise<string | undefined> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return undefined;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      let model: string | undefined;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.model) model = entry.model;
          else if (entry.message?.model) model = entry.message.model;
          else if (entry.message?.metadata?.model) model = entry.message.metadata.model;
        } catch { /* skip */ }
      }
      return model;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract full transcript text from a JSONL session file.
   */
  private async extractTranscriptText(filePath: string): Promise<string> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const parts: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.type === "human" ? "User" : entry.type === "assistant" ? "Assistant" : entry.type;
        if (role === "User" || role === "Assistant") {
          let text = "";
          if (entry.message?.content) {
            if (typeof entry.message.content === "string") {
              text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              const textParts: string[] = [];
              for (const block of entry.message.content) {
                if (block.type === "text" && block.text) textParts.push(block.text);
                else if (block.type === "tool_use" && block.name) textParts.push(`[Tool: ${block.name}]`);
              }
              text = textParts.join(" ");
            }
          }
          if (text) parts.push(`${role}: ${text.slice(0, 2000)}`);
        }
      } catch { continue; }
    }

    return parts.join("\n\n");
  }
}