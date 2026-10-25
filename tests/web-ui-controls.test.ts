import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesSessionQuery } from "../src/web-ui/session-list.js";
import { DEFAULT_THEME, applyTheme, normalizeTheme, readTheme, writeTheme } from "../src/web-ui/theme.js";
import { currentModelOption, modelSwitchSupported, requestModelChange, shortModelLabel } from "../src/web-ui/model-chip.js";
import {
  acquireCurrentVoiceStream,
  attemptQueueProcessingResume,
  queueProcessingCanResume,
  queueProcessingIntentCanClearOnReadback,
  queueProcessingIntentStorageKey,
  type QueueProcessingState,
} from "../src/web-ui/composer-controls.js";
import { readSessionQueueProcessing, submitSessionQueueProcessing } from "../src/web-ui/fleet/RemoteSessionView.js";

const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");
const composerControls = readFileSync(new URL("../src/web-ui/composer-controls.tsx", import.meta.url), "utf8");
const remoteComposer = readFileSync(new URL("../src/web-ui/fleet/RemoteSessionView.tsx", import.meta.url), "utf8");
const polish = readFileSync(new URL("../src/web-ui/interface-polish.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/styles.css", import.meta.url), "utf8");
const themeCss = readFileSync(new URL("../src/web-ui/codex-theme.css", import.meta.url), "utf8");
const themeHtml = readFileSync(new URL("../src/web-ui/index.html", import.meta.url), "utf8");

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
};

