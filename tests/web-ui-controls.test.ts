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
    expect(main).toContain("setSessions(nextSessions);");
    expect(main).toContain('aria-label="Scroll to latest"');
    expect(main).toContain('aria-label={isResumeMode ? "Resume session" : "Send message"}');
    expect(main).toContain('{isResumeMode ? "▶" : "↑"}');
    expect(main).toContain("details?.children?.length");
    expect(main).toContain('aria-label="Show all sessions"');
    expect(main).toContain('aria-label={`Choose ${choice.label}`}');
    expect(main).toContain('/api/autopilot/choices?status=pending');
    expect(main).toContain('/api/autopilot/choices/select');
    expect(main).toContain('meta: { decisionOnly: true }');
    expect(main).toContain('role="switch"');
    expect(main).toContain('/api/autopilot/sessions/');
    expect(main).toContain('aria-label={`Autopilot for ${activeSession.id}`}');
    expect(main).toContain('/api/autopilot/policy');
    expect(main).toContain('Глобальный автопилот');
    expect(main).toContain('30 минут без ответа');
    expect(main).toContain('Последний запрос пользователя');
    expect(main).toContain('Последний ответ агента');
    expect(main).toContain('Почему нужен выбор');
    for (const harness of ["Codex", "Claude Code", "OpenCode", "Hermes"]) expect(main).toContain(harness);
  });
});
