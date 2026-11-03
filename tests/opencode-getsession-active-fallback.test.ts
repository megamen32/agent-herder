import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

describe("opencode getSession agrees with the active list", () => {
  const row = { id: "ses_live", harness: "opencode", title: "live", cwd: "/x", hostId: "h", status: "running", lastActivity: new Date(0).toISOString() };
  it.each([["null", () => Promise.resolve(null)], ["throw", () => Promise.reject(new Error("boom"))]])("falls back to the active list when the detailed read yields %s", async (_n, impl) => {
    const adapter = new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:1" } as never);
    vi.spyOn((adapter as any).client, "getSession").mockImplementation(impl as never);
    vi.spyOn(adapter, "listActiveSessions").mockResolvedValue([row as never]);
    expect((await adapter.getSession("ses_live"))?.id).toBe("ses_live");
    expect(await adapter.getSession("ses_other")).toBeNull();
  });
});
