import { describe, expect, it } from "vitest";
import { compactSession, lastActivityKey } from "./protocol.js";

describe("mesh lastActivity normalization", () => {
  it("treats a missing or non-string native timestamp as the oldest, not a crash", () => {
    expect(lastActivityKey(undefined)).toBe("");
    expect(lastActivityKey(null)).toBe("");
    expect(lastActivityKey(1793718458)).toBe("");
    expect(lastActivityKey("2026-11-03T15:07:38.000Z")).toBe("2026-11-03T15:07:38.000Z");
  });

  it("compactSession never emits a non-string lastActivity", () => {
    const broken = compactSession("host-1", {
      id: "s1", harness: "codex", cwd: "/tmp", status: "idle", title: "T",
      lastActivity: undefined as unknown as string,
    });
    expect(typeof broken.lastActivity).toBe("string");
    expect(broken.lastActivity).toBe("");
    const numeric = compactSession("host-1", {
      id: "s2", harness: "codex", cwd: "/tmp", status: "idle", title: "T",
      lastActivity: 1793718458 as unknown as string,
    });
    expect(numeric.lastActivity).toBe("");
  });

  it("sorting a mixed snapshot no longer throws (the fleet read crash)", () => {
    const rows = [
      compactSession("host-1", { id: "s1", harness: "codex", cwd: "/tmp", status: "idle", title: "T", lastActivity: "2026-11-03T15:07:38.000Z" }),
      compactSession("host-1", { id: "s2", harness: "codex", cwd: "/tmp", status: "idle", title: "T", lastActivity: undefined as unknown as string }),
      compactSession("host-1", { id: "s3", harness: "codex", cwd: "/tmp", status: "idle", title: "T", lastActivity: "2026-11-03T14:07:38.000Z" }),
    ];
    expect(() => rows.sort((a, b) => lastActivityKey(b.lastActivity).localeCompare(lastActivityKey(a.lastActivity)))).not.toThrow();
    expect(rows[0]!.address.nativeSessionId).toBe("s1");
    expect(rows[2]!.address.nativeSessionId).toBe("s2");
  });
});
