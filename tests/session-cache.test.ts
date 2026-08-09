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