const queueTarget={hostId:"server-100",harness:"zcode",sessionId:"fixture-session"};
const queueState=(patch:Partial<QueueProcessingState>={}):QueueProcessingState=>({
  ...queueTarget,scope:"session",loaded:true,canResume:true,capability:"setAutoDrain",revision:7,
  autoDrain:false,pendingCount:2,oldestQueueItemId:"oldest",nativeStatus:"completed",...patch,
});

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
    expect(main).toContain('label={queueEdit?"Сохранить сообщение очереди":isResumeMode?"Продолжить сессию":"Отправить сообщение"}');
    expect(composerControls).toContain('aria-label={busy ? "Отправляю сообщение" : label}');
    expect(main).toContain('className="send-open-icon"');
    expect(main).toContain('title={queueEdit?"Сохранить изменения в том же сообщении очереди":isResumeMode?"Возобновить работу в той же сессии"');
    expect(main).toContain("details?.children?.length");
    expect(main).toContain("SESSION_LIST_SHOW_COMPLETED_ARIA");
    expect(main).toContain("SESSION_LIST_SHOW_COMPLETED_LABEL");
    expect(main).toContain('aria-label={`Выбрать: ${choice.label}`}');
    expect(main).toContain('/api/autopilot/choices?status=pending');
    expect(main).toContain('/api/autopilot/choices/select');
    expect(main).toContain('meta: { decisionOnly: true }');
    expect(main).toContain('role="switch"');
    expect(main).toContain('/api/autopilot/sessions/');
    expect(main).toContain('aria-label="Автопилот для текущей сессии"');
    expect(main).toContain('/api/session-autostart/sessions/');
    expect(main).toContain('loadAutocontinueHarnesses(api)');
    expect(main).toContain('aria-label="Автопродолжение для текущей сессии"');
    expect(main).toContain('Где разрешено восстановление');
    expect(main).toContain('Если автопилот выключен, восстановление после сбоя всё равно работает');
    expect(main).toContain('aria-label="Общее автопродолжение"');
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
    expect(main).toContain('Общий автопилот');
    expect(main).toContain('{timeoutMinutes} мин без ответа');
    expect(main).toContain('Последний запрос пользователя');
    expect(main).toContain('Последний ответ агента');
    expect(main).toContain('Почему нужен выбор');
    for (const harness of ["Codex", "Claude Code", "OpenCode", "Hermes"]) expect(main).toContain(harness);
  });

  for (const invalidation of ["session switch", "view unmount"]) {
    it(`stops a late microphone permission result after ${invalidation}`, async () => {
      let resolveRequest!: (stream: MediaStream) => void;
      let current = true;
      let stoppedTracks = 0;
      let recordersCreated = 0;
      let transcriptionRequests = 0;
      const stream = { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] } as unknown as MediaStream;
      const request = new Promise<MediaStream>((resolve) => { resolveRequest = resolve; });
      const acquiring = acquireCurrentVoiceStream(() => request, () => current);

      current = false;
      resolveRequest(stream);
      const acquired = await acquiring;
      if (acquired) {
        recordersCreated += 1;
        transcriptionRequests += 1;
      }

      expect(acquired).toBeUndefined();
      expect(stoppedTracks).toBe(1);
      expect(recordersCreated).toBe(0);
      expect(transcriptionRequests).toBe(0);
    });
  }

  it("keeps composer submission explicit and offers a deliberate send-mode hold menu", () => {
    expect(main).not.toContain("composer-hint");
    expect(main).not.toContain(">+ Фото</button>");
    expect(main).toContain('aria-label="Прикрепить изображение"');
    expect(main).toContain("isComposerSubmitShortcut(event)");
    expect(composerControls).toMatch(/\/mac\|iphone\|ipad\|ipod\/i\.test\(os\) \? event\.metaKey : event\.ctrlKey/);
    expect(composerControls).toContain("}, 550);");
    expect(composerControls).toContain('role="dialog"');
    expect(composerControls).toContain('aria-label="Выберите режим отправки"');
    expect(composerControls).toContain("onSend(mode)");
    expect(main).toContain("<ComposerSendControl");
    expect(main).toContain("<VoiceComposerControl");
    expect(remoteComposer).toContain("isComposerSubmitShortcut(e)");
    expect(remoteComposer).toContain("<ComposerSendControl");
    expect(remoteComposer).toContain("<VoiceComposerControl");
    expect(remoteComposer).not.toContain("composer-hint");
    expect(styles).toContain(".composer-send-mode-menu");
    expect(composerControls).toContain('form.append("audio", blob, `voice-input.${extension}`)');
    expect(composerControls).toContain('fetch("/api/composer/transcription"');
    expect(composerControls).toContain("onTranscript(body.text.trim(), key)");
    expect(composerControls).toContain("discard.current = true;");
    expect(composerControls).toContain('className="composer-voice-error" role="alert"');
    expect(main).not.toContain('sendMessage(transcript)');
    expect(remoteComposer).toContain('setText(current=>current?');
  });

  it("shows every automation control supported by the active harness", () => {
    const headerStart = main.indexOf('<div className="header-actions">');
    const headerEnd = main.indexOf("{chatMenuOpen &&", headerStart);
    const header = main.slice(headerStart, headerEnd);
    // Один список настроек на весь экран: и меню чата, и шестерёнка в шапке.
    const menuStart = main.indexOf('const chatMenuContent = (');
    const menuEnd = main.indexOf("Квота</button>", menuStart);
    const menu = main.slice(menuStart, menuEnd);

    expect(headerStart).toBeGreaterThan(-1);
    expect(menuStart).toBeGreaterThan(-1);
    expect(main).toContain('const AUTOCONTINUE_HARNESSES = new Set<string>(AUTOCONTINUE_HARNESS_IDS)');
    expect(header).toContain('aria-label="Панель сессии"');
    expect(header).toContain('aria-label="Меню чата"');
    for (const label of ['>Машины<', '>Задачи<', '>Статистика<', '>Автопилот<', '>Автопродолжение<']) expect(header).not.toContain(label);
    expect(main).toContain('onMachines={() => { setShowSearch(false); setFleetCreationMode(false);setShowFleet(true)');
    expect(main).toContain('>Автопилот</button>');
    expect(main).toContain('>Автопродолжение</button>');
    expect(menu).toContain('Автопродолжение · общие настройки (в этом чате ${activeAutocontinueEnabled ? "включено" : "выключено"})');
    expect(menu).toContain('Автопилот · общие настройки (в этом чате ${activeAutopilotEnabled ? "включён" : "выключен"})');
    expect(main).toContain('<div className="chat-menu" aria-label="Меню чата"><button type="button" className="chat-menu-close"');
    expect(main).toContain('{chatMenuContent}</div>}');
    expect(main).toContain('settingsMenu={chatMenuContent}');
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
    expect(inspector).toContain('aria-label="Автопилот для текущей сессии"');
    expect(inspector).toContain('aria-label="Автопродолжение для текущей сессии"');
    expect(inspector).not.toContain('aria-label={`Автопилот для сессии ${activeSession.id}`}');
    expect(inspector).not.toContain("autopilot-policy-disabled");
  });

  it("keeps automation modes discoverable on mobile with their current state", () => {
    // Правая панель показывается по выбору владельца, и выбор переживает перезагрузку.
    expect(main).toContain('React.useState(() => readPanelLayout())');
    expect(main).toContain('aria-label="Меню чата" aria-expanded={chatMenuOpen}');
    expect(main).toContain('Автопродолжение · общие настройки (в этом чате ${activeAutocontinueEnabled ? "включено" : "выключено"})');
    expect(main).toContain('Автопилот · общие настройки (в этом чате ${activeAutopilotEnabled ? "включён" : "выключен"})');
    expect(polish).toContain('.header-actions .desktop-chat-menu, .header-actions .session-inspector-button { display: grid; }');
    expect(styles).toContain('@media (max-width: 900px)');
    expect(styles).toContain('.inspector-pane { display: flex; flex-direction: column; position: fixed; inset: 0; z-index: 45;');
  });

  it("exposes Machines from the session-list header without selecting or creating a chat", () => {
    const list = main.slice(main.indexOf("function SessionList("), main.indexOf("function App("));
    expect(list).toContain('className="quiet-button sessions-machines-button" onClick={onMachines}>Машины</button>');
    const render = main.slice(main.indexOf('<SessionList '));
    expect(render).toContain('onMachines={() => { setShowSearch(false); setFleetCreationMode(false); setShowFleet(true); setAutomationSettings(undefined); }}');
  });

  it("keeps the existing chat menu available throughout mobile and tablet widths", () => {
    const tablet = polish.slice(polish.indexOf("@media (max-width: 900px)"), polish.indexOf("@media (max-width: 600px)"));
    expect(tablet).toMatch(/\.header-actions \.desktop-chat-menu\s*\{\s*display:\s*grid;/);
    expect(tablet).toMatch(/\.sessions-heading \.sessions-machines-button\s*\{[^}]*display:\s*inline-flex;/);
    expect(tablet).toContain('min-height: 44px');
  });

  it("addresses focus-group ambiguity around scope, saving, and the active timeout", () => {
    expect(main).toContain("Настроить текущую сессию");
    expect(main).toContain("переопределяет общую только для этой сессии");
    expect(main).toContain("Нажатие создаст исключение только для этой сессии и применится сразу");
    expect(main).toContain("Модель сохранится общей кнопкой");
    expect(main).toContain("Сохранить настройки автопилота");
    expect(main).toContain("Текущие настройки загружены");
    expect(main).toContain("Сначала действует настройка конкретной сессии");
    expect(main).toContain("Если автопилот выключен, восстановление после сбоя всё равно работает");
    expect(main).toContain("Карточка заранее покажет варианты и рекомендацию");
    expect(main).toContain("выключен в общих настройках сред");
    expect(main).toContain("Закрытие оставит их в форме до сохранения или перезагрузки страницы");
    expect(main).not.toContain("Доступно моделей:");
    expect(main).not.toContain("Сохранить модель");
    expect(main).not.toContain("30 минут без ответа (сейчас");
  });

  it("keeps automation dialogs and long settings usable", () => {
    expect(main).toContain('role="dialog" aria-modal="true" aria-label="Настройки автоматизации"');
    expect(main).toContain('const trapFocus = (event: KeyboardEvent) => {');
    expect(main).toContain('summary, [href]');
    expect(main).toContain('element.getClientRects().length > 0');
    expect(main).toContain('openSessionInspector(automationSettings === "autocontinue" ? "autocontinue" : "autopilot")');
    expect(main).toContain('if (sessionSettingsReturn) setAutomationSettings(sessionSettingsReturn)');
    expect(main).toContain('className="settings-save-row settings-footer"');
    expect(main).toContain('className="settings-advanced"');
    expect(styles).toContain('.settings-footer { position: sticky;');
  });

  it("opens automation from every top-level view and explains harness capability limits", () => {
    expect(main).toContain('setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("autopilot")');
    expect(main).toContain('Автопродолжение после сбоя для ${AUTOPILOT_HARNESS_LABELS[activeSession.harness as AutopilotHarness]} пока недоступно');
    expect(main).toContain('<span className="chat-menu-section">Вид переписки</span>');
    expect(main).toContain('<span className="chat-menu-section">Автоматизация</span>');
    expect(main).toContain('<span className="chat-menu-section">Разделы</span>');
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
    expect(main).toContain("рекомендованный разрешённый шаг");
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
    expect(autocontinueHandler).toContain("saveAutocontinueHarness(api, harness, !current.enabled)");
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

describe("shared queue-processing control state machine",()=>{
 it("has a shared compact control style for both composer surfaces",()=>{
  expect(composerControls).toContain("export function QueueProcessingControl");
  expect(styles).toContain(".queue-processing-control");
  expect(composerControls).toContain('aria-label="Обработка очереди этой сессии"');
  expect(main).toContain("<QueueProcessingControl target={{hostId:activeSession.hostId");
  expect(remoteComposer).toContain("<QueueProcessingControl target={{hostId:captured.hostId");
  expect(main).toContain("readState={readSessionQueueProcessing} resume={submitSessionQueueProcessing}");
  expect(remoteComposer).toContain("readState={readSessionQueueProcessing} resume={submitSessionQueueProcessing}");
 });

 it("enables only for a fresh exact loaded session with pending work and the V4 capability",()=>{
  const good=queueState();
  expect(queueProcessingCanResume(good,queueTarget,false)).toBe(true);
  expect(queueProcessingCanResume({...good,loaded:false},queueTarget,false)).toBe(false);
  expect(queueProcessingCanResume({...good,scope:"harness"},queueTarget,false)).toBe(false);
  expect(queueProcessingCanResume({...good,capability:undefined},queueTarget,false)).toBe(false);
  expect(queueProcessingCanResume({...good,autoDrain:true},queueTarget,false)).toBe(true);
  expect(queueProcessingCanResume({...good,pendingCount:0},queueTarget,false)).toBe(false);
  expect(queueProcessingCanResume(good,{...queueTarget,hostId:"server-44"},false)).toBe(false);
  expect(queueProcessingCanResume(good,queueTarget,true)).toBe(false);
 });

 it("refreshes a changed revision and never retries the stale CAS",async()=>{
  const storage=memoryStorage();let sends=0;let reads=0;
  const result=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"intent-stale",
   readState:async()=>{reads++;return {available:true,state:queueState({revision:8})};},
   resume:async()=>{sends++;return {inputId:"intent-stale",status:"accepted"};}});
  expect(result).toMatchObject({kind:"stale",state:{revision:8}});
  expect(reads).toBe(1);expect(sends).toBe(0);
  expect(storage.getItem(queueProcessingIntentStorageKey(queueTarget))).toBeNull();
 });

 it("keeps one unknown inputId and blocks every automatic replay",async()=>{
  const storage=memoryStorage();let sends=0;
  const callbacks={readState:async()=>({available:true as const,state:queueState()}),resume:async(_target:typeof queueTarget,request:{inputId:string;expectedRevision:number})=>{sends++;expect(request).toEqual({inputId:"intent-unknown",expectedRevision:7});return {inputId:request.inputId,status:"unknown" as const};}};
  const first=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"intent-unknown",...callbacks});
  const second=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"new-must-not-exist",...callbacks});
  expect(first.kind).toBe("unknown");expect(second).toMatchObject({kind:"unknown",inputId:"intent-unknown"});
  expect(sends).toBe(1);
  expect(storage.getItem(queueProcessingIntentStorageKey(queueTarget))).toContain('"inputId":"intent-unknown"');
 });

 it("does not call native action for unloaded or unsupported scope",async()=>{
  const storage=memoryStorage();let sends=0;
  const result=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,
   readState:async()=>({available:true,state:queueState({loaded:false,canResume:false,reason:"Сессия не загружена."})}),
   resume:async()=>{sends++;return {inputId:"unused",status:"accepted"};}});
  expect(result.kind).toBe("not-ready");expect(result.message).toContain("Сессия не загружена");expect(sends).toBe(0);
  expect(storage.getItem(queueProcessingIntentStorageKey(queueTarget))).toBeNull();
 });

 it("labels preference readback separately from a confirmed native start",async()=>{
  const storage=memoryStorage();
  const attempt=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"intent-accepted",
   readState:async()=>({available:true,state:queueState()}),
   resume:async(_target,request)=>({inputId:request.inputId,status:"accepted",state:queueState({autoDrain:true,revision:8})})});
  expect(attempt.kind).toBe("accepted");
  expect(attempt.message).toContain("Настройка очереди сохранена");
  expect(attempt.message).toContain("начало обработки не подтверждено");
  expect(attempt.message).not.toMatch(/доставлено|сообщение отправлено/i);
  expect(storage.getItem(queueProcessingIntentStorageKey(queueTarget))).toContain('"inputId":"intent-accepted"');
  expect(storage.getItem(queueProcessingIntentStorageKey(queueTarget))).toContain('"status":"accepted"');
  expect(queueProcessingIntentCanClearOnReadback({inputId:"intent-accepted",status:"accepted",acceptedRevision:8},queueState({revision:8}))).toBe(false);
  expect(queueProcessingIntentCanClearOnReadback({inputId:"intent-accepted",status:"accepted",acceptedRevision:8},queueState({revision:7}))).toBe(false);
  expect(queueProcessingIntentCanClearOnReadback({inputId:"intent-accepted",status:"accepted",acceptedRevision:8},queueState({revision:9}))).toBe(true);
 });

 it("locks an accepted response whose native revision regresses behind the pre-write read",async()=>{
  const storage=memoryStorage();let writes=0;
  const result=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState({revision:9}),storage,makeInputId:()=>"intent-regressed",
   readState:async()=>({available:true,state:queueState({revision:9})}),
   resume:async(_target,request)=>{writes++;return{inputId:request.inputId,status:"accepted",state:queueState({autoDrain:true,revision:8})};}});
  expect(result.kind).toBe("unknown");expect(result.message).toContain("readback");
  const firstIntent=storage.getItem(queueProcessingIntentStorageKey(queueTarget));
  expect(firstIntent).toContain('"inputId":"intent-regressed"');expect(firstIntent).toContain('"status":"unknown"');
  const repeat=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState({revision:9}),storage,readState:async()=>({available:true,state:queueState({revision:9})}),resume:async()=>{writes++;return{inputId:"bad",status:"accepted"};}});
  expect(repeat).toMatchObject({kind:"unknown",inputId:"intent-regressed"});expect(writes).toBe(1);
 });

 it("reads exact-session ZCode queue state and reports HumanStop without offering an action",async()=>{
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
   expect(String(input)).toBe("/api/sessions/zcode/fixture-session/queue-processing?hostId=server-100");
   expect(init?.method).toBeUndefined();
   return new Response(JSON.stringify({target:queueTarget,state:{autoDrain:true,baseRevision:7,pendingCount:2,oldestQueueItemId:"oldest",nativeState:"completedSuccess",loaded:true,capability:"setAutoDrain"},canResume:true,humanStopHeld:false}),{status:200});
  };
  const read=await readSessionQueueProcessing(queueTarget,fetcher as typeof fetch);
  expect(read).toMatchObject({available:true,state:{hostId:"server-100",harness:"zcode",sessionId:"fixture-session",revision:7,autoDrain:true,canResume:true,scope:"session"}});
  const held=await readSessionQueueProcessing(queueTarget,async()=>new Response(JSON.stringify({target:queueTarget,state:null,canResume:false,humanStopHeld:true,error:"HumanStop удерживает очередь."}),{status:200}) as Response);
  expect(held).toMatchObject({available:false,reason:"HumanStop удерживает очередь."});
 });

 it("posts once with exact target/CAS and polls the existing durable job without claiming input start",async()=>{
  let posts=0,gets=0;
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
   if(init?.method==="POST"){
    posts++;
    expect(String(input)).toBe("/api/sessions/zcode/fixture-session/queue-processing?hostId=server-100");
    expect(JSON.parse(String(init.body))).toEqual({hostId:"server-100",inputId:"resume-once",expectedRevision:7});
    return new Response(JSON.stringify({target:queueTarget,inputId:"resume-once",state:"queued",nonRetryable:false,job:{id:"job-1",state:"queued",resultRef:"herder://jobs/job-1"}}),{status:202});
   }
   gets++;
   expect(String(input)).toBe("/api/jobs/job-1?hostId=server-100&harness=zcode&sessionId=fixture-session&inputId=resume-once");
   return new Response(JSON.stringify({job:{id:"job-1",state:"completed",result:{ok:true,status:"accepted",inputId:"resume-once",state:{autoDrain:true,baseRevision:8,pendingCount:2,oldestQueueItemId:"oldest",nativeState:"completedSuccess",loaded:true,capability:"setAutoDrain"}}}}),{status:200});
  };
  const result=await submitSessionQueueProcessing(queueTarget,{inputId:"resume-once",expectedRevision:7},{fetcher:fetcher as typeof fetch,pause:async()=>{},maxWaitMs:1000});
  expect(result).toMatchObject({inputId:"resume-once",status:"accepted",state:{revision:8,autoDrain:true}});
  expect(result.nativeInputActuallyStarted).toBeUndefined();
  expect(posts).toBe(1);expect(gets).toBe(1);
 });

 it("locks a terminal HTTP 200 UNKNOWN submission without polling or posting again",async()=>{
  let posts=0,gets=0;
  const fetcher=async(_input:RequestInfo|URL,init?:RequestInit)=>{
   if(init?.method!=='POST'){gets++;return new Response('{}',{status:404});}
   posts++;
   return new Response(JSON.stringify({target:queueTarget,inputId:"resume-unknown",state:"unknown",nonRetryable:true,error:"Ответ владельца не подтверждён."}),{status:200});
  };
  const storage=memoryStorage();
  const first=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"resume-unknown",
   readState:async()=>({available:true,state:queueState()}),resume:(target,request)=>submitSessionQueueProcessing(target,request,{fetcher:fetcher as typeof fetch,pause:async()=>{},maxWaitMs:1000})});
  const second=await attemptQueueProcessingResume({target:queueTarget,displayedState:queueState(),storage,makeInputId:()=>"must-not-regenerate",
   readState:async()=>({available:true,state:queueState()}),resume:(target,request)=>submitSessionQueueProcessing(target,request,{fetcher:fetcher as typeof fetch,pause:async()=>{},maxWaitMs:1000})});
  expect(first.kind).toBe("unknown");expect(second).toMatchObject({kind:"unknown",inputId:"resume-unknown"});
  expect(posts).toBe(1);expect(gets).toBe(0);
 });
});

describe("две темы оформления", () => {
  it("применяет тему до первой отрисовки, чтобы не было вспышки", () => {
    expect(themeHtml).toContain("agent-herder.theme");
    expect(themeHtml).toContain("document.documentElement.dataset.theme");
    expect(themeHtml.indexOf("dataset.theme")).toBeLessThan(themeHtml.indexOf("/main.tsx"));
  });

  it("по умолчанию тёмная, светлая сохраняется в agent-herder.theme", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
    expect(normalizeTheme("мусор")).toBe("dark");
    const storage = memoryStorage();
    expect(readTheme(storage)).toBe("dark");
    writeTheme(storage, "light");
    expect(storage.getItem("agent-herder.theme")).toBe("light");
    expect(readTheme(storage)).toBe("light");
    // возврат к значению по умолчанию не оставляет мусорный ключ
    writeTheme(storage, "dark");
    expect(storage.getItem("agent-herder.theme")).toBeNull();
  });

  it("переключение меняет только атрибут документа — без перезагрузки и без запроса данных", () => {
    const root = { dataset: {} as DOMStringMap };
    applyTheme(root, "light");
    expect(root.dataset.theme).toBe("light");
    expect(main).toContain("applyTheme(document.documentElement, next)");
    expect(main).toContain("writeTheme(window.localStorage, next)");
  });

  it("держит тёмную палитру Codex по умолчанию и светлую как переопределение", () => {
    const darkBlock = themeCss.slice(themeCss.indexOf(":root {"), themeCss.indexOf(':root[data-theme="light"]'));
    const lightBlock = themeCss.slice(themeCss.indexOf(':root[data-theme="light"]'), themeCss.indexOf("body {"));
    // палитра снята с референса: холст не чёрный, панели светлее, текст светлый
    expect(darkBlock).toContain("--bg: #282a36");
    expect(darkBlock).toContain("--surface-1: #2c2c38");
    expect(darkBlock).toContain("--bubble: #323440");
    expect(darkBlock).toContain("--text: #f2f2f7");
    // светлая палитра сохранена как второй вариант
    expect(lightBlock).toContain("--bg: #ffffff");
    expect(lightBlock).toContain("--text: #1c1c1e");
    expect(lightBlock).toContain("--accent: #1f5fd0");
  });

  it("не оставляет цветов, зашитых мимо переменных, — иначе часть интерфейса не переключится", () => {
    // цветом темы считается только hex/rgba в правиле, вне комментария и вне строки с переменной
    const offenders = themeCss.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .map((line, index) => ({ number: index + 1, line }))
      .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line))
      .filter(({ line }) => !line.trimStart().startsWith("--"));
    expect(offenders.map(({ number, line }) => `${number}: ${line.trim()}`)).toEqual([]);
    // статусы очереди отправки тоже переведены на переменные темы
    expect(styles).not.toContain("#ff8f8f");
    expect(styles).toContain(".composer-outbox-entry.status-delivered .composer-outbox-status { color: var(--status-done); }");
    expect(main).toContain("className=\"theme-choice\"");
  });
});

