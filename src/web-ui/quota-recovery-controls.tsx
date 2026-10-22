import * as React from "react";

export type QuotaRecoverySession = { harness: string; id: string; cwd: string };
export type WaitForQuotaSource = "session" | "harness" | "global" | "default" | string;
export type WaitForQuotaSettings = {
  waitForQuota: boolean;
  fallbackForQuota?: boolean;
  fallbackForQuotaSource?: WaitForQuotaSource;
  fallbackForQuotaOverride?: boolean | null;
  waitForQuotaSource: WaitForQuotaSource;
  waitForQuotaOverride?: boolean | null;
};
export type QuotaRecoveryWait = {
  state: string;
  reason?: string;
  resetAt?: string;
  currentModel?: string;
  selectedModel?: string;
};

export const QUOTA_RECOVERY_HARNESSES = ["opencode", "zcode", "codex"] as const;
const HARNESS_LABELS: Record<(typeof QUOTA_RECOVERY_HARNESSES)[number], string> = {
  opencode: "OpenCode",
  zcode: "ZCode",
  codex: "Codex",
};

export type QuotaRecoveryMode = "off" | "fallback" | "wait" | "fallback-then-wait";
export function quotaRecoveryMode(wait: boolean, fallback: boolean): QuotaRecoveryMode {
  return wait ? fallback ? "fallback-then-wait" : "wait" : fallback ? "fallback" : "off";
}
export function quotaRecoveryModeFlags(mode: QuotaRecoveryMode) {
  return { waitForQuota: mode === "wait" || mode === "fallback-then-wait", fallbackForQuota: mode === "fallback" || mode === "fallback-then-wait" };
}
function modeOptions(codex = false) {
  return <><option value="off">Выключено</option>{!codex && <option value="fallback">Переключиться на запасную модель</option>}<option value="wait">Ждать квоту исходной модели</option>{!codex && <option value="fallback-then-wait">Запасные модели, затем ждать исходную</option>}</>;
}

export type WaitForQuotaScope =
  | { kind: "global" }
  | { kind: "harness"; harness: string }
  | { kind: "session"; session: QuotaRecoverySession };

function settingsPath(scope: WaitForQuotaScope): string {
  if (scope.kind === "global") return "/api/session-autostart";
  if (scope.kind === "harness") return `/api/session-autostart/harnesses/${encodeURIComponent(scope.harness)}`;
  return `/api/session-autostart/sessions/${encodeURIComponent(scope.session.harness)}/${encodeURIComponent(scope.session.id)}?cwd=${encodeURIComponent(scope.session.cwd)}`;
}

