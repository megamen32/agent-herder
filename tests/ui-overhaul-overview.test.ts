import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";

// Focused unit test for the new list() method and the shape of the overview
// payload. No HTTP, no MCP, no model calls — runs in <200ms.

describe("AutopilotSessionStore.list for the overview endpoint", () => {
  let dir: string;
  let store: AutopilotSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ap-overview-"));
    store = new AutopilotSessionStore(join(dir, "sessions.json"));
  });

  afterEach(async () => {
    try { await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })); } catch { /* tmpdir cleans itself */ }
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns every enabled session override after set()", async () => {
    await store.set({ harness: "zai", sessionId: "abc", cwd: "/tmp/proj" }, true);
    await store.set({ harness: "chatgpt", sessionId: "xyz", cwd: "/tmp/proj" }, true);
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.harness).sort()).toEqual(["chatgpt", "zai"]);
  });

  it("returns disabled overrides too — the overview filter drops them", async () => {
    await store.set({ harness: "zai", sessionId: "on", cwd: "/tmp" }, true);
    await store.set({ harness: "zai", sessionId: "off", cwd: "/tmp" }, false);
    const list = await store.list();
    expect(list).toHaveLength(2);
    const enabled = list.filter((s) => s.enabled === true);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.sessionId).toBe("on");
  });

  it("survives a delete and reflects the remaining set", async () => {
    await store.set({ harness: "zai", sessionId: "x", cwd: "/tmp" }, true);
    await store.set({ harness: "zai", sessionId: "y", cwd: "/tmp" }, true);
    await store.delete("zai", "x");
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe("y");
  });
});
