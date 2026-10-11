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
  return <fieldset className="settings-group" aria-label="Автокомпакт"><legend>Автокомпакт перед остыванием кэша</legend>
    <p className="settings-help">Сжимает большой рабочий контекст в той же сессии. Полная история сохраняется. Он не продолжает задачу и не создаёт новый чат.</p>
    <p className="settings-help">Компакт тоже расходует токены. Автоматика учитывает время выполнения компакта и недавний cache hit. Запусков для поддержания кэша нет. Фиксированный TTL GLM не опубликован; это окно обслуживания, а не обещание срока хранения кэша.</p>
    {draft && <>
      <label className="timeout-setting"><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} /><span><strong>Автоматически сжимать контекст</strong><small>Для закреплённых сессий или задач с незавершённой работой. Нужен включённый автопилот или автопродолжение. Не мешает активному ответу.</small></span></label>
      {state?.supportedHarnesses.map((harness) => <label className="timeout-setting" key={harness}><input type="checkbox" checked={draft.harnesses.includes(harness)} onChange={(event) => change({ harnesses: event.target.checked ? [...new Set([...draft.harnesses, harness])] : draft.harnesses.filter((item) => item !== harness) })} /><span><strong>Автокомпакт · {harness === "zcode" ? "ZCode" : harness}</strong><small>Использовать штатное сжатие контекста этой среды</small></span></label>)}
      <div className="context-options runtime-settings-grid">
        <label><span><strong>Пауза после ответа, секунд</strong></span><input type="number" min="5" max="600" value={draft.idleSeconds} onChange={(event) => change({ idleSeconds: Number(event.target.value) })} /></label>
        <label><span><strong>Оценка окна кэша, секунд</strong><small>Для неизвестного TTL. Начало учитывает время прошлых сжатий и запас 30 секунд до конца окна.</small></span><input type="number" min="30" max="7200" value={draft.maxAgeSeconds} onChange={(event) => change({ maxAgeSeconds: Number(event.target.value) })} /></label>
        <label><span><strong>Минимум токенов контекста</strong></span><input type="number" min="1000" max="2000000" value={draft.minContextTokens} onChange={(event) => change({ minContextTokens: Number(event.target.value) })} /></label>
        <label><span><strong>Максимум сжатий за час</strong></span><input type="number" min="1" max="24" value={draft.maxPerHour} onChange={(event) => change({ maxPerHour: Number(event.target.value) })} /></label>
      </div>
      <div className="settings-save-row"><span>{error ? <small className="autopilot-error">{error}</small> : saved ? <small className="settings-saved">Автокомпакт сохранён</small> : <small>Изменения применятся после сохранения</small>}</span><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить автокомпакт"}</button></div>
      {!!state?.operations.length && <p className="settings-help">Последнее сжатие: {state.operations.at(-1)?.state === "completed" ? `${state.operations.at(-1)?.tokensBefore.toLocaleString("ru-RU")} → ${state.operations.at(-1)?.tokensAfter?.toLocaleString("ru-RU")} токенов` : state.operations.at(-1)?.state === "failed" ? state.operations.at(-1)?.error || "Не удалось подтвердить результат" : "Выполняется — уменьшение контекста ещё не подтверждено"}</p>}
    </>}
    {!draft && <p className={error ? "autopilot-error" : "settings-loading"}>{error || "Загружаю настройки автокомпакта…"}</p>}
  </fieldset>;
}