export async function readWaitForQuota(scope: WaitForQuotaScope): Promise<WaitForQuotaSettings> {
  const response = await fetch(settingsPath(scope), { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as Partial<WaitForQuotaSettings>;
  if (typeof body.waitForQuota !== "boolean" || typeof body.waitForQuotaSource !== "string") {
    throw new Error("Invalid waitForQuota settings response");
  }
  if (body.waitForQuotaOverride !== undefined && body.waitForQuotaOverride !== null && typeof body.waitForQuotaOverride !== "boolean") {
    throw new Error("Invalid waitForQuota override response");
  }
  return {
    waitForQuota: body.waitForQuota,
    ...(typeof body.fallbackForQuota === "boolean" ? { fallbackForQuota: body.fallbackForQuota } : {}),
    ...(typeof body.fallbackForQuotaSource === "string" ? { fallbackForQuotaSource: body.fallbackForQuotaSource } : {}),
    ...(body.fallbackForQuotaOverride === undefined ? {} : { fallbackForQuotaOverride: body.fallbackForQuotaOverride }),
    waitForQuotaSource: body.waitForQuotaSource,
    ...(body.waitForQuotaOverride === undefined ? {} : { waitForQuotaOverride: body.waitForQuotaOverride }),
  };
}

export async function writeWaitForQuota(scope: WaitForQuotaScope, value: boolean | null, fallbackForQuota?: boolean | null): Promise<WaitForQuotaSettings> {
  const response = await fetch(settingsPath(scope), {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ waitForQuota: value, ...(fallbackForQuota === undefined ? {} : { fallbackForQuota }), ...(scope.kind === "session" ? { cwd: scope.session.cwd } : {}) }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as Partial<WaitForQuotaSettings>;
  if (typeof body.waitForQuota !== "boolean" || typeof body.waitForQuotaSource !== "string") {
    throw new Error("Invalid waitForQuota settings response");
  }
  return {
    waitForQuota: body.waitForQuota,
    ...(typeof body.fallbackForQuota === "boolean" ? { fallbackForQuota: body.fallbackForQuota } : {}),
    ...(typeof body.fallbackForQuotaSource === "string" ? { fallbackForQuotaSource: body.fallbackForQuotaSource } : {}),
    ...(body.fallbackForQuotaOverride === undefined ? {} : { fallbackForQuotaOverride: body.fallbackForQuotaOverride }),
    waitForQuotaSource: body.waitForQuotaSource,
    ...(body.waitForQuotaOverride === undefined ? {} : { waitForQuotaOverride: body.waitForQuotaOverride }),
  };
}

export function quotaWaitStatusPath(session: QuotaRecoverySession): string {
  const query = new URLSearchParams({ harness: session.harness, sessionId: session.id, cwd: session.cwd });
  return `/api/quota-recovery/waits?${query.toString()}`;
}

export async function readQuotaWaitStatus(session: QuotaRecoverySession, signal?: AbortSignal): Promise<QuotaRecoveryWait | null> {
  const response = await fetch(quotaWaitStatusPath(session), { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { wait?: unknown; waits?: unknown };
  const candidate = body.wait ?? (Array.isArray(body.waits) ? body.waits[0] : undefined)
    ?? (typeof (body as Record<string, unknown>).state === "string" ? body : undefined);
  if (candidate === undefined || candidate === null) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid quota wait response");
  const wait = candidate as Record<string, unknown>;
  if (typeof wait.state !== "string") throw new Error("Invalid quota wait state");
  return {
    state: wait.state,
    ...(typeof wait.reason === "string" ? { reason: wait.reason } : {}),
    ...(typeof wait.resetAt === "string" ? { resetAt: wait.resetAt } : {}),
    ...(typeof wait.currentModel === "string" ? { currentModel: wait.currentModel } : {}),
    ...(typeof wait.selectedModel === "string" ? { selectedModel: wait.selectedModel } : {}),
  };
}

const WAIT_STATE_LABELS: Record<string, string> = {
  waiting: "Ожидает проверки квоты",
  reset_due: "Наступило время проверки",
  probing: "Проверяется состояние квоты",
  ready: "Готово к безопасному продолжению",
  dispatching: "Продолжение отправляется",
  accepted: "Продолжение принято агентом",
  held: "Приостановлено",
  exhausted: "Запасные модели исчерпаны",
  delivery_unknown: "Результат продолжения уточняется",
  completed: "Продолжение принято",
  cancelled: "Ожидание отменено",
};

export function quotaWaitStateLabel(state: string): string | undefined {
  return WAIT_STATE_LABELS[state];
}

/** Cancels superseded status reads and identifies which response may update the UI. */
export class LatestQuotaStatusRequest {
  private active?: { id: number; controller: AbortController };
  private nextId = 0;

  begin() {
    this.active?.controller.abort();
    const request = { id: ++this.nextId, controller: new AbortController() };
    this.active = request;
    return {
      signal: request.controller.signal,
      isCurrent: () => this.active?.id === request.id && !request.controller.signal.aborted,
    };
  }

  cancel() {
    this.active?.controller.abort();
    this.active = undefined;
  }
}

function sourceLabel(source: WaitForQuotaSource): string {
  if (source === "session") return "сессия";
  if (source === "harness") return "среда";
  if (source === "global") return "общая настройка";
  return "значение по умолчанию";
}

function describeTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function statusLine(wait: QuotaRecoveryWait | null) {
  if (!wait) return <p className="settings-help" role="status">Нет ожидающего восстановления по квоте.</p>;
  return <div className="quota-recovery-wait" role="status">
    <strong>{quotaWaitStateLabel(wait.state) ?? "Состояние ожидания обновлено"}</strong>
    {wait.reason && <p>{wait.reason}</p>}
    {wait.resetAt && <p>Следующая проверка: {describeTime(wait.resetAt)}</p>}
    {wait.currentModel && <p>Текущая модель: <code>{wait.currentModel}</code></p>}
    {wait.selectedModel && <p>Выбранная модель: <code>{wait.selectedModel}</code></p>}
    {!quotaWaitStateLabel(wait.state) && <small>Код состояния: {wait.state}</small>}
  </div>;
}

/**
 * Reusable controls for the existing autocontinue settings and session inspector.
 * The caller mounts one copy without a session for global/harness switches and
 * another with the selected session for its independent override and live status.
 */
export function QuotaRecoveryControls({ session }: { session?: QuotaRecoverySession }) {
  const [globalSetting, setGlobalSetting] = React.useState<WaitForQuotaSettings>();
  const [harnessSettings, setHarnessSettings] = React.useState<Partial<Record<string, WaitForQuotaSettings>>>({});
  const [sessionSetting, setSessionSetting] = React.useState<WaitForQuotaSettings>();
  const [waitStatus, setWaitStatus] = React.useState<QuotaRecoveryWait | null>(null);
  const [statusError, setStatusError] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [statusLoading, setStatusLoading] = React.useState(false);
  const [saving, setSaving] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const statusRequest = React.useRef<LatestQuotaStatusRequest | null>(null);
  if (statusRequest.current === null) statusRequest.current = new LatestQuotaStatusRequest();

  const refreshSettings = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (session) {
        setSessionSetting(await readWaitForQuota({ kind: "session", session }));
      } else {
        const [global, ...harnessResults] = await Promise.all([
          readWaitForQuota({ kind: "global" }),
          ...QUOTA_RECOVERY_HARNESSES.map((harness) => readWaitForQuota({ kind: "harness", harness })),
        ]);
        setGlobalSetting(global);
        setHarnessSettings(Object.fromEntries(QUOTA_RECOVERY_HARNESSES.map((harness, index) => [harness, harnessResults[index]!] as const)));
      }
    } catch {
      setError("Не удалось загрузить настройку ожидания квоты. Попробуйте обновить её ещё раз.");
    } finally {
      setLoading(false);
    }
  }, [session?.harness, session?.id, session?.cwd]);

  const refreshStatus = React.useCallback(async () => {
    if (!session) return;
    const request = statusRequest.current!.begin();
    setStatusLoading(true);
    setStatusError(false);
    setWaitStatus(null);
    try {
      const result = await readQuotaWaitStatus(session, request.signal);
      if (request.isCurrent()) setWaitStatus(result);
    } catch {
      if (request.isCurrent()) {
        setWaitStatus(null);
        setStatusError(true);
      }
    } finally {
      if (request.isCurrent()) setStatusLoading(false);
    }
  }, [session?.harness, session?.id, session?.cwd]);

  React.useEffect(() => { void refreshSettings(); }, [refreshSettings]);
  React.useEffect(() => {
    if (session) void refreshStatus();
    return () => statusRequest.current?.cancel();
  }, [refreshStatus]);

  const save = async (scope: WaitForQuotaScope, key: string, value: boolean | null, fallbackForQuota?: boolean | null) => {
    setSaving(key);
    setError(undefined);
    try {
      const saved = await writeWaitForQuota(scope, value, fallbackForQuota);
      if (scope.kind === "global") setGlobalSetting(saved);
      else if (scope.kind === "harness") setHarnessSettings((current) => ({ ...current, [scope.harness]: saved }));
      else setSessionSetting(saved);
      if (scope.kind === "session") await refreshStatus();
    } catch {
      setError("Не удалось сохранить настройку ожидания квоты.");
    } finally {
      setSaving(undefined);
    }
  };

  if (loading) return <section className="settings-group" aria-label="Восстановление после квоты"><p role="status">Загружаем настройку ожидания квоты…</p></section>;

  if (session) {
    const setting = sessionSetting;
    const overridden = typeof setting?.waitForQuotaOverride === "boolean" || typeof setting?.fallbackForQuotaOverride === "boolean";
    return <fieldset className="settings-group quota-recovery-settings" aria-label="Ожидание восстановления квоты">
      <legend>Восстановление после квоты</legend>
      {setting && <>
        <label className="launch-policy-field"><span>Поведение при исчерпании квоты</span>
          <select aria-label="Политика квоты для текущей сессии" disabled={Boolean(saving)}
            value={quotaRecoveryMode(setting.waitForQuota, session.harness === "codex" ? false : setting.fallbackForQuota === true)}
            onChange={event => { const flags = quotaRecoveryModeFlags(event.target.value as QuotaRecoveryMode); void save({kind:"session",session},"session",flags.waitForQuota,flags.fallbackForQuota); }}>
            {modeOptions(session.harness === "codex")}
          </select></label>
        {session.harness === "codex" && <p className="settings-help">Codex: ожидание исходной модели. Независимая квота запасных моделей не подтверждена.</p>}
        <label className="runtime-toggle-setting timeout-setting">
          <span><strong>Продолжить эту сессию после восстановления квоты</strong>
            <small>Сейчас {setting.waitForQuota ? "включено" : "выключено"}; значение берётся из настройки: {sourceLabel(setting.waitForQuotaSource)}.</small>
          </span>
          <input type="checkbox" role="switch" aria-label="Ожидание квоты для текущей сессии" checked={setting.waitForQuota}
            disabled={Boolean(saving)} onChange={(event) => void save({ kind: "session", session }, "session", event.target.checked)} />
        </label>
        {overridden && <button type="button" className="quiet-button" disabled={Boolean(saving)}
          onClick={() => void save({ kind: "session", session }, "session", null, null)}>Использовать настройку среды</button>}
      </>}
      {error && <p className="autopilot-error" role="alert">{error}</p>}
      <div className="settings-save-row"><strong>Состояние ожидания</strong>
        <button type="button" className="quiet-button" disabled={statusLoading} onClick={() => void refreshStatus()}>{statusLoading ? "Обновляем…" : "Обновить"}</button>
      </div>
      {statusError ? <p className="autopilot-error" role="alert">Не удалось прочитать состояние ожидания для этой сессии.</p> : statusLine(waitStatus)}
    </fieldset>;
  }

  return <fieldset className="settings-group quota-recovery-settings" aria-label="Ожидание восстановления квоты">
    <legend>Восстановление после квоты</legend>
    <p className="settings-help">Политики действуют независимо от общего автопродолжения. Сохранённый список запасных моделей сам по себе не включает переключение. Выключение сохраняет его порядок.</p>
    {globalSetting && <label className="runtime-toggle-setting timeout-setting">
      <span><strong>Разрешить ожидание после квоты по умолчанию</strong><small>По умолчанию выключено. Настройки среды и отдельной сессии имеют приоритет.</small></span>
      <input type="checkbox" role="switch" aria-label="Ожидание квоты по умолчанию" checked={globalSetting.waitForQuota}
        disabled={Boolean(saving)} onChange={(event) => void save({ kind: "global" }, "global", event.target.checked)} />
    </label>}
    {globalSetting && <label className="launch-policy-field"><span>Политика квоты по умолчанию</span>
      <select aria-label="Политика квоты по умолчанию" disabled={Boolean(saving)}
        value={quotaRecoveryMode(globalSetting.waitForQuota, globalSetting.fallbackForQuota === true)}
        onChange={event => {const flags=quotaRecoveryModeFlags(event.target.value as QuotaRecoveryMode);void save({kind:"global"},"global",flags.waitForQuota,flags.fallbackForQuota);}}>
        {modeOptions()}
      </select><small>Codex использует только ожидание; список приоритетов хранится отдельно и не включает политику.</small>
    </label>}
    <div className="harness-automation-list" aria-label="Ожидание квоты по средам">
      {QUOTA_RECOVERY_HARNESSES.map((harness) => {
        const setting = harnessSettings[harness];
        return <section className="harness-setting-row" key={harness} aria-label={`Ожидание квоты · ${HARNESS_LABELS[harness]}`}>
          <div><strong>{HARNESS_LABELS[harness]}</strong><small>{setting ? `${setting.waitForQuota ? "Разрешено" : "Выключено"} · источник: ${sourceLabel(setting.waitForQuotaSource)}` : "Не загружено"}</small>
            {setting && (typeof setting.waitForQuotaOverride === "boolean" || typeof setting.fallbackForQuotaOverride === "boolean") && <button type="button" className="inherit-button" disabled={Boolean(saving)}
              onClick={() => void save({ kind: "harness", harness }, harness, null, null)}>Использовать общую настройку</button>}
          </div>
          <label className="launch-policy-field"><span className="sr-only">Политика квоты · {HARNESS_LABELS[harness]}</span>
            <select aria-label={`Политика квоты · ${HARNESS_LABELS[harness]}`} disabled={!setting || Boolean(saving)}
              value={setting ? quotaRecoveryMode(setting.waitForQuota, harness === "codex" ? false : setting.fallbackForQuota === true) : "off"}
              onChange={event => { const flags=quotaRecoveryModeFlags(event.target.value as QuotaRecoveryMode); void save({kind:"harness",harness},harness,flags.waitForQuota,flags.fallbackForQuota); }}>
              {modeOptions(harness === "codex")}
            </select>
          </label>
        </section>;
      })}
    </div>
    {error && <p className="autopilot-error" role="alert">{error}</p>}
  </fieldset>;
}
