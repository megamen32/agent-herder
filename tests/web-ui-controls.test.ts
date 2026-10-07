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
    expect(main).toContain('aria-label="Поиск сессий"');
    expect(main).toContain('aria-label="Меню чата"');
    expect(main).toContain('aria-label="Прокрутить к последним"');
    expect(main).toContain("scrollToBottom");
    expect(main).toContain("chatMenuOpen");
    expect(main).toContain("subagents-panel");
    expect(main).toContain("details.children.length");
    expect(main).toContain("setSessions(nextSessions);");
    expect(main).toContain('aria-label="Прокрутить к последним"');
    expect(main).toContain('aria-label={isResumeMode ? "Продолжить сессию" : "Отправить сообщение"}');
    expect(main).toContain('{isResumeMode ? "▶" : "↑"}');
    expect(main).toContain("details?.children?.length");
    expect(main).toContain('aria-label="Показывать все сессии"');
    expect(main).toContain('aria-label={`Выбрать: ${choice.label}`}');
    expect(main).toContain('/api/autopilot/choices?status=pending');
    expect(main).toContain('/api/autopilot/choices/select');
    expect(main).toContain('meta: { decisionOnly: true }');
    expect(main).toContain('role="switch"');
    expect(main).toContain('/api/autopilot/sessions/');
    expect(main).toContain('aria-label={`Автопилот для сессии ${activeSession.id}`}');
    expect(main).toContain('/api/session-autostart/sessions/');
    expect(main).toContain('/api/session-autostart/harnesses/codex');
    expect(main).toContain('/api/session-autostart/harnesses/zcode');
    expect(main).toContain('aria-label={`Автопродолжение для сессии ${activeSession.id}`}');
    expect(main).toContain('Где разрешено восстановление');
    expect(main).toContain('Если автопилот выключен, восстановление после сбоя всё равно работает');
    expect(main).toContain('aria-label="Глобальное автопродолжение"');
    expect(main).toContain('Восстановление после сбоя');
    expect(main).toContain('После ошибки выполнения');
    expect(main).toContain('После разрыва соединения');
    expect(main).toContain('recoverOnFailure');
    expect(main).toContain('recoverOnDisconnect');
    expect(main).toContain('явно остановленные человеком');
    expect(main).toContain('className="autopilot-control session-autostart-control"');
    expect(main).toContain('Восстанавливать зависшую работу по таймауту');
    expect(main).toContain('только после заданного времени без прогресса');
    expect(main).toContain('Модель автопилота');
    expect(main).toContain('/api/models?harness=');
    expect(main).toContain('/api/autopilot/policy');
    expect(main).toContain('new EventSource(`/api/events/stream?after=${cursor}`)');
    expect(main).toContain('agent-herder.event-cursor');
    expect(main).toContain('30_000');
    expect(main).toContain('Глобальный автопилот');
    expect(main).toContain('{timeoutMinutes} минут без ответа');
    expect(main).toContain('Последний запрос пользователя');
    expect(main).toContain('Последний ответ агента');
    expect(main).toContain('Почему нужен выбор');
    for (const harness of ["Codex", "Claude Code", "OpenCode", "Hermes"]) expect(main).toContain(harness);
  });

  it("shows every automation control supported by the active harness", () => {
    const headerStart = main.indexOf('<div className="header-actions">');
    const headerEnd = main.indexOf("</header>", headerStart);
    const header = main.slice(headerStart, headerEnd);
    const menuStart = main.indexOf('<div className="chat-menu"');
    const menuEnd = main.indexOf("</div>", main.indexOf("Квота</button>"));
    const menu = main.slice(menuStart, menuEnd);

    expect(headerStart).toBeGreaterThan(-1);
    expect(menuStart).toBeGreaterThan(-1);
    expect(main).toContain('const AUTOCONTINUE_HARNESSES = new Set(["codex", "zcode"])');
    expect(header).toContain("activeHarnessSupportsAutocontinue");
    expect(header).toContain("activeHarnessSupportsAutopilot");
    expect(header).toContain('>Автопродолжение<span className={`toggle-dot');
    expect(header).toContain('>Автопилот<span className={`toggle-dot');
    expect(header).toContain("activeAutocontinueEnabled");
    expect(header).toContain('activeAutopilotEnabled');
    expect(menu).toContain('Автопродолжение · восстановление после сбоев: ${activeAutocontinueEnabled ? "включено" : "выключено"}');
    expect(menu).toContain('Автопилот · завершение задач: ${activeAutopilotEnabled ? "включён" : "выключен"}');
  });

  it("puts live agent activity immediately above the composer and session automation in the inspector", () => {
    const activityStart = main.indexOf('className={`activity-line activity-');
    const composerStart = main.indexOf('<form className="composer"', activityStart);

    expect(activityStart).toBeGreaterThan(-1);
    expect(activityStart).toBeLessThan(composerStart);
    expect(main.slice(activityStart, composerStart)).toContain('role="status"');
    expect(main.slice(activityStart, composerStart)).toContain('aria-live="polite"');
    const inspectorStart = main.indexOf('<aside className="inspector-pane"');
    expect(inspectorStart).toBeGreaterThan(composerStart);
    expect(main.slice(inspectorStart)).toContain('className="autopilot-control session-autostart-control"');
    expect(main.slice(main.indexOf('if (section === "autocontinue")'), main.indexOf("if (!draft)"))).not.toContain("session-autostart-control");
    expect(styles).toContain('.composer-stack { position: relative; width: min(860px, calc(100% - 40px)); margin: 0 auto 22px;');
  });

  it("keeps per-session switches available for every supported capability", () => {
    const inspectorStart = main.indexOf('<aside className="inspector-pane"');
    const inspector = main.slice(inspectorStart);

    expect(inspector).toContain("autopilotSession && <div");
    expect(inspector).toContain('aria-label={`Автопилот для сессии ${activeSession.id}`}');
    expect(inspector).toContain('aria-label={`Автопродолжение для сессии ${activeSession.id}`}');
    expect(inspector).not.toContain("autopilot-policy-disabled");
  });

  it("keeps automation modes discoverable on mobile with their current state", () => {
    expect(main).toContain('aria-label="Открыть настройки автоматизации"');
    expect(main).toContain('>Автоматизация</button>');
    expect(main).toContain('Автопродолжение · восстановление после сбоев: ${activeAutocontinueEnabled ? "включено" : "выключено"}');
    expect(main).toContain('Автопилот · завершение задач: ${activeAutopilotEnabled ? "включён" : "выключен"}');
    expect(styles).toContain('.header-actions .mobile-automation-button { display: inline-flex;');
    expect(styles).toContain('.header-actions .desktop-chat-menu { display: none; }');
    expect(styles).toContain('@media (max-width: 900px)');
    expect(styles).toContain('.inspector-pane { display: flex; position: fixed; inset: 0; z-index: 45;');
  });

  it("addresses focus-group ambiguity around scope, saving, and the active timeout", () => {
    expect(main).toContain("Настроить текущую сессию");
    expect(main).toContain("переопределяет общую только для этой сессии");
    expect(main).toContain("Нажатие создаст исключение только для этой сессии и применится сразу");
    expect(main).toContain("Модель сохранится общей кнопкой");
    expect(main).toContain("Сохранить настройки автопилота");
    expect(main).toContain("Текущие настройки загружены");
    expect(main).toContain("Приоритет: отдельная настройка сессии");
    expect(main).toContain("Если автопилот выключен, восстановление после сбоя всё равно работает");
    expect(main).toContain("Карточка заранее покажет варианты и рекомендацию");
    expect(main).toContain("выключен в общих настройках сред");
    expect(main).toContain("Закрытие оставит их в форме до сохранения или перезагрузки страницы");
    expect(main).not.toContain("Доступно моделей:");
    expect(main).not.toContain("Сохранить модель");
    expect(main).not.toContain("30 минут без ответа (сейчас");
  });

  it("gives the mobile session title its own full-width row", () => {
    expect(styles).toContain('grid-template-areas: "back actions" "heading heading"');
    expect(styles).toContain('.chat-header .chat-heading { grid-area: heading;');
    expect(styles).toContain('.header-actions .automation-setting-button { display: none; }');
    expect(styles).toContain('.load-timings { display: none; }');
  });

  it("opens a session deep link directly in the mobile chat", () => {
    expect(main).toContain('React.useState<"sessions" | "chat">(() => readSessionFromHash() ? "chat" : "sessions")');
    expect(main).toContain('window.addEventListener("hashchange", followHash)');
    expect(main).toContain('setMobileView(key ? "chat" : "sessions")');
    expect(main).toContain('window.removeEventListener("hashchange", followHash)');
  });

  it("uses plain Russian for user-facing automation settings", () => {
    expect(main).toContain("Это общий переключатель");
    expect(main).toContain("Herder не снимает закрепление после завершения");
    expect(main).toContain("после подтверждённой ошибки");
    expect(main).toContain("ожидание ответа или разрешения человека");
    expect(main).toContain("Автопилот решает");
    expect(main).toContain("первый рекомендованный вариант");
    for (const jargon of ["глобальный master", "этот pin", "Judge решает", "рекомендованный Judge вариант", "native process/turn", "Наследуется от harness policy", "Наследовать policy"]) {
      expect(main).not.toContain(jargon);
    }
  });

  it("keeps mobile settings descriptions readable", () => {
    expect(styles).toContain('.global-autopilot-head p, .autopilot-state-banner span, .harness-option small, .settings-help, .timeout-setting small, .runtime-settings-grid label small, .autopilot-control small, .settings-save-row > span');
    expect(styles).toContain('color: var(--text-2); font-size: var(--text-sm); line-height: 1.5;');
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
    expect(autocontinue).toContain("Herder не снимает закрепление после завершения");
    expect(main.slice(main.indexOf("const saveRuntimeSettings = async"))).toContain("pinActiveSessions: runtimeSettingsDraft.pinActiveSessions ?? true");
  });

  it("limits autocontinue to same-session crash recovery and preserves hidden legacy values", () => {
    const autocontinue = main.slice(main.indexOf('if (section === "autocontinue")'), main.indexOf("if (!draft)"));
    const runtimeSave = main.slice(main.indexOf("const saveRuntimeSettings = async"), main.indexOf("const loadCreateModels"));

    expect(autocontinue).toContain("recoverOnFailure: event.target.checked");
    expect(autocontinue).toContain("recoverOnDisconnect: event.target.checked");
    expect(autocontinue).toContain("runtimeDraft.watchdogEnabled ?? false");
    expect(autocontinue).toContain("Завершённые и работающие сессии");
    expect(autocontinue).not.toContain("Продолжить задачу в новой сессии");
    expect(autocontinue).not.toContain("MiniMax проверяет оборванные задачи");
    expect(autocontinue).not.toContain("Модель автопродолжения");
    expect(runtimeSave).toContain("recoverOnFailure: runtimeSettingsDraft.recoverOnFailure ?? true");
    expect(runtimeSave).toContain("recoverOnDisconnect: runtimeSettingsDraft.recoverOnDisconnect ?? true");
    expect(runtimeSave).toContain("rolloverExpiredCache: runtimeSettingsDraft.rolloverExpiredCache ?? false");
    expect(runtimeSave).toContain("movePinnedOnRollover: runtimeSettingsDraft.movePinnedOnRollover ?? false");
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
