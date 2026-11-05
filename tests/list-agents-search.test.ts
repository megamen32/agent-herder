import { describe, expect, it } from "vitest";
import { listAgentsResult } from "../src/mcp-tools/handlers.js";
import type { HarnessAdapter } from "../src/types/index.js";

describe("session inventory search", () => {
  it("searches idle sessions beyond the requested page and paginates matches", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `session-${i}`, harness: "opencode", status: "idle", title: i >= 40 ? `needle ${i}` : "other",
      cwd: "/work", lastActivity: new Date(1700000000000 + i * 1000).toISOString(), needsPermission: false,
    }));
    const adapter = { type: "opencode", listSessions: async ({limit}: {limit:number}) => rows.slice(0,limit) } as unknown as HarnessAdapter;
    const result = await listAgentsResult(new Map([["opencode", adapter]]), {harness:"opencode", query:"needle", limit:3, offset:3});
    expect(result.total).toBe(10);
    expect(result.sessions.map(s => s.id)).toEqual(["session-46", "session-45", "session-44"]);
    expect(result.limited).toBe(true);
  });
});
