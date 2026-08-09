import { describe, expect, it } from "vitest";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { HarnessAdapter } from "../src/types/index.js";

describe("lazy adapter polling", () => {
  it("does not start an unready lazy adapter during dashboard discovery", async () => {
    let listed = 0;
    const adapter: HarnessAdapter = {
      type: "codex",
      name: "lazy codex",
      lazyStart: true,
      isReady: () => false,
      async init() {},
      async listSessions() { listed += 1; return []; },
      async getSession() { return null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } });
    expect(await supervisor.listSessions()).toEqual([]);
    expect(listed).toBe(0);
  });
});
