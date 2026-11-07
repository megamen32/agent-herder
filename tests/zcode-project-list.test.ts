import { describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

describe("ZCode native project list", () => {
  it("reads projects from the native owner catalog", async () => {
    const call = vi.fn().mockResolvedValue({ projects: [
      { id: "p1", name: "Alpha", hostId: "local", roots: [{ rootPath: "/work/alpha" }] },
      { id: "p2", name: "Beta", hostId: "local", roots: [{ rootPath: "/work/beta" }] },
    ] });
    const adapter = new ZcodeAdapter({ client: { call } as unknown as ZcodeClientLike });
    expect(await adapter.listProjects()).toEqual([{ id: "p1", name: "Alpha" }, { id: "p2", name: "Beta" }]);
    expect(call).toHaveBeenCalledWith("project", "readTree", []);
  });

  it("reports invalid native catalogs instead of presenting an empty list", async () => {
    const adapter = new ZcodeAdapter({ client: { call: vi.fn().mockResolvedValue({}) } as unknown as ZcodeClientLike });
    await expect(adapter.listProjects()).rejects.toThrow("ZCode native project catalog");
  });
});
