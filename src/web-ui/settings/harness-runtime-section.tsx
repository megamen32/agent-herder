import React from "react";

/**
 * The runtime switches of every harness: what may poll its site and what may
 * keep its hooks — and the full settings page of each harness.
 *
 * The browser harnesses (ChatGPT, Z.ai) both carry a passive path: the
 * intercept hook injected into window.fetch of the site page feeds the chat
 * list from the responses the page makes itself, and the durable inventory
 * keeps every chat visible across restarts. Polling (the requests the harness
 * initiates on its own) is therefore a choice, not a requirement: the owner
 * may pause it for any harness — ChatGPT while the site answers 429, Z.ai
 * because its passive listing is enough — and the passive observation keeps
 * working either way. The native harnesses (Claude Code, Codex, MiniMax
 * Code, …) reach the herder through their plugin hooks instead.
 *
 * Every change applies at once: a paused harness stops its background
 * requests on the next tick of its poller, and a silenced harness answers the
 * next run of its plugin with an empty decision. No restart, no redeploy.
 *
 * Each harness has a page of its own — ?page=harnesses&h=<id> — with its
 * switches, its durable inventory and the exact requests it makes in each
 * state. The link opens anywhere: the address bar always names the page.
 */

/** One harness as the settings table reads it. */
export interface HarnessRuntimeHarnessView {
  id: string;
  name: string | null;
  pollingEnabled: boolean;
  pollingOverride: boolean | null;
  promptPollingEnabled: boolean;
  promptPollingOverride: boolean | null;
  prewarmLimit: number;
  prewarmLimitOverride: number | null;
  hooksEnabled: boolean;
  hooksOverride: boolean | null;
  /** The durable full inventory of a browser harness: the chats the passive
   * listing can already see without a single request. */
  inventory?: { chats: number; scannedAt: number };
}

/** The whole view of the runtime switches, as the API answers it. */
export interface HarnessRuntimeView {
  ok: true;
  pollingEnabled: boolean;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
  harnesses: HarnessRuntimeHarnessView[];
}

/** The harnesses whose sessions live on a site the herder can watch. */
const BROWSER_HARNESSES = new Set(["chatgpt", "zai"]);

export async function loadHarnessRuntime(): Promise<HarnessRuntimeView> {
  const response = await fetch("/api/harness-runtime", { headers: { "content-type": "application/json" } });
  const text = await response.text();
  const data = text ? JSON.parse(text) as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as unknown as HarnessRuntimeView;
}

async function saveHarnessRuntime(change: Record<string, unknown>): Promise<HarnessRuntimeView> {
  const response = await fetch("/api/harness-runtime", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...change, actor: "web-panel" }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as unknown as HarnessRuntimeView;
}

/** What one harness is, in the words of the table. */
export function harnessKindText(id: string): string {
  if (id === "chatgpt" || id === "zai") return "браузерный чат: пассивно через intercept hook, пуллинг — по желанию";
  return "хук-плагин: харнесс сам подключается к Herder";
}

/** The state of the site polling, in one line. */
export function pollingStateText(view: HarnessRuntimeView | null): string {
  if (!view) return "Состояние запросов к сайтам читается…";
  return view.pollingEnabled
    ? "Фоновые запросы харнессов к сайтам выполняются: список чатов, прогрев истории."
    : "Инициативные запросы харнессов к сайтам приостановлены. ChatGPT и Z.ai продолжают наблюдение пассивно: перехват ответов самой страницы (intercept hook) и накопленный инвентарь на диске. Автопилот видит окончания ходов и продолжает работать. Явные действия (открытие чата, отправка сообщения, пересканирование) доступны всегда.";
}

