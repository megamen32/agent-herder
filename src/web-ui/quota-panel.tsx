// Панель «Линза квоты»: окна Codex, расход по моделям и ключам, история 5-часового окна.
// Включается на сервере; когда панель выключена, ручки отдают enabled:false.
import React from "react";

type Summary = { model: string; provider: string; calls: number; tokens: number; keys: number; errors: number };
type KeySummary = { key: string; calls: number; tokens: number };
type Row = { timestamp: string; provider: string; model: string; api_key_name: string | null; status: number; tokens: number; request_type: string; path: string };
type CodexCard = { primary_used?: number; secondary_used?: number; limit_reached?: boolean; plan?: string; email?: string; primary_reset_s?: number; error?: string };
type TimelinePoint = { ts: number; quota?: { primary?: number; secondary?: number; limit_reached?: boolean; reset_s?: number }; deltas?: { key: string; model: string; calls: number; tokens: number }[] };
type Forecast = {
  available?: boolean; reason?: string; pairs?: number; sigma_min?: number;
  current_primary?: number; rate_primary_per_min?: number; exhausted?: boolean; eta_primary_min?: number | null;
  current_secondary?: number | null; rate_secondary_per_min?: number; eta_secondary_min?: number | null;
};

const LOAD_ERROR_TEXT = "Не удалось загрузить данные квоты.";

const fmtEta = (minutes: number | null | undefined): string => {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "меньше минуты";
  if (minutes < 90) return `~${Math.round(minutes)} мин`;
  if (minutes < 48 * 60) return `~${(minutes / 60).toFixed(1)} ч`;
  return `~${(minutes / 1440).toFixed(1)} дн`;
};

const fmt = (value: unknown) => Number(value ?? 0).toLocaleString("ru-RU");

const pluralRu = (count: number, one: string, few: string, many: string): string => {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 >= 2 && mod10 <= 4) return few;
  if (mod10 === 1) return one;
  return many;
};

const tokensRu = (count: number): string => `${fmt(count)} ${pluralRu(count, "токен", "токена", "токенов")}`;
const callsRu = (count: number): string => `${fmt(count)} ${pluralRu(count, "вызов", "вызова", "вызовов")}`;

const clockRu = (ts: number): string =>
  new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const timestampRu = (iso: string): string => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const shortPath = (path: string): string => {
  const withoutQuery = (path || "").split("?")[0] ?? "";
  const segments = withoutQuery.split("/").filter(Boolean);
  return segments[segments.length - 1] || withoutQuery || "/";
};

const statusLabelRu = (status: number): string => (status >= 400 ? "ошибка" : "ок");

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  return response.json() as Promise<T>;
}

