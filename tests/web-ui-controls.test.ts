import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesSessionQuery } from "../src/web-ui/session-list.js";

const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

describe("mobile chat and session controls", () => {
  it("searches sessions across title, harness, cwd, and preview", () => {
    const session = { id: "abc", harness: "codex", title: "Deploy API", cwd: "/srv/notify", status: "idle", lastActivity: "", lastMessage: "restart worker" };
    expect(matchesSessionQuery(session, "deploy")).toBe(true);
    expect(matchesSessionQuery(session, "NOTIFY")).toBe(true);
    expect(matchesSessionQuery(session, "telegram")).toBe(false);
  });

  it("exposes the required mobile controls", () => {
    expect(main).toContain('aria-label="Search sessions"');
    expect(main).toContain('aria-label="Chat menu"');
    expect(main).toContain('aria-label="Scroll to latest"');
    expect(main).toContain("scrollToBottom");
    expect(main).toContain("chatMenuOpen");
    expect(main).toContain("subagents-panel");
    expect(main).toContain("details.children.length");
    expect(main).toContain("setSessions(result.sessions);");
  });
});
