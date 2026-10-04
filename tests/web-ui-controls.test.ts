import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesSessionQuery } from "../src/web-ui/session-list.js";

const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/styles.css", import.meta.url), "utf8");

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
    expect(main).toContain('/api/session-autostart/sessions/');
    expect(main).toContain('/api/session-autostart/harnesses/codex');
    expect(main).toContain('/api/session-autostart/harnesses/zcode');
    expect(main).toContain('aria-label={`Autocontinue unfinished session ${activeSession.id}`}');
    expect(main).toContain('Умное автопродолжение каждые 10 минут');
    expect(main).toContain('работает независимо от автопилота');
    expect(main).toContain('aria-label="Глобальное автопродолжение"');
    expect(main).toContain('Продолжить задачу в новой сессии');
    expect(main).toContain('Переносить закрепление на продолжение');
    expect(main).toContain('сначала закрепит новую Codex/ZCode сессию, затем снимет закрепление со старых');
    expect(main).toContain('provider-cache TTL');
    expect(main).toContain('className="settings-group session-autocontinue-setting"');
    expect(main).toContain('Искать сессии за последние часы');
    expect(main).toContain('Сколько сообщений читать на сессию');
    expect(main).toContain('потолок 512 тыс.');
    expect(main).toContain('Срочно будить умершие и зависшие сессии');
    expect(main).toContain('Watchdog проверяет native process/turn отдельно от обычного TTL');
    expect(main).toContain('Модель автопродолжения');
    expect(main).toContain('Модель автопилота');
    expect(main).toContain('/api/models?harness=');
    expect(main).toContain('/api/autopilot/policy');
    expect(main).toContain('new EventSource(`/api/events/stream?after=${cursor}`)');
    expect(main).toContain('agent-herder.event-cursor');
    expect(main).toContain('30_000');
    expect(main).toContain('Глобальный автопилот');
    expect(main).toContain('30 минут без ответа');
    expect(main).toContain('Последний запрос пользователя');
    expect(main).toContain('Последний ответ агента');
    expect(main).toContain('Почему нужен выбор');
    for (const harness of ["Codex", "Claude Code", "OpenCode", "Hermes"]) expect(main).toContain(harness);
  });

  it("exposes autocontinue and autopilot as separate top-level settings", () => {
    const headerStart = main.indexOf('<div className="header-actions">');
    const headerEnd = main.indexOf("</header>", headerStart);
    const header = main.slice(headerStart, headerEnd);

    expect(headerStart).toBeGreaterThan(-1);
    expect(header).toContain('aria-label="Открыть настройки автопродолжения"');
    expect(header).toContain('aria-label="Открыть настройки автопилота"');
    expect(header.indexOf("Открыть настройки автопродолжения")).toBeLessThan(header.indexOf("Открыть настройки автопилота"));
  });

  it("puts live agent activity immediately above the composer and never leaves autocontinue below it", () => {
    const activityStart = main.indexOf('<div className={`agent-activity-strip');
    const composerStart = main.indexOf('<form className="composer"', activityStart);

    expect(activityStart).toBeGreaterThan(-1);
    expect(activityStart).toBeLessThan(composerStart);
    expect(main.slice(activityStart, composerStart)).toContain('role="status"');
    expect(main.slice(activityStart, composerStart)).toContain('aria-live="polite"');
    expect(main.slice(composerStart)).not.toContain('className="autopilot-control session-autostart-control"');
    expect(styles).toContain('.composer-stack { position: relative; width: min(860px, calc(100% - 40px)); margin: 0 auto 22px;');
  });

  it("keeps automation modes discoverable on mobile with their current state", () => {
    expect(main).toContain('aria-label="Открыть меню режимов"');
    expect(main).toContain('Автопродолжение: ${runtimeSettingsDraft?.enabled ? "включено" : "выключено"}');
    expect(main).toContain('Автопилот: ${(autopilotSession?.enabled ?? autopilotPolicyDraft?.enabled) ? "включён" : "выключен"}');
    expect(styles).toContain('.header-actions .mobile-automation-button { display: inline-flex;');
    expect(styles).toContain('.header-actions .desktop-chat-menu { display: none; }');
  });

  it("keeps autocontinue and autopilot mutations on separate endpoints and state", () => {
    const autopilotHandler = main.slice(main.indexOf("const saveAutopilotPolicy = async () => {"), main.indexOf("const toggleContinuationHarness = async"));
    const autocontinueHandler = main.slice(main.indexOf("const toggleContinuationHarness = async"), main.indexOf("const loadRuntimeModels = React.useCallback"));
    const globalAutocontinueHandler = main.slice(main.indexOf("const toggleGlobalContinuation = async"), main.indexOf("const saveRuntimeSettings = async"));

    expect(autopilotHandler).toContain("/api/autopilot/policy");
    expect(autopilotHandler).not.toContain("/api/session-autostart/harnesses/");
    expect(autocontinueHandler).toContain("/api/session-autostart/harnesses/");
    expect(autocontinueHandler).not.toContain("/api/autopilot/policy");
    expect(globalAutocontinueHandler).toContain('"/api/session-autostart"');
    expect(globalAutocontinueHandler).not.toContain("/api/autopilot/policy");
  });

  it("exposes active-session pinning as an autocontinue setting", () => {
    const autocontinue = main.slice(main.indexOf('if (section === "autocontinue")'), main.indexOf("if (!draft)"));

    expect(autocontinue).toContain("Сразу закреплять активные сессии");
    expect(autocontinue).toContain("pinActiveSessions");
    expect(autocontinue).toContain("Herder не снимает этот pin после завершения");
    expect(main.slice(main.indexOf("const saveRuntimeSettings = async"))).toContain("pinActiveSessions: runtimeSettingsDraft.pinActiveSessions ?? true");
  });

  it("loads autocontinue independently when the autopilot policy endpoint fails", () => {
    expect(main).toContain("Promise.allSettled");
    expect(main).toContain("setContinuationHarnessError(continuationResult.reason");
    expect(main).toContain("setRuntimeSettingsError(runtimeResult.reason");
    expect(main.indexOf('if (section === "autocontinue")')).toBeLessThan(main.indexOf("if (!draft)"));
  });

  it("uses quick detail refreshes for SSE instead of continuously rehydrating full history", () => {
    const streamStart = main.indexOf("const stream = new EventSource");
    const streamEnd = main.indexOf("React.useLayoutEffect", streamStart);
    const streamEffect = main.slice(streamStart, streamEnd);

    expect(main).toContain("loadDetails(activeKey, false)");
    expect(streamEffect).not.toContain("?limit=50");
  });
});
