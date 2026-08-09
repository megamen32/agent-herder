import { describe, expect, it } from "vitest";
import { filterAndArrangeSessions, type SessionListSettings } from "../src/web-ui/session-list.js";

const sessions = [
  { id: "parent", harness: "codex", title: "Parent", cwd: "/work/alpha", status: "idle", lastActivity: "2026-08-09T10:00:00Z", meta: {} },
  { id: "child", harness: "codex", title: "Child", cwd: "/work/alpha", status: "running", lastActivity: "2026-08-09T11:00:00Z", meta: { parentSessionKey: "codex:parent" } },
  { id: "other", harness: "opencode", title: "Other", cwd: "/work/beta", status: "stopped", lastActivity: "2026-08-09T09:00:00Z", meta: {} },
];

const defaults: SessionListSettings = { cwd: "", project: "", harness: "", sort: "activity" };

describe("session list settings", () => {
  it("filters by cwd, project, and harness", () => {
    expect(filterAndArrangeSessions(sessions, { ...defaults, cwd: "/work/alpha" }, new Set()).map((entry) => entry.session.id)).toEqual(["parent", "child"]);
    expect(filterAndArrangeSessions(sessions, { ...defaults, project: "/work/alpha" }, new Set()).map((entry) => entry.session.id)).toEqual(["parent", "child"]);
    expect(filterAndArrangeSessions(sessions, { ...defaults, harness: "opencode" }, new Set()).map((entry) => entry.session.id)).toEqual(["other"]);
  });

  it("sorts roots and keeps children folded beneath their parent", () => {
    const arranged = filterAndArrangeSessions(sessions, { ...defaults, sort: "title" }, new Set(["codex:parent"]));
    expect(arranged.map((entry) => [entry.session.id, entry.depth])).toEqual([["other", 0], ["parent", 0]]);

    const expanded = filterAndArrangeSessions(sessions, { ...defaults, sort: "title" }, new Set());
    expect(expanded.map((entry) => [entry.session.id, entry.depth])).toEqual([["other", 0], ["parent", 0], ["child", 1]]);
  });
});
