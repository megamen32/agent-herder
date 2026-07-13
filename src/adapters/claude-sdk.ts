import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import {
  listSessions,
  getSessionInfo,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSessionInfo, PermissionResult, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code adapter via the official Claude Agent SDK (TypeScript).
 *
 * Uses listSessions(), getSessionInfo(), query() for direct session management.
 * Supports session listing, resumption, permission callbacks, and message streaming.
 *
 * Prerequisites:
 *   - @anthropic-ai/claude-agent-sdk installed
 *   - Claude Code authenticated (claude login or ANTHROPIC_API_KEY)
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
    return sessions.map((s) => this.mapSession(s));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    try {
      const info = await getSessionInfo(id);
      if (!info) return null;
      return this.mapSession(info);
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
          // Permission callback: capture pending requests for external response
          canUseTool: options.steer
            ? undefined
            : (toolName, input, _opts) => {
                const permId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                // If already blocked on a permission, auto-deny new ones
                if (this.pendingPermissions.size > 0) {
                  return Promise.resolve<PermissionResult>({ behavior: "deny", message: "Another permission is pending" });
                }

                return new Promise<PermissionResult>((resolve) => {
                  this.pendingPermissions.set(permId, { toolName, input, resolve });

                  // Auto-timeout after 5 minutes
                  setTimeout(() => {
                    if (this.pendingPermissions.has(permId)) {
                      this.pendingPermissions.delete(permId);
                      resolve({ behavior: "deny", message: "Permission timed out" });
                    }
                  }, 300_000);
                });
              },
          // Bypass permissions for fire-and-forget queue mode
          ...(options.queue
            ? { permissionMode: "bypassPermissions" as PermissionMode, maxTurns: 1 }
            : {}),
        },
      });

      if (options.queue) {
        // Fire-and-forget: drain async without blocking
        (async () => {
          try {
            for await (const _msg of q) { /* drain */ }
          } catch { /* ignore */ }
        })();
        return { ok: true };
      }

      // Sync mode: consume the iterator and wait for result
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

    return {
      id: info.sessionId,
      harness: "claude",
      status: isRecent ? "running" : "stopped",
      title: info.summary || info.firstPrompt || info.customTitle || "Untitled session",
      cwd: info.cwd || process.cwd(),
      lastActivity: new Date(lastMod).toISOString(),
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
}