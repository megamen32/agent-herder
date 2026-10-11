import * as React from "react";
import type { AutoCompactSettings, CompactReceipt } from "../autocontinue/auto-compact.js";

type State = { settings: AutoCompactSettings; supportedHarnesses: string[]; operations: CompactReceipt[] };
export function AutoCompactSettingsPanel() {
  const [state, setState] = React.useState<State>();
  const [draft, setDraft] = React.useState<AutoCompactSettings>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    fetch("/api/session-autocompact").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить автокомпакт.");
      if (active) { setState(body); setDraft(body.settings); }
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  const change = (patch: Partial<AutoCompactSettings>) => { if (draft) { setDraft({ ...draft, ...patch }); setSaved(false); } };
  const save = async () => {
    setSaving(true); setError(undefined);
    try {
      const response = await fetch("/api/session-autocompact", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: draft }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось сохранить автокомпакт.");
      setState(body); setDraft(body.settings); setSaved(true);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  const last = state?.operations.at(-1);
  return <section className="compact-panel" aria-label="Автокомпакт">
    <div className="compact-heading"><div><h3>Сжатие контекста</h3><p>Краткая сводка вместо длинного рабочего контекста. История чата сохраняется.</p></div>{draft && <button type="button" className={`switch-control ${draft.enabled ? "enabled" : ""}`} role="switch" aria-checked={draft.enabled} aria-label="Автоматически сжимать контекст" onClick={() => change({ enabled: !draft.enabled })}><span /></button>}</div>
    {draft && <>
      <div className="compact-thresholds">
        <label className="compact-threshold"><span>Заполнение контекста</span><div><input type="number" aria-label="Минимальное заполнение контекста, %" min="1" max="99" value={draft.minContextPercent} onChange={event => change({ minContextPercent: Number(event.target.value) })} /><b>%</b></div><small>Минимум для запуска сжатия</small></label>
        <label className="compact-threshold"><span>Ваши сообщения</span><div><input type="number" aria-label="Минимум ваших сообщений" min="1" max="100" value={draft.minHumanMessages} onChange={event => change({ minHumanMessages: Number(event.target.value) })} /><b>сообщений</b></div><small>За всю историю этого чата</small></label>
      </div>
      <p className="compact-condition">Сжатие начнётся, когда выполнены оба условия. Ответы агента и автоматические продолжения в число ваших сообщений не входят.</p>
      <div className="compact-harnesses">{state?.supportedHarnesses.map(harness => <label key={harness}><input type="checkbox" checked={draft.harnesses.includes(harness)} onChange={event => change({ harnesses: event.target.checked ? [...new Set([...draft.harnesses, harness])] : draft.harnesses.filter(item => item !== harness) })} /><span>{harness === "zcode" ? "ZCode" : harness}</span><small>Штатное сжатие</small></label>)}</div>
      <details className="compact-advanced"><summary>Время и лимиты</summary><div className="compact-timing-grid">
        <label><span>Пауза после ответа</span><div><input type="number" aria-label="Минимальная пауза после последнего ответа агента, секунд" min="5" max="600" value={draft.idleSeconds} onChange={event => change({ idleSeconds: Number(event.target.value) })} /><small>сек.</small></div></label>
        <label><span>Оценка окна кэша</span><div><input type="number" aria-label="Оценка окна кэша, секунд" min="30" max="7200" value={draft.maxAgeSeconds} onChange={event => change({ maxAgeSeconds: Number(event.target.value) })} /><small>сек.</small></div></label>
        <label><span>Сжатий за час</span><div><input type="number" aria-label="Максимум сжатий всех сессий за час" min="1" max="24" value={draft.maxPerHour} onChange={event => change({ maxPerHour: Number(event.target.value) })} /><small>всего</small></div></label>
      </div><p className="compact-condition">Таймер учитывает время прошлых сжатий и запас 30 секунд. TTL GLM не опубликован: окно кэша — ваша оценка, а не гарантия. Компакт тоже расходует токены.</p></details>
      <details className="compact-advanced"><summary>Какие сессии будут сжаты</summary><p className="compact-condition">Закреплённые чаты или незавершённые задачи с включённым автопилотом либо автопродолжением. Активному ответу, ожиданию человека и явно остановленным чатам сжатие не мешает.</p></details>
      <div className="settings-save-row compact-save"><span role="status">{error ? <small className="autopilot-error">{error}</small> : saved ? <small className="settings-saved">Автокомпакт сохранён</small> : <small>Эти настройки сохраняются отдельно.</small>}</span><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить автокомпакт"}</button></div>
      {last && <p className="compact-receipt">{last.state === "completed" ? `Последнее сжатие: ${last.tokensBefore.toLocaleString("ru-RU")} → ${last.tokensAfter?.toLocaleString("ru-RU")} токенов` : last.state === "failed" ? last.error || "Не удалось подтвердить результат" : "Сжатие выполняется…"}</p>}
    </>}
    {!draft && <p className={error ? "autopilot-error" : "settings-loading"}>{error || "Загружаю настройки…"}</p>}
  </section>;
}