describe("чип модели в композере", () => {
  it("подписан коротким именем и помечает отсутствие явного выбора", () => {
    expect(shortModelLabel("anthropic.MiniMax-M3.1-Flash")).toBe("MiniMax-M3.1-Flash");
    // точка внутри имени модели значима: версия не отбрасывается
    expect(shortModelLabel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(shortModelLabel(undefined)).toBe("Модель по умолчанию");
    expect(main).toContain("по умолчанию");
    expect(main).toContain('aria-label="Выбрать модель"');
  });

  it("прячет чип у харнесса, который не умеет менять модель", () => {
    const adapters = [
      { id: "codex", active: true, capabilities: { modelSwitch: true } },
      { id: "fast-agent", active: true, capabilities: { modelSwitch: false } },
      { id: "qoder", active: false, capabilities: { modelSwitch: true } },
    ];
    expect(modelSwitchSupported(adapters, "codex")).toBe(true);
    expect(modelSwitchSupported(adapters, "fast-agent")).toBe(false);
    expect(modelSwitchSupported(adapters, "qoder")).toBe(false);
    expect(modelSwitchSupported(adapters, undefined)).toBe(false);
    expect(main).toContain("modelSwitchSupported(harnessAdapters, activeSession.harness)");
    expect(main).toContain("{modelSwitchHarness && <button type=\"button\" className={`composer-model");
  });

  it("берёт список моделей харнесса и отмечает текущий выбор", () => {
    expect(currentModelOption("gpt-6.1-sol", ["gpt-6.1-sol", "o3"])).toBe("gpt-6.1-sol");
    expect(currentModelOption("нет-в-списке", ["gpt-6.1-sol"])).toBeUndefined();
    expect(currentModelOption(undefined, ["gpt-6.1-sol"])).toBeUndefined();
    expect(main).toContain("`/api/models?harness=${encodeURIComponent(harness)}`");
  });

  it("различает успех, отказ адаптера и сетевой сбой", async () => {
    const ok = await requestModelChange(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), "codex", "s1", "o3");
    expect(ok).toEqual({ ok: true });

    const rejected = await requestModelChange(async () => new Response(JSON.stringify({ ok: false, error: "модель не поддерживается" }), { status: 502 }), "codex", "s1", "o3");
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.message).toContain("модель не поддерживается");

    const broken = await requestModelChange(async () => { throw new Error("network down"); }, "codex", "s1", "o3");
    expect(broken.ok).toBe(false);
    expect(main).toContain("Не удалось сменить модель:");
    expect(main).toContain("Не удалось загрузить список моделей:");
  });
});
