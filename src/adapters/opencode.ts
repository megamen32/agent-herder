import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";

/**
 * OpenCode adapter — communicates via its HTTP server (opencode serve).
 *
 * Prerequisites:
 *   - `opencode serve` must be running (default: http://127.0.0.1:4096)
 *   - Optionally set OPENCODE_SERVER_PASSWORD for auth
 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly type = "opencode" as const;
  readonly name = "OpenCode";

  private baseUrl: string;
  private headers: Record<string, string> = {};

  constructor(config: { baseUrl?: string; password?: string } = {}) {
    this.baseUrl = config.baseUrl || process.env.OPENCODE_URL || "http://127.0.0.1:4096";
    const password = config.password || process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    if (password) {
      this.headers["Authorization"] = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }
  }

  async init(): Promise<void> {
    try {
      const res = await this.fetch("/global/health");
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    } catch (err) {
      throw new Error(
        `Cannot connect to OpenCode at ${this.baseUrl}. Make sure 'opencode serve' is running. Error: ${(err as Error).message}`
      );
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await this.fetchJson<Array<{
      id: string; title?: string; path?: string; createdAt?: string;
      updatedAt?: string; model?: string; costUsd?: number;
    }>>("/session");

    // Get statuses for all sessions
    let statuses: Record<string, { status?: string; needsPermission?: boolean; permission?: { id: string; type: string; description: string; toolName?: string; details?: string } }> = {};
    try {
      statuses = await this.fetchJson<Record<string, unknown>>("/session/status") as typeof statuses;
    } catch {
      // status endpoint may fail
    }

    return Promise.all(sessions.map(async (s) => {
      const st = statuses[s.id] as typeof statuses[string] | undefined;
      const status = this.mapStatus(st?.status);
      const perm = st?.permission as { id: string; type: string; description: string; toolName?: string; details?: string } | undefined;

      // Try to get last message from the session messages endpoint
      let lastMessage: string | undefined;
      try {
        const messages = await this.fetchJson<Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>>(
          `/session/${s.id}/message?limit=1`
        );
        if (messages && messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.content) {
            if (typeof last.content === "string") {
              lastMessage = last.content.slice(0, 300);
            } else if (Array.isArray(last.content)) {
              const textBlock = last.content.find((b) => b.type === "text");
              if (textBlock?.text) lastMessage = textBlock.text.slice(0, 300);
            }
          }
        }
      } catch {
        // messages endpoint may not exist or may fail
      }

      return {
        id: s.id,
        harness: "opencode",
        status,
        title: s.title || "Untitled session",
        cwd: s.path || process.cwd(),
        lastActivity: s.updatedAt || s.createdAt || new Date().toISOString(),
        model: s.model,
        needsPermission: st?.needsPermission === true || !!perm,
        permissionDetails: perm ? {
          id: perm.id,
          type: perm.type,
          description: perm.description,
          toolName: perm.toolName,
          details: perm.details,
        } : undefined,
        costUsd: s.costUsd,
        durationSec: s.createdAt ? (Date.now() - new Date(s.createdAt).getTime()) / 1000 : undefined,
        lastMessage,
        meta: { createdAt: s.createdAt },
      };
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    return all.find((s) => s.id === id) || null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.queue) {
      const res = await this.fetch(`/session/${id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: options.message }],
        }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    }

    const res = await this.fetch(`/session/${id}/message`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: options.message }],
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.fetch(`/session/${id}/abort`, { method: "POST" });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.fetch(`/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response, remember }),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    const updates: Record<string, unknown> = {};
    if (options.allowedTools) {
      updates.allowedTools = options.allowedTools.split(",").map((t) => t.trim());
    }
    if (options.mode) {
      updates.permissionMode = options.mode;
    }
    const res = await this.fetch("/config", {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    // OpenCode supports changing model via PATCH /config or per-session
    // Try per-session first, then fall back to global config
    try {
      const res = await this.fetch(`/session/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ model }),
      });
      if (res.ok) return { ok: true };
    } catch {
      // Per-session change not supported, try global
    }

    // Fall back to global config change
    try {
      const res = await this.fetch("/config", {
        method: "PATCH",
        body: JSON.stringify({ model }),
      });
      if (res.ok) {
        return { ok: true, error: `Model changed to '${model}' globally (applies to new messages in all sessions).` };
      }
      return { ok: false, error: `Failed to change model: HTTP ${res ? res.status : "no response"}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listModels(): Promise<string[]> {
    // OpenCode uses provider-based model names
    // Try to fetch from config, otherwise return common ones
    try {
      const config = await this.fetchJson<{ model?: string; provider?: string; models?: string[] }>("/config");
      if (config.models) return config.models;
      if (config.model) return [config.model];
    } catch { /* fallback */ }

    return [
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-3-5-sonnet-20241022",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "ollama/llama3",
      "ollama/codellama",
    ];
  }

  async getTranscript(id: string): Promise<string | null> {
    try {
      const messages = await this.fetchJson<Array<{
        role?: string; content?: string | Array<{ type?: string; text?: string; input?: Record<string, unknown> }>;
      }>>(`/session/${id}/message?limit=200`);

      if (!messages || messages.length === 0) return null;

      const parts: string[] = [];
      for (const msg of messages) {
        const role = msg.role || "unknown";
        if (typeof msg.content === "string") {
          parts.push(`${role}: ${msg.content.slice(0, 2000)}`);
        } else if (Array.isArray(msg.content)) {
          const textParts: string[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
          }
          if (textParts.length > 0) parts.push(`${role}: ${textParts.join(" ").slice(0, 2000)}`);
        }
      }
      return parts.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  // ---- helpers ----

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await this.fetch(path);
    if (!res.ok) throw new Error(`OpenCode API ${path}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  private mapStatus(raw?: string): AgentSession["status"] {
    switch (raw) {
      case "running": return "running";
      case "idle": return "idle";
      case "waiting": return "needs_input";
      default: return "idle";
    }
  }
}