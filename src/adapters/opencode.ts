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
    const sessions = await this.fetchJson<{ id: string; title?: string; path?: string; createdAt?: string; updatedAt?: string; model?: string; costUsd?: number }[]>("/session");

    // Get statuses for all sessions
    let statuses: Record<string, { status?: string; needsPermission?: boolean; permission?: { id: string; type: string; description: string; toolName?: string; details?: string } }> = {};
    try {
      statuses = await this.fetchJson<Record<string, unknown>>("/session/status") as typeof statuses;
    } catch {
      // status endpoint may fail, we'll derive status from other data
    }

    return sessions.map((s) => {
      const st = statuses[s.id] as typeof statuses[string] | undefined;
      const status = this.mapStatus(st?.status);
      const perm = st?.permission as { id: string; type: string; description: string; toolName?: string; details?: string } | undefined;

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
        meta: { createdAt: s.createdAt },
      };
    });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    return all.find((s) => s.id === id) || null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.queue) {
      // Async — fire and forget
      const res = await this.fetch(`/session/${id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: options.message }],
        }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    }

    // Synchronous — wait for response
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
    // OpenCode handles permissions via config, not per-session.
    // We can update the config PATCH endpoint.
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