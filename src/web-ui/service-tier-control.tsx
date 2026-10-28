import * as React from "react";
import "./service-tier-control.css";
import type { SessionServiceTierResult, SessionServiceTierState } from "../types/index.js";

/** Session-local speed control. An unobserved native setting stays unknown. */
export function ServiceTierControl({ sessionId, hostId, request }: {
  sessionId: string;
  hostId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [state, setState] = React.useState<SessionServiceTierState>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const path = `/api/sessions/codex/${encodeURIComponent(sessionId)}/service-tier`;
  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError("");
    try { setState(await request<SessionServiceTierState>(`${path}?hostId=${encodeURIComponent(hostId)}`)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, [path, hostId, request]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  const change = async (serviceTier: "normal" | "fast") => {
    if (busy || !state?.canSet) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<SessionServiceTierResult>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId, serviceTier }) });
      if (!result.ok || result.serviceTier !== serviceTier) {
        setError(result.error || "Среда не подтвердила переключение. Обновите состояние перед следующим действием.");
        return;
      }
      setState(current => current && ({ ...current, serviceTier: result.serviceTier, nativeServiceTier: result.nativeServiceTier }));
    } catch (cause) { setError(`${(cause as Error).message}. Исход не подтверждён; автоматического повтора нет.`); }
    finally { setBusy(false); }
  };
  return <details className="service-tier-control">
    <summary aria-label="Скорость Codex">Скорость: {state?.serviceTier === "fast" ? "Fast" : state?.serviceTier === "normal" ? "Normal" : "не подтверждена"}</summary>
    <div role="group" aria-label="Режим скорости этой сессии">
      <small>Применяется со следующего хода. Текущая работа продолжается. Fast расходует больше квоты.</small>
      <div>{(["normal", "fast"] as const).map(tier => <button key={tier} type="button" className="quiet-button" aria-pressed={state?.serviceTier === tier} disabled={busy || !state?.canSet || state.serviceTier === tier} onClick={() => void change(tier)}>{tier === "fast" ? "Fast" : "Normal"}</button>)}
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void refresh()}>{busy ? "Проверяю…" : "Обновить скорость"}</button></div>
      {!state?.canSet && <small>{state?.reason || "Читаю возможности выбранной сессии…"}</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  </details>;
}
