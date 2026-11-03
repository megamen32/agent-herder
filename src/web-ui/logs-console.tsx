import * as React from "react";
import "./logs-console.css";

type LogsResponse = {
  at: string;
  unit: string;
  lines: string[];
  truncated: boolean;
  since?: string;
  error?: string;
};

const SINCE_OPTIONS = [
  { value: "5 min ago", label: "5 минут" },
  { value: "15 min ago", label: "15 минут" },
  { value: "60 min ago", label: "час" },
  { value: "", label: "вся лента" },
];

const LINE_OPTIONS = [200, 400, 1000, 2000];

function lineClass(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("429")) return "log-line log-line-429";
  if (/fatal|unhandled|typeerror|referenceerror|\berror\b/.test(lower)) return "log-line log-line-error";
  if (lower.includes("paused") || lower.includes("пауз")) return "log-line log-line-pause";
  return "log-line";
}

export function LogsConsole(): React.ReactElement {
  const [lines, setLines] = React.useState<string[]>([]);
  const [at, setAt] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [lineCount, setLineCount] = React.useState(400);
  const [since, setSince] = React.useState("15 min ago");
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("lines", String(lineCount));
      if (since) params.set("since", since);
      const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const data = (await res.json().catch(() => undefined)) as LogsResponse | undefined;
      if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
      if (data.error) throw new Error(data.error);
      setLines(data.lines);
      setAt(data.at);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Логи недоступны.");
    } finally {
      setLoading(false);
    }
  }, [lineCount, since]);

  React.useEffect(() => {
    if (paused) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh, paused]);

  React.useEffect(() => {
    if (stickRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((l) => l.toLowerCase().includes(needle));
  }, [lines, filter]);

  return (
    <section className="logs-console" aria-label="Логи Agent Herder">
      <header className="logs-console-header">
        <div>
          <h1>Логи</h1>
          <p>Журнал службы agent-herder. Обновление раз в 4 секунды.</p>
        </div>
        <div className="logs-console-controls">
          <label>Объём<select value={lineCount} onChange={(e) => setLineCount(Number(e.target.value))}>{LINE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>Период<select value={since} onChange={(e) => setSince(e.target.value)}>{SINCE_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}</select></label>
          <label>Поиск по строке<input type="text" placeholder="например: 429, chatgpt, paused" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          <button className="quiet-button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>{paused ? "Продолжить" : "Пауза"}</button>
          <button className="quiet-button" disabled={loading} onClick={() => void refresh()}>{loading ? "…" : "Обновить"}</button>
        </div>
      </header>
      {error && <div className="logs-console-error" role="alert">{error}</div>}
      <div className="logs-console-body" ref={bodyRef} role="log" tabIndex={0} onScroll={onScroll}>
        {filtered.map((line, i) => <div key={i} className={lineClass(line)}>{line || "\u00a0"}</div>)}
      </div>
      <footer className="logs-console-footer">
        <span>Строк: {filtered.length}{filter.trim() && ` из ${lines.length}`}</span>
        <span>Обновлено: {at || "—"}</span>
        <span>{paused ? "пауза" : "live"}</span>
      </footer>
    </section>
  );
}
