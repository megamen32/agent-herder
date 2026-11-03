import React from "react";

/**
 * The runtime switches of every harness: what may poll its site and what may
 * keep its hooks.
 *
 * The browser harnesses (ChatGPT, Z.ai) are watched by polling — the
 * inventory list, the history prewarm, the modal-prompt poller — and a site
 * that answers 429 makes that polling a burden the owner may want to lift
 * for a while. The native harnesses (Claude Code, Codex, MiniMax Code, …)
 * reach the herder through their plugin hooks instead, so each harness of
 * the table carries two independent switches: the requests it makes to its
 * site and the hooks it runs.
 *
 * Every change applies at once: a paused harness stops its background
 * requests on the next tick of its poller, and a silenced harness answers
 * the next run of its plugin with an empty decision. No restart, no
 * redeploy.
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

/** The harnesses whose sessions live on a site the herder polls. */
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
  if (id === "chatgpt") return "браузерный чат: пассивно через intercept hook";
  if (id === "zai") return "браузерный чат: харнесс опрашивает сайт";
  return "хук-плагин: харнесс сам подключается к Herder";
}

/** The state of the site polling, in one line. */
export function pollingStateText(view: HarnessRuntimeView | null): string {
  if (!view) return "Состояние запросов к сайтам читается…";
  return view.pollingEnabled
    ? "Фоновые запросы к сайтам выполняются: инвентаризация чатов, прогрев истории, опрос диалогов ChatGPT."
    : "Инициативные запросы харнессов к сайтам приостановлены. ChatGPT продолжает наблюдение пассивно — перехват ответов самой страницы (intercept hook) и локальные CDP-снапшоты; Z.ai заморожен до возобновления. Явные действия (открытие чата, отправка сообщения, пересканирование) работают.";
}

export function HarnessRuntimeSection(): React.ReactElement {
  const [view, setView] = React.useState<HarnessRuntimeView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [prewarmDrafts, setPrewarmDrafts] = React.useState<Record<string, string>>({});

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setView(await loadHarnessRuntime());
      setError(null);
    } catch (cause) {
      setError(`Настройки харнессов не прочитаны: ${(cause as Error).message}`);
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const apply = async (change: Record<string, unknown>, note: string): Promise<void> => {
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
  };

  const toggleMaster = async (): Promise<void> => {
    if (!view) return;
    await apply(
      { pollingEnabled: !view.pollingEnabled },
      view.pollingEnabled
        ? "Инициативные запросы к сайтам приостановлены. ChatGPT продолжает работать пассивно (intercept hook); автопилот Z.ai возобновится после включения пуллинга."
        : "Фоновые запросы к сайтам возобновлены со следующего такта опроса.",
    );
  };

  const changeHarness = async (harness: string, field: string, value: boolean | number, note: string): Promise<void> => {
    await apply({ harnesses: { [harness]: { [field]: value } } }, note);
  };

  const savePrewarm = async (harness: HarnessRuntimeHarnessView): Promise<void> => {
    const draft = prewarmDrafts[harness.id];
    if (draft === undefined) return;
    const value = Math.max(0, Math.min(100, Math.floor(Number(draft))));
    if (!Number.isFinite(value)) return;
    setPrewarmDrafts((previous) => {
      const next = { ...previous };
      delete next[harness.id];
      return next;
    });
    await changeHarness(harness.id, "prewarmLimit", value, `Прогрев истории ${harness.id}: ${value} чатов. 0 — прогрев выключен.`);
  };

  const overrideMark = (value: boolean | number | null): string => (value === null || value === undefined ? "" : " · переопределено");

  return (
    <div className="herder-settings-content">
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}

      <section className="herder-settings-block" aria-label="Запросы к сайтам">
        <h2>Запросы к сайтам (пуллинг)</h2>
        <p className="herder-settings-state-line" role="status">{pollingStateText(view)}</p>
        <p className="herder-settings-hint">
          Пуллинг — это постоянные фоновые запросы харнессов к их сайтам: список чатов, история
          разговоров, модальные окна ChatGPT. Когда сайт отвечает 429 (слишком много запросов),
          выключите этот переключатель: фоновые запросы прекратятся на следующем такте, без
          перезапуска.
        </p>
        <p className="herder-settings-hint">
          Пока пуллинг приостановлен: ChatGPT видит окончание ходов через intercept hook —
          автопилот продолжает работать, опрос модальных диалогов («продолжить в чате») идёт
          локальными снапшотами и паузой не останавливается. Z.ai окончаний ходов не видит —
          его автопилот возобновится после включения пуллинга. Хук-харнессы (Claude Code, Codex,
          MiniMax Code) работают как раньше. Явные действия — открытие чата, отправка сообщения —
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
          Каждый харнесс — одна строка. ChatGPT: запросы к сайту (пауза не глушит пассивный
          intercept-путь), опрос модальных диалогов и прогрев истории. Z.ai: запросы к сайту и
          прогрев истории. Хуки можно выключить у любого харнесса отдельно, не трогая остальные.
        </p>
        <table className="herder-settings-table">
          <thead>
            <tr><th>Харнесс</th><th>Запросы к сайту</th><th>Опрос диалогов</th><th>Прогрев истории</th><th>Хуки</th></tr>
          </thead>
          <tbody>
            {(view?.harnesses ?? []).map((harness) => (
              <tr key={harness.id}>
                <td>
                  <strong>{harness.name ?? harness.id}</strong>
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
                    <>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        className="herder-settings-input"
                        style={{ width: "5rem" }}
                        value={prewarmDrafts[harness.id] ?? String(harness.prewarmLimit)}
                        aria-label={`Прогрев истории ${harness.id}: число чатов`}
                        onChange={(event) => setPrewarmDrafts((previous) => ({ ...previous, [harness.id]: event.target.value }))}
                      />
                      {" "}
                      <button
                        type="button"
                        className="herder-settings-button"
                        disabled={busy || prewarmDrafts[harness.id] === undefined}
                        onClick={() => { void savePrewarm(harness); }}
                      >
                        Сохранить
                      </button>
                      {overrideMark(harness.prewarmLimitOverride) ? <span className="herder-settings-hint"> · переопределено</span> : null}
                    </>
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
          хуки и их состояние — раздел «Хуки». Строка таблица выключает хуки одного харнесса,
          не трогая остальных.
        </p>
      </section>
    </div>
  );
}
