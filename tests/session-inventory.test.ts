import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/types/index.js";
import { projectSessionInventory } from "../src/web/session-inventory.js";

describe("fleet inventory projection", () => {
  it("retains every historical identity without conversation or secret metadata", () => {
    const sessions = ["running", "idle", "stopped", "error"].map((status, index) => ({
      id: `sess-${index}`, harness: "zcode", cwd: "/project", status,
      title: "SECRET_TITLE", lastActivity: "2026-10-08T00:00:00Z", needsPermission: false,
      lastMessage: "SECRET_DIALOGUE", meta: { apiKey: "SECRET_KEY", messages: [{ text: "SECRET_MESSAGE" }],
        persistedTaskStatus: status, nativeTimeUpdated: 123, humanStopHeld: false,
        nativeLastTurn: { turnId: "turn-id", status: "completed", requiresHuman: true, blockedReason: "SECRET_REASON" } },
    }) as AgentSession);
    const projected = projectSessionInventory(sessions);
    expect(projected.map((entry) => entry.id)).toEqual(sessions.map((entry) => entry.id));
    expect(projected.map((entry) => entry.status)).toEqual(["running", "idle", "stopped", "error"]);
    expect(projected.every((entry) => entry.nativeTurnStatus === "completed" && entry.nativeBlocked && entry.requiresHuman)).toBe(true);
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("taskComplete");
    expect(encoded).not.toContain("lastMessage");
    expect(sessions[0].meta?.apiKey).toBe("SECRET_KEY");
  });
  it("preserves unknown native blocker evidence as unknown", () => {
    const [entry] = projectSessionInventory([{ id: "historical", harness: "zcode", cwd: "/project", status: "idle", title: "", lastActivity: "2026-10-08T00:00:00Z", needsPermission: false }]);
    expect(entry.nativeBlocked).toBeUndefined();
    expect(entry.requiresHuman).toBeUndefined();
    expect(entry.nativeTurnStatus).toBeUndefined();
  });

});
