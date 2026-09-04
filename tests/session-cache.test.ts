import { describe, expect, it } from "vitest";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const session = (id: string): AgentSession => ({
  id,
  harness: "opencode",
  status: "idle",
  title: id,
  cwd: "/tmp/cache-test",
});

describe("session discovery cache", () => {
  it("serves the warm snapshot while one background refresh is pending", async () => {
    let calls = 0;
    let releaseRefresh!: (sessions: AgentSession[]) => void;
    const adapter: HarnessAdapter = {
      type: "opencode",
      name: "cache test",
      async init() {},
      async listSessions() {
        calls += 1;
        if (calls === 1) return [session("old")];
        return new Promise((resolve) => { releaseRefresh = resolve; });
      },
      async getSession() { return null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const supervisor = new SessionSupervisor(
      new Map([["opencode", adapter]]),
      { async convert() { return { success: true }; } },
      undefined,
      { sessionCacheTtlMs: 0 },
    );

    await expect(supervisor.listSessions()).resolves.toMatchObject([{ id: "old" }]);
    await expect(supervisor.listSessions()).resolves.toMatchObject([{ id: "old" }]);
    expect(calls).toBe(2);

    releaseRefresh([session("new")]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(supervisor.listSessions()).resolves.toMatchObject([{ id: "new" }]);
  });

  it("keeps harness filters working against the cached snapshot", async () => {
    const make = (harness: "opencode" | "codex", id: string): AgentSession => ({ ...session(id), harness });
    const adapter = (harness: "opencode" | "codex", id: string): HarnessAdapter => ({
      type: harness,
      name: harness,
      async init() {},
      async listSessions() { return [make(harness, id)]; },
      async getSession() { return null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    });
    const supervisor = new SessionSupervisor(
      new Map([["opencode", adapter("opencode", "open")], ["codex", adapter("codex", "code")]]),
      { async convert() { return { success: true }; } },
    );

    await expect(supervisor.listSessions({ harness: "codex" })).resolves.toMatchObject([{ id: "code", harness: "codex" }]);
  });
});

describe("SessionSupervisor model cache", () => {
  it("seeds models from historical sessions and lazily merges native models", async () => {
    let resolveModels!: (value: string[]) => void;
    const nativeModels = new Promise<string[]>((resolve) => { resolveModels = resolve; });
    const adapter = {
      type: "codex",
      name: "Codex",
      async init() {},
      async listSessions() {
        return [
          { id: "new", harness: "codex", status: "idle", title: "new", cwd: "/tmp", lastActivity: "2026-09-04T03:00:00.000Z", model: "gpt-new", needsPermission: false },
          { id: "old", harness: "codex", status: "idle", title: "old", cwd: "/tmp", lastActivity: "2026-09-03T03:00:00.000Z", model: "gpt-old", needsPermission: false },
        ];
      },
      async getSession() { return null; },
      async sendMessage() { return { ok: false }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
      async listModels() { return nativeModels; },
    } as any;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as any);
    await supervisor.listSessions();
    const cached = await supervisor.getModels("codex");
    expect(cached.models).toEqual(["gpt-new", "gpt-old"]);
    expect(cached.refreshing).toBe(true);
    resolveModels(["gpt-native", "gpt-new"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshed = await supervisor.getModels("codex");
    expect(refreshed.models).toEqual(["gpt-new", "gpt-old", "gpt-native"]);
  });
});