/** The loading, the saving and the notices of the runtime switches. */
function useHarnessRuntimeView() {
  const [view, setView] = React.useState<HarnessRuntimeView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setView(await loadHarnessRuntime());
      setError(null);
    } catch (cause) {
      setError(`Настройки харнессов не прочитаны: ${(cause as Error).message}`);
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const apply = React.useCallback(async (change: Record<string, unknown>, note: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setView(await saveHarnessRuntime(change));
      setNotice(note);
    } catch (cause) {
      setError(`Изменение не применено: ${(cause as Error).message}`);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  return { view, busy, error, notice, reload, apply };
}

/** The harness page link: ?page=harnesses&h=<id>. */
export function harnessPageHref(harnessId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("page", "harnesses");
  url.searchParams.set("h", harnessId);
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

/** The hub link: ?page=harnesses. */
export function harnessHubHref(): string {
  const url = new URL(window.location.href);
  url.searchParams.set("page", "harnesses");
  url.searchParams.delete("h");
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

function readHarnessFocus(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("page") !== "harnesses") return null;
  const value = params.get("h");
  return value && value.trim() ? value.trim() : null;
}

/** The harness the URL focuses on. Every harness settings page is its own
 * address: the browser back button and the middle click both work. */
export function useHarnessFocus(): [string | null, (next: string | null) => void] {
  const [focus, setFocus] = React.useState<string | null>(readHarnessFocus);
  React.useEffect(() => {
    const follow = () => setFocus(readHarnessFocus());
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  const open = React.useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", "harnesses");
    if (next) url.searchParams.set("h", next);
    else url.searchParams.delete("h");
    url.hash = "";
    history.pushState(null, "", `${url.pathname}${url.search}`);
    setFocus(next);
  }, []);
  return [focus, open];
}

/** The requests one harness makes, in its current state. */
function harnessRequestLines(harness: HarnessRuntimeHarnessView): string[] {
  if (BROWSER_HARNESSES.has(harness.id)) {
    const site = harness.id === "chatgpt" ? "ChatGPT" : "Z.ai";
    const listPath = harness.id === "chatgpt" ? "/backend-api/conversations" : "/api/v1/chats";
    const historyPath = harness.id === "chatgpt"
      ? "/api/auth/session и /backend-api/conversations/{id}"
      : "/api/v1/chats/{id} и /api/v1/chats/{id}/messages/batch";
    if (harness.pollingEnabled) {
      return [
        `Список чатов (${listPath}) — фоновый опрос сайта, несколько запросов в минуту.`,
        `Прогрев истории до ${harness.prewarmLimit} чатов — чтение недавних разговоров (${historyPath}).`,
        "Перехват ответов самой страницы (intercept hook) работает одновременно и бесплатен.",
        harness.id === "chatgpt"
          ? "Снапшоты модальных диалогов («продолжить в чате») — локальные CDP-чтения страницы, не запросы к сайту."
          : "Отправка сообщений — только ваши действия и автопилот.",
      ];
    }
    return [
      `Ноль фоновых запросов к сайту: список чатов читается из перехваченных ответов самой страницы (intercept hook, ${listPath}) и накопленного инвентаря на диске.`,
      `Чтение истории одного чата (${historyPath}) — только когда ход закончился: отпечаток хода и команда /pilot.`,
      "Отправка сообщений — только ваши действия и автопилот (автопродолжение приостановленного хода ждёт включения пуллинга).",
      harness.id === "chatgpt"
        ? "Снапшоты модальных диалогов — локальные CDP-чтения страницы, не запросы к сайту; свой переключатель выше."
        : `Автопилот ${site} видит окончания ходов через intercept hook (статус последнего запуска в ответах сайта) и работает без пуллинга.`,
      harness.id === "chatgpt"
        ? "Байесовский бэкофф 429: каждый ответ 429 увеличивает безопасный интервал (до 32 минут), пока не успокоится."
        : "При включении пуллинга запросы списка идут с бэкоффом 429, как у ChatGPT.",
    ];
  }
  return [
    "Хук-харнесс сам подключается к Herder: фоновых запросов к сайту нет.",
    "Отправка сообщений в сессию — по вашим действиям и автопилоту.",
  ];
}

const overrideMark = (value: boolean | number | null): string => (value === null || value === undefined ? "" : " · переопределено");

export function HarnessRuntimeSection(): React.ReactElement {
  const [focus] = useHarnessFocus();
  if (focus) return <HarnessDetail key={focus} harnessId={focus} />;
  return <HarnessHub />;
}

/** The table of every harness; every row opens the page of its harness. */
function HarnessHub(): React.ReactElement {
  const { view, busy, error, notice, reload, apply } = useHarnessRuntimeView();

  const toggleMaster = async (): Promise<void> => {
    if (!view) return;
    await apply(
      { pollingEnabled: !view.pollingEnabled },
      view.pollingEnabled
        ? "Инициативные запросы к сайтам приостановлены. ChatGPT и Z.ai продолжают работать пассивно (intercept hook); автопилот видит окончания ходов."
        : "Фоновые запросы к сайтам возобновлены со следующего такта опроса.",
    );
  };

  const changeHarness = async (harness: string, field: string, value: boolean | number, note: string): Promise<void> => {
    await apply({ harnesses: { [harness]: { [field]: value } } }, note);
  };

  return (
    <div className="herder-settings-content">
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}

      <section className="herder-settings-block" aria-label="Запросы к сайтам">
        <h2>Запросы к сайтам (пуллинг)</h2>
        <p className="herder-settings-state-line" role="status">{pollingStateText(view)}</p>
        <p className="herder-settings-hint">
          Пуллинг — это постоянные фоновые запросы харнессов к их сайтам: список чатов и прогрев
          истории. Оба браузерных харнесса умеют работать без него: intercept hook в странице
          перехватывает ответы самого сайта, а накопленный инвентарь хранит все чаты на диске.
          Когда сайт отвечает 429 (слишком много запросов), выключите этот переключатель: фоновые
          запросы прекратятся на следующем такте, без перезапуска.
        </p>
        <p className="herder-settings-hint">
          Пока пуллинг приостановлен: ChatGPT и Z.ai видят окончания ходов через intercept hook —
          автопилот продолжает работать; опрос модальных диалогов ChatGPT идёт локальными
          снапшотами и имеет свой переключатель. Хук-харнессы (Claude Code, Codex, MiniMax Code)
          работают как раньше. Явные действия — открытие чата, отправка сообщения, пересканирование —
          остаются доступными.
        </p>
        <div className="herder-settings-actions">
          <button
            type="button"
            className={view?.pollingEnabled === false ? "herder-settings-button" : "herder-settings-button herder-settings-button-danger"}
            disabled={busy || !view}
            onClick={() => { void toggleMaster(); }}
          >
            {view?.pollingEnabled === false ? "Возобновить запросы к сайтам" : "Приостановить все запросы к сайтам"}
          </button>
          <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void reload(); }}>
            Обновить состояние
          </button>
        </div>
        {view?.changedAt ? (
          <p className="herder-settings-hint">
            Последнее изменение: {view.changedAt}{view.changedBy ? ` · ${view.changedBy}` : ""}{view.reason ? ` · ${view.reason}` : ""}
          </p>
        ) : null}
      </section>

      <section className="herder-settings-block" aria-label="Харнессы">
        <h2>Харнессы</h2>
        <p className="herder-settings-hint">
          Каждый харнесс — одна строка и своя страница настроек: запросы к сайту, опрос диалогов,
          прогрев истории, хуки, инвентарь и точный список запросов в каждом режиме. Откройте
          страницу харнесса по ссылке в его строке.
        </p>
        <table className="herder-settings-table">
          <thead>
            <tr><th>Харнесс</th><th>Запросы к сайту</th><th>Опрос диалогов</th><th>Прогрев истории</th><th>Хуки</th></tr>
          </thead>
          <tbody>
            {(view?.harnesses ?? []).map((harness) => (
              <tr key={harness.id}>
                <td>
                  <a className="herder-settings-harness-link" href={harnessPageHref(harness.id)} title={`Страница настроек ${harness.id}`}>{harness.name ?? harness.id}</a>
                  <span className="herder-settings-action">{harness.id} · {harnessKindText(harness.id)}</span>
                </td>
                <td>
                  {BROWSER_HARNESSES.has(harness.id) ? (
                    <button
                      type="button"
                      className="herder-settings-button"
                      disabled={busy}
                      onClick={() => { void changeHarness(harness.id, "pollingEnabled", !harness.pollingEnabled, `Пуллинг ${harness.id}: ${harness.pollingEnabled ? "приостановлен" : "возобновлён"}.`); }}
                    >
                      {harness.pollingEnabled ? "Пуллинг: включён" : "Пуллинг: приостановлен"}{overrideMark(harness.pollingOverride)}
                    </button>
                  ) : (
                    <span className="herder-settings-hint">— не опрашивает сайт</span>
                  )}
                </td>
                <td>
                  {harness.id === "chatgpt" ? (
                    <button
                      type="button"
                      className="herder-settings-button"
                      disabled={busy}
                      onClick={() => { void changeHarness(harness.id, "promptPollingEnabled", !harness.promptPollingEnabled, `Опрос диалогов ChatGPT: ${harness.promptPollingEnabled ? "выключен" : "включён"}.`); }}
                    >
                      {harness.promptPollingEnabled ? "Опрос: включён" : "Опрос: выключен"}{overrideMark(harness.promptPollingOverride)}
                    </button>
                  ) : (
                    <span className="herder-settings-hint">—</span>
                  )}
                </td>
                <td>
                  {BROWSER_HARNESSES.has(harness.id) ? (
                    <span className="herder-settings-hint">
                      {harness.prewarmLimit} чатов{overrideMark(harness.prewarmLimitOverride)}
                      {harness.inventory ? ` · инвентарь: ${harness.inventory.chats}` : ""}
                    </span>
                  ) : (
                    <span className="herder-settings-hint">—</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="herder-settings-button"
                    disabled={busy}
                    onClick={() => { void changeHarness(harness.id, "hooksEnabled", !harness.hooksEnabled, `Хуки ${harness.id}: ${harness.hooksEnabled ? "выключены" : "включены"}.`); }}
                  >
                    {harness.hooksEnabled ? "Хуки: включены" : "Хуки: выключены"}{overrideMark(harness.hooksOverride)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="herder-settings-hint">
          Общий выключатель хуков всего продукта — первый блок раздела «Настройки»; отдельные
          хуки и их состояние — раздел «Хуки». Строка таблицы выключает хуки одного харнесса,
          не трогая остальных.
        </p>
      </section>
    </div>
  );
}

/** The full settings page of one harness. */
function HarnessDetail({ harnessId }: { harnessId: string }): React.ReactElement {
  const { view, busy, error, notice, reload, apply } = useHarnessRuntimeView();
  const [, open] = useHarnessFocus();
  const [prewarmDraft, setPrewarmDraft] = React.useState<string | null>(null);

  const harness = view?.harnesses.find((item) => item.id === harnessId);
  const browser = BROWSER_HARNESSES.has(harnessId);

  const change = async (field: string, value: boolean | number, note: string): Promise<void> => {
    await apply({ harnesses: { [harnessId]: { [field]: value } } }, note);
  };

  const savePrewarm = async (): Promise<void> => {
    if (prewarmDraft === null || !harness) return;
    const value = Math.max(0, Math.min(100, Math.floor(Number(prewarmDraft))));
    if (!Number.isFinite(value)) return;
    setPrewarmDraft(null);
    await change("prewarmLimit", value, `Прогрев истории ${harnessId}: ${value} чатов. 0 — прогрев выключен.`);
  };

  const back = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(null);
  };

  if (view && !harness) {
    return (
      <div className="herder-settings-content">
        <a className="quiet-button" href={harnessHubHref()} onClick={back}>← Все харнессы</a>
        <p className="herder-settings-error">Харнесс «{harnessId}» не найден.</p>
      </div>
    );
  }

  return (
    <div className="herder-settings-content">
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}

      <p><a className="quiet-button" href={harnessHubHref()} onClick={back}>← Все харнессы</a></p>

      <section className="herder-settings-block" aria-label="Харнесс">
        <h2>{harness?.name ?? harnessId}</h2>
        <p className="herder-settings-state-line" role="status">
          {harnessId} · {harnessKindText(harnessId)}
          {view ? ` · пуллинг сайта: ${harness?.pollingEnabled ? "включён" : "приостановлен"} (общий переключатель: ${view.pollingEnabled ? "включён" : "выключен"})` : ""}
        </p>
        {browser ? (
          <p className="herder-settings-hint">
            Браузерный харнесс: сессии живут на сайте, Herder наблюдает страницу через CDP.
            Пассивный путь — intercept hook, встроенный в window.fetch страницы: сайт сам
            присылает список чатов, когда пользователь открывает и обновляет его; Herder не
            запрашивает ничего. Накопленный инвентарь хранится на диске и переживает
            перезапуски.
          </p>
        ) : (
          <p className="herder-settings-hint">
            Хук-харнесс: агент сам подключается к Herder через плагин-хук (Stop, уведомления).
            Сайт не опрашивается — фоновых запросов нет.
          </p>
        )}
      </section>

      <section className="herder-settings-block" aria-label="Запросы к сайту">
        <h2>Запросы к сайту этого харнесса</h2>
        {browser ? (
          <>
            <div className="herder-settings-actions">
              <button
                type="button"
                className={harness?.pollingEnabled === false ? "herder-settings-button" : "herder-settings-button herder-settings-button-danger"}
                disabled={busy || !harness}
                onClick={() => { if (harness) void change("pollingEnabled", !harness.pollingEnabled, `Пуллинг ${harnessId}: ${harness.pollingEnabled ? "приостановлен — работает пассивный intercept-путь" : "возобновлён"}.`); }}
              >
                {harness?.pollingEnabled ? "Пуллинг: включён — приостановить" : "Пуллинг: приостановлен — возобновить"}{overrideMark(harness?.pollingOverride ?? null)}
              </button>
              <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void reload(); }}>Обновить</button>
            </div>
            {harnessId === "chatgpt" ? (
              <div className="herder-settings-actions">
                <button
                  type="button"
                  className="herder-settings-button"
                  disabled={busy || !harness}
                  onClick={() => { if (harness) void change("promptPollingEnabled", !harness.promptPollingEnabled, `Опрос модальных диалогов ChatGPT: ${harness.promptPollingEnabled ? "выключен" : "включён"}. Локальные CDP-снапшоты, не запросы к сайту.`); }}
                >
                  {harness?.promptPollingEnabled ? "Опрос диалогов: включён" : "Опрос диалогов: выключен"}{overrideMark(harness?.promptPollingOverride ?? null)}
                </button>
              </div>
            ) : null}
            <p className="herder-settings-hint">
              Прогрев истории: {harness ? harness.prewarmLimit : "…"} чатов{overrideMark(harness?.prewarmLimitOverride ?? null)}.{" "}
              <input
                type="number" min={0} max={100} step={1}
                className="herder-settings-input" style={{ width: "5rem" }}
                aria-label="Прогрев истории: число чатов"
                value={prewarmDraft ?? (harness ? String(harness.prewarmLimit) : "")}
                onChange={(event) => setPrewarmDraft(event.target.value)}
              />{" "}
              <button type="button" className="herder-settings-button" disabled={busy || prewarmDraft === null} onClick={() => { void savePrewarm(); }}>Сохранить</button>
            </p>
            {harness?.inventory ? (
              <p className="herder-settings-state-line">
                Инвентарь на диске: {harness.inventory.chats} чатов · последний полный скан:{" "}
                {harness.inventory.scannedAt ? new Date(harness.inventory.scannedAt).toLocaleString("ru-RU") : "неизвестен"}.
                Пока пуллинг приостановлен, список читается из него и из перехваченных ответов страницы.
              </p>
            ) : (
              <p className="herder-settings-hint">Инвентарь на диске пока не создан: он появится после первого полного сканирования (кнопка «Пересканировать» в списке чатов) или первых перехваченных ответов.</p>
            )}
          </>
        ) : (
          <p className="herder-settings-hint">Этот харнесс не опрашивает сайт: фоновых запросов нет, агент сам подключается к Herder.</p>
        )}
      </section>

      <section className="herder-settings-block" aria-label="Хуки">
        <h2>Хуки харнесса</h2>
        <div className="herder-settings-actions">
          <button
            type="button"
            className="herder-settings-button"
            disabled={busy || !harness}
            onClick={() => { if (harness) void change("hooksEnabled", !harness.hooksEnabled, `Хуки ${harnessId}: ${harness.hooksEnabled ? "выключены" : "включены"}.`); }}
          >
            {harness?.hooksEnabled ? "Хуки: включены" : "Хуки: выключены"}{overrideMark(harness?.hooksOverride ?? null)}
          </button>
        </div>
        <p className="herder-settings-hint">
          Выключение глушит плагин-хуки этого харнесса: агент перестаёт сообщать Herder о своих
          ходах. Остальные харнессы не затрагиваются.
        </p>
      </section>

      <section className="herder-settings-block" aria-label="Какие запросы делает харнесс">
        <h2>Какие запросы делает этот харнесс</h2>
        <ul className="herder-settings-request-list">
          {(harness ? harnessRequestLines(harness) : ["Состояние читается…"]).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>

      <section className="herder-settings-block" aria-label="Автопилот и автопродолжение">
        <h2>Автопилот и автопродолжение в чатах этого харнесса</h2>
        <p className="herder-settings-hint">
          Команда прямо в чате: <code>/pilot</code> — переключить автопилот этой сессии,
          <code> /pilot on</code>, <code>/pilot off</code>, <code>/pilot status</code> (или
          <code> /автопилот вкл|выкл|статус</code>). Команда работает и на самом сайте, и в поле
          ввода Herder; ответ приходит в тот же чат. Настройка сессии всегда приоритетнее общих
          настроек.
        </p>
        <p className="herder-settings-hint">
          Переключатели конкретной сессии — панель сессии справа (АВТОПИЛОТ и
          АВТОПРОДОЛЖЕНИЕ). Общие настройки:{" "}
          <a href="?page=autopilot">Автопилот</a> · <a href="?page=autocontinue">Автопродолжение</a>.
        </p>
      </section>
    </div>
  );
}
