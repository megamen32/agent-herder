import * as React from "react";
type State = { enabled: boolean; reason?: string };
export function IndexingSection() {
  const [state, setState] = React.useState<State>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const read = async () => {
    setBusy(true); setError("");
    try { const response = await fetch("/api/settings/background-indexing"); if (!response.ok) throw new Error("Не удалось прочитать настройку индексации."); setState(await response.json()); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  React.useEffect(() => { void read(); }, []);
  const change = async () => {
    if (!state || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/settings/background-indexing", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !state.enabled }) });
      if (!response.ok) throw new Error("Не удалось применить настройку. Обновите состояние перед повтором.");
      setState(await response.json());
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-label="Фоновая индексация">
    <h2>Фоновая индексация</h2>
    <p>Обновление текстового и смыслового поиска на этой машине. На паузе новые и изменённые переписки не индексируются; поиск по сохранённым данным остаётся доступен.</p>
    <p role="status">{busy ? "Применяю…" : state?.enabled === false ? "На паузе" : state?.enabled === true ? "Включена" : "Состояние не получено"}</p>
    <button type="button" className="quiet-button" role="switch" aria-label="Фоновая индексация" aria-checked={state?.enabled ?? false} disabled={busy || !state} onClick={() => void change()}>{state?.enabled ? "Приостановить индексацию" : "Возобновить индексацию"}</button>
    <button type="button" className="quiet-button" disabled={busy} onClick={() => void read()}>Обновить состояние индексации</button>
    {state?.reason && <p>{state.reason}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
