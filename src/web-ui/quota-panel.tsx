// Панель quota-lens: окна codex, расход по моделям/ключам, история 5ч-окна.
// Opt-in на бэкенде (ENABLE_QUOTA_LENS=1); при выключенном флаге ручки отдают enabled:false.
import React from "react";

type Summary = { model: string; provider: string; calls: number; tokens: number; keys: number; errors: number };
type KeySummary = { key: string; calls: number; tokens: number };
type Row = { timestamp: string; provider: string; model: string; api_key_name: string | null; status: number; tokens: number; request_type: string; path: string };
type CodexCard = { primary_used?: number; secondary_used?: number; limit_reached?: boolean; plan?: string; email?: string; primary_reset_s?: number; error?: string };
type TimelinePoint = { ts: number; quota?: { primary?: number; secondary?: number; limit_reached?: boolean; reset_s?: number }; deltas?: { key: string; model: string; calls: number; tokens: number }[] };

const esc = (value: unknown) => String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const fmt = (value: unknown) => Number(value ?? 0).toLocaleString("ru-RU");

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  return response.json() as Promise<T>;
}

function Bar({ percent }: { percent?: number }) {
  const value = percent ?? 0;
  const color = value >= 90 ? "#e94b4b" : value >= 60 ? "#e6a23c" : "#67c23a";
  return (
    <div style={{ height: 8, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${value}%`, background: color }} />
    </div>
  );
}

export function QuotaPanel() {
  const [codex, setCodex] = React.useState<CodexCard | null>(null);
  const [summary, setSummary] = React.useState<Summary[]>([]);
  const [keys, setKeys] = React.useState<KeySummary[]>([]);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [timeline, setTimeline] = React.useState<TimelinePoint[]>([]);
  const [model, setModel] = React.useState<string | null>(null);
  const [keyFilter, setKeyFilter] = React.useState<string | null>(null);
  const [days, setDays] = React.useState(7);
  const [enabled, setEnabled] = React.useState(true);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (model) params.set("model", model);
      if (keyFilter) params.set("key", keyFilter);
      const status = await getJson<{ enabled?: boolean; hint?: string }>("/api/quota-lens/status");
      if (status.enabled === false) { setEnabled(false); setError(status.hint || "quota-lens disabled"); return; }
      setEnabled(true);
      const [summaryData, keyData, rowData, codexData, timelineData] = await Promise.all([
        getJson<Summary[]>(`/api/quota-lens/summary?${params}`),
        getJson<KeySummary[]>(`/api/quota-lens/keys?days=${days}`),
        getJson<Row[]>(`/api/quota-lens/rows?${params}`),
        getJson<CodexCard>("/api/quota-lens/codex"),
        getJson<TimelinePoint[]>("/api/quota-lens/timeline?limit=120"),
      ]);
      if (!Array.isArray(summaryData)) { setError(String((summaryData as any)?.error || "summary error")); return; }
      setError("");
      setSummary(summaryData);
      setKeys(Array.isArray(keyData) ? keyData : []);
      setRows(Array.isArray(rowData) ? rowData : []);
      setCodex(codexData);
      setTimeline(Array.isArray(timelineData) ? timelineData : []);
    } catch (loadError) {
      setError(String((loadError as Error).message));
    }
  }, [days, model, keyFilter]);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const timer = setInterval(() => { void load(); }, 300_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!enabled) {
    return <div className="chat-scroll" style={{ padding: 24 }}><p>quota-lens выключен. Opt-in: <code>ENABLE_QUOTA_LENS=1</code>.</p>{error && <p><small>{esc(error)}</small></p>}</div>;
  }

  const width = 560, height = 60, points = timeline.length;
  const spark = timeline.map((point, index) => {
    const x = points > 1 ? index * (width / (points - 1)) : 0;
    const primary = point.quota?.primary ?? 0;
    return `${x.toFixed(1)},${(height - 4 - (primary * (height - 8)) / 100).toFixed(1)}`;
  }).join(" ");
  const latest = timeline[points - 1];

  return (
    <div className="chat-scroll" style={{ padding: "12px 16px", overflow: "auto" }}>
      {error && <p style={{ color: "#e94b4b" }}>{esc(error)}</p>}
      <h3 style={{ margin: "0.4em 0" }}>Codex окно</h3>
      {codex ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: "6px 10px", maxWidth: 420 }}>
          <b>{esc(codex.plan || "?")}</b> <small>{esc(codex.email || "")}</small>
          <div>5ч: <b>{codex.primary_used ?? "?"}%</b></div>
          <Bar percent={codex.primary_used} />
          <div>нед: <b>{codex.secondary_used ?? "?"}%</b></div>
          <Bar percent={codex.secondary_used} />
          <small>
            {codex.limit_reached ? <b style={{ color: "#e94b4b" }}>ЛИМИТ · </b> : null}
            {codex.primary_reset_s ? `сброс 5ч через ${Math.round(codex.primary_reset_s / 60)} мин` : ""}
          </small>
        </div>
      ) : <p><small>нет данных</small></p>}

      <h3 style={{ margin: "0.8em 0 0.2em" }}>История 5ч-окна (тик 5 мин)</h3>
      {points > 0 ? (
        <div>
          <svg width={width} height={height} style={{ background: "#fafafa", border: "1px solid #eee", maxWidth: "100%" }}>
            <polyline points={spark} fill="none" stroke="#e94b4b" strokeWidth="2" />
            <line x1={0} y1={height - 4 - (90 * (height - 8)) / 100} x2={width} y2={height - 4 - (90 * (height - 8)) / 100} stroke="#e6a23c" strokeDasharray="4" />
          </svg>
          {latest?.deltas?.length ? (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Дельта последнего тика: {latest.deltas.map((delta) => `${esc(delta.model)}(${esc(delta.key)}) ${fmt(delta.tokens)}т/${fmt(delta.calls)}з`).join("; ")}
            </div>
          ) : null}
        </div>
      ) : <p><small>замеров пока нет</small></p>}

      <h3 style={{ margin: "0.8em 0 0.2em" }}>
        Модели
        <select value={days} onChange={(event) => { setDays(Number(event.target.value)); }} style={{ marginLeft: 8 }}>
          <option value={1}>1 день</option>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
        </select>
        <small style={{ marginLeft: 8, color: "#888" }}>клик по модели — её вызовы</small>
      </h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {summary.map((item) => (
          <button
            key={`${item.provider}/${item.model}`}
            className={`quiet-button ${model === item.model ? "selected-icon" : ""}`}
            onClick={() => setModel(model === item.model ? null : item.model)}
          >
            {esc(item.model)} · {fmt(item.tokens)}т / {fmt(item.calls)}з
          </button>
        ))}
      </div>

      {keys.length ? (
        <>
          <h3 style={{ margin: "0.8em 0 0.2em" }}>Ключи</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {keys.map((item) => (
              <button
                key={item.key}
                className={`quiet-button ${keyFilter === item.key ? "selected-icon" : ""}`}
                onClick={() => setKeyFilter(keyFilter === item.key ? null : item.key)}
              >
                {esc(item.key)} · {fmt(item.tokens)}т
              </button>
            ))}
          </div>
        </>
      ) : null}

      <h3 style={{ margin: "0.8em 0 0.2em" }}>Вызовы {model ? `· ${esc(model)}` : ""}{keyFilter ? ` · ${esc(keyFilter)}` : ""}</h3>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>{["время(UTC)", "модель", "провайдер", "ключ", "статус", "токены", "тип", "path"].map((h) => <th key={h} style={{ border: "1px solid #eee", padding: "2px 6px", textAlign: "left", background: "#fafafa" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc((row.timestamp || "").slice(5, 19))}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc(row.model)}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc(row.provider)}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc(row.api_key_name || "(internal)")}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px", color: row.status >= 400 ? "#e94b4b" : undefined }}>{row.status}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{fmt(row.tokens)}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc(row.request_type || "")}</td>
              <td style={{ border: "1px solid #eee", padding: "1px 6px" }}>{esc(row.path || "")}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} style={{ padding: 8, color: "#999" }}>нет записей</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