function Bar({ percent }: { percent?: number }) {
  const value = percent ?? 0;
  const color = value >= 90 ? "#e94b4b" : value >= 60 ? "#e6a23c" : "#67c23a";
  return (
    <div className="qp-bar">
      <div className="qp-bar-fill" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

export function QuotaPanel() {
  const [codex, setCodex] = React.useState<CodexCard | null>(null);
  const [summary, setSummary] = React.useState<Summary[]>([]);
  const [keys, setKeys] = React.useState<KeySummary[]>([]);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [timeline, setTimeline] = React.useState<TimelinePoint[]>([]);
  const [forecastData, setForecastData] = React.useState<Forecast | null>(null);
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
      const status = await getJson<{ enabled?: boolean }>("/api/quota-lens/status");
      if (status.enabled === false) { setEnabled(false); setError(""); return; }
      setEnabled(true);
      const [summaryData, keyData, rowData, codexData, timelineData, forecastRaw] = await Promise.all([
        getJson<Summary[]>(`/api/quota-lens/summary?${params}`),
        getJson<KeySummary[]>(`/api/quota-lens/keys?days=${days}`),
        getJson<Row[]>(`/api/quota-lens/rows?${params}`),
        getJson<CodexCard>("/api/quota-lens/codex"),
        getJson<TimelinePoint[]>("/api/quota-lens/timeline?limit=120"),
        getJson<Forecast>("/api/quota-lens/forecast").catch(() => null),
      ]);
      if (!Array.isArray(summaryData)) { setError(String((summaryData as any)?.error ?? "")); return; }
      setError("");
      setSummary(summaryData);
      setKeys(Array.isArray(keyData) ? keyData : []);
      setRows(Array.isArray(rowData) ? rowData : []);
      setCodex(codexData);
      setTimeline(Array.isArray(timelineData) ? timelineData : []);
      setForecastData(forecastRaw);
    } catch (loadError) {
      setError(String((loadError as Error).message ?? ""));
    }
  }, [days, model, keyFilter]);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const timer = setInterval(() => { void load(); }, 300_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!enabled) {
    return (
      <div className="chat-scroll qp-page qp-disabled">
        <p>Линза квоты отключена.</p>
        <p className="qp-muted qp-disabled-note">Статистика расхода моделей появится после включения панели на сервере.</p>
      </div>
    );
  }

  const width = 560, height = 60, points = timeline.length;
  const sparkPoints = timeline.map((point, index) => {
    const x = points > 1 ? index * (width / (points - 1)) : 0;
    const primary = point.quota?.primary ?? 0;
    const y = height - 4 - (primary * (height - 8)) / 100;
    return { x, y, primary, ts: point.ts };
  });
  const spark = sparkPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const latest = timeline[points - 1];

  return (
    <div className="chat-scroll qp-page">
      {error ? (
        <div className="qp-error-block" role="alert">
          <span>{LOAD_ERROR_TEXT}</span>
          {error ? <small className="qp-muted">Причина: {error}</small> : null}
          <button className="quiet-button qp-retry" onClick={() => void load()}>Повторить</button>
        </div>
      ) : null}

      <h3 className="qp-title qp-title-first">Окно Codex</h3>
      {codex ? (
        <div className="qp-codex-card">
          <div><b>{codex.plan || "—"}</b> <small className="qp-muted">{codex.email || ""}</small></div>
          <div className="qp-meter">
            <div className="qp-meter-head"><span>5-часовое окно</span><b>{codex.primary_used ?? "?"} %</b></div>
            <Bar percent={codex.primary_used} />
          </div>
          <div className="qp-meter">
            <div className="qp-meter-head"><span>Недельное окно</span><b>{codex.secondary_used ?? "?"} %</b></div>
            <Bar percent={codex.secondary_used} />
          </div>
          <small>
            {codex.limit_reached ? <b className="qp-limit-note">Лимит достигнут · </b> : null}
            {codex.primary_reset_s ? `сброс 5-часового окна ${fmtEta(codex.primary_reset_s / 60)}` : ""}
          </small>
        </div>
      ) : <p><small className="qp-muted">Нет данных</small></p>}

      {forecastData ? (
        forecastData.available ? (
          <div className="qp-forecast">
            {forecastData.exhausted
              ? <b className="qp-forecast-bad">Окно исчерпано</b>
              : forecastData.eta_primary_min != null
                ? <>5-часовое окно закончится <b>{fmtEta(forecastData.eta_primary_min)}</b> при темпе {((forecastData.rate_primary_per_min ?? 0) * 5).toLocaleString("ru-RU")} % за 5 минут</>
                : <>Расход не обнаружен — прогноза нет</>}
            {forecastData.eta_secondary_min != null && !forecastData.exhausted
              ? <> · недельное окно закончится {fmtEta(forecastData.eta_secondary_min)}</>
              : null}
            <small className="qp-muted"> · точность: σ={forecastData.sigma_min} мин, пар {fmt(forecastData.pairs)}</small>
          </div>
        ) : (
          <div className="qp-forecast qp-muted">Прогноз недоступен: {forecastData.reason || "недостаточно данных"}</div>
        )
      ) : null}

      <h3 className="qp-title">История 5-часового окна (шаг 5 минут)</h3>
      {points > 0 ? (
        <div className="qp-spark-block">
          <svg className="qp-spark" width={width} height={height} role="img" aria-label="Заполнение 5-часового окна, проценты">
            <polyline points={spark} fill="none" stroke="#e94b4b" strokeWidth="2" />
            <line x1={0} y1={height - 4 - (90 * (height - 8)) / 100} x2={width} y2={height - 4 - (90 * (height - 8)) / 100} stroke="#e6a23c" strokeDasharray="4" />
            {sparkPoints.map((point, index) => (
              <circle key={index} cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} r="3" fill="#e94b4b">
                <title>{`${clockRu(point.ts)} · ${fmt(point.primary)} %`}</title>
              </circle>
            ))}
          </svg>
          <div className="qp-spark-caption">
            <span>{sparkPoints.length ? clockRu(sparkPoints[0]!.ts) : ""}</span>
            <span>{sparkPoints.length ? clockRu(sparkPoints[sparkPoints.length - 1]!.ts) : ""}</span>
          </div>
          {latest?.deltas?.length ? (
            <div className="qp-deltas">
              Изменения за последний шаг: {latest.deltas.map((delta) => `${delta.model} (${delta.key}): ${tokensRu(delta.tokens)} / ${callsRu(delta.calls)}`).join("; ")}
            </div>
          ) : null}
        </div>
      ) : <p><small className="qp-muted">Замеров пока нет</small></p>}

      <h3 className="qp-title">
        Модели
        <select className="qp-days" value={days} aria-label="Период статистики" onChange={(event) => { setDays(Number(event.target.value)); }}>
          <option value={1}>1 день</option>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
        </select>
        <small className="qp-muted qp-hint">нажмите на модель, чтобы показать только её вызовы</small>
      </h3>
      <div className="qp-chip-row">
        {summary.map((item) => (
          <button
            key={`${item.provider}/${item.model}`}
            className={`quiet-button ${model === item.model ? "selected-icon" : ""}`}
            title="Показать вызовы этой модели"
            onClick={() => setModel(model === item.model ? null : item.model)}
          >
            {item.model} · {tokensRu(item.tokens)} / {callsRu(item.calls)}
          </button>
        ))}
      </div>

      {keys.length ? (
        <>
          <h3 className="qp-title">Ключи</h3>
          <div className="qp-chip-row">
            {keys.map((item) => (
              <button
                key={item.key}
                className={`quiet-button ${keyFilter === item.key ? "selected-icon" : ""}`}
                title="Показать вызовы с этим ключом"
                onClick={() => setKeyFilter(keyFilter === item.key ? null : item.key)}
              >
                {item.key} · {tokensRu(item.tokens)}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <h3 className="qp-title">Вызовы {model ? `· ${model}` : ""}{keyFilter ? ` · ${keyFilter}` : ""}</h3>
      <table className="qp-table">
        <thead>
          <tr>{["Время", "Модель", "Провайдер", "Ключ", "Статус", "Токены", "Тип", "Путь"].map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>{timestampRu(row.timestamp || "")}</td>
              <td>{row.model}</td>
              <td>{row.provider}</td>
              <td>{row.api_key_name || "(внутренний)"}</td>
              <td className={row.status >= 400 ? "qp-status-error" : undefined}>{row.status} · {statusLabelRu(row.status)}</td>
              <td>{fmt(row.tokens)}</td>
              <td>{row.request_type || ""}</td>
              <td title={row.path || undefined}>{shortPath(row.path)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td className="qp-empty" colSpan={8}>Нет записей</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
