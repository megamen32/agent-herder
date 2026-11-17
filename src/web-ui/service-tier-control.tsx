import * as React from "react";
import "./service-tier-control.css";
import type { SessionServiceTierResult, SessionServiceTierState } from "../types/index.js";

export type ServiceTier = "normal" | "fast";
export type ServiceTierControlState = {
  state?: SessionServiceTierState;
  busy: boolean;
  error: string;
  refresh: () => Promise<void>;
  change: (serviceTier: ServiceTier) => Promise<void>;
};

export function useServiceTierControl({ sessionId, hostId, request, enabled }: {
  sessionId: string;
  hostId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  enabled: boolean;
}): ServiceTierControlState {
  const [state, setState] = React.useState<SessionServiceTierState>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const path = `/api/sessions/codex/${encodeURIComponent(sessionId)}/service-tier`;
  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try { setState(await request<SessionServiceTierState>(`${path}?hostId=${encodeURIComponent(hostId)}`)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, [enabled, path, hostId, request]);
  React.useEffect(() => { if (enabled) void refresh(); else setState(undefined); }, [enabled, refresh]);
  const change = React.useCallback(async (serviceTier: ServiceTier) => {
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
  }, [busy, hostId, path, request, state?.canSet]);
  return { state, busy, error, refresh, change };
}

function tierLabel(selected: ServiceTier | undefined): string {
  return selected === "fast" ? "Быстро" : selected === "normal" ? "Обычный ответ" : "Выберите режим";
}

export function ServiceTierPanel({ model, embedded = false, state, busy, error, refresh, change }: ServiceTierControlState & { model?: string; embedded?: boolean }) {
  const selected = state?.serviceTier;
  const label = tierLabel(selected);
  return <div className={`service-tier-popover${embedded ? " embedded" : ""}`} role="dialog" aria-label="Режим ответа Codex">
    <div className="service-tier-heading">
      <span className="service-tier-spark" aria-hidden="true">ϟ</span>
      <div><strong>{label}</strong>{model && <small>{model} ›</small>}</div>
      <button type="button" className="service-tier-refresh" aria-label="Обновить режим ответа" title="Обновить" disabled={busy} onClick={() => void refresh()}>↻</button>
    </div>
    <div className="service-tier-track" role="group" aria-label="Режим ответа">
      {(["normal", "fast"] as const).map(tier => <button key={tier} type="button" className={`service-tier-option ${selected === tier ? "selected" : ""}`} aria-pressed={selected === tier} disabled={busy || !state?.canSet || selected === tier} onClick={() => void change(tier)}>
        <span className="service-tier-dot" aria-hidden="true" />
        <span>{tier === "fast" ? "Быстро" : "Обычный ответ"}</span>
      </button>)}
    </div>
    <small className="service-tier-help">Применяется со следующего ответа. Текущая работа продолжается. Быстрый режим расходует больше квоты.</small>
    {!state?.canSet && <small className="service-tier-help">{state?.reason || "Читаю возможности выбранной сессии…"}</small>}
    {error && <small className="service-tier-error" role="alert">{error}</small>}
  </div>;
}

export function ServiceTierControl({ model, state, busy, error, refresh, change }: ServiceTierControlState & { model?: string }) {
  const label = tierLabel(state?.serviceTier);
  return <details className="service-tier-control">
    <summary aria-label="Выбрать режим ответа">
      <span className="service-tier-summary-icon" aria-hidden="true">◌</span>
      <span>{label}</span>
      <span className="service-tier-summary-chevron" aria-hidden="true">⌄</span>
    </summary>
    <ServiceTierPanel model={model} state={state} busy={busy} error={error} refresh={refresh} change={change} />
  </details>;
}
