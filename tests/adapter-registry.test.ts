import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapter-registry.js";
import type { HarnessAdapter } from "../src/types/index.js";

function fakeAdapter(id: string, initError?: string): HarnessAdapter {
  return {
    type: id as HarnessAdapter["type"], name: id, controlCapabilities: { modelSwitch: true },
    async init() { if (initError) throw new Error(initError); },
    async listSessions() { return []; },
    async getSession() { return null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

describe("adapter registry", () => {
  it("adds an adapter only after init succeeds and persists the choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-registry-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    registry.register({ id: "codex", name: "Codex", description: "test", defaultEnabled: false, factory: () => fakeAdapter("codex") });

    const result = await registry.setEnabled("codex", true);
    expect(result).toMatchObject({ id: "codex", enabled: true, active: true, status: "active" });
    expect(adapters.has("codex")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "adapters.json"))).enabled.codex).toBe(true);
  });

  it("reports a failed init without activating the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-registry-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    registry.register({ id: "zcode", name: "ZCode", description: "test", defaultEnabled: false, factory: () => fakeAdapter("zcode", "offline") });

    const result = await registry.setEnabled("zcode", true);
    expect(result).toMatchObject({ id: "zcode", enabled: false, active: false, status: "error", error: "offline" });
    expect(adapters.has("zcode")).toBe(false);
  });
});
