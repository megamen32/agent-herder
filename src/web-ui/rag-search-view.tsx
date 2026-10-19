import * as React from "react";
import { readAdvancedSearchPreferences, writeAdvancedSearchPreferences, type SearchHarness } from "./search-preferences.js";

type Harness = SearchHarness;
type SearchHit = { harness: Harness; session_id: string; message_id: string; role: string; title: string; directory: string; project: string; timestamp: string; text: string; score: number };
type RagSettings = { enabled: boolean; harnesses: Record<Harness, boolean>; model: string; dimensions: number; run?: { status: string; processed?: number; indexed?: number; current?: string; error?: string } };
const labels: Record<Harness, string> = { codex: "Codex", zcode: "ZCode", opencode: "OpenCode" };

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

export function RagSearchView({ initialQuery, onInitialQueryApplied, onOpenSession }: { initialQuery?: string; onInitialQueryApplied?: () => void; onOpenSession?: (harness: Harness, sessionId: string) => void }) {
  const [savedPreferences] = React.useState(() => readAdvancedSearchPreferences(window.localStorage));
  const [settings, setSettings] = React.useState<RagSettings>();
  const [query, setQuery] = React.useState(initialQuery ?? savedPreferences.query);
  const [selected, setSelected] = React.useState<Harness[]>(savedPreferences.harnesses);
  const [from, setFrom] = React.useState(savedPreferences.from);
  const [to, setTo] = React.useState(savedPreferences.to);
  const [project, setProject] = React.useState(savedPreferences.project);
  const [results, setResults] = React.useState<SearchHit[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (initialQuery === undefined) return;
    setQuery(initialQuery);
    onInitialQueryApplied?.();
  }, [initialQuery, onInitialQueryApplied]);
  React.useEffect(() => {
    writeAdvancedSearchPreferences(window.localStorage, { query, harnesses: selected, from, to, project });
  }, [query, selected, from, to, project]);

  const refresh = React.useCallback(async () => {
    try { setSettings(await api("/api/rag/settings")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось загрузить настройки поиска"); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    if (!settings?.enabled || settings.run?.status === "complete" || settings.run?.status === "error") return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [settings?.enabled, settings?.run?.status, refresh]);

  const toggleHarness = (harness: Harness) => setSelected((current) => current.includes(harness) ? current.filter((item) => item !== harness) : [...current, harness]);
  const enable = async () => {
    setBusy(true); setError("");
    try {
      setSettings(await api("/api/rag/settings", "PUT", { enabled: true, harnesses: { codex: selected.includes("codex"), zcode: selected.includes("zcode"), opencode: selected.includes("opencode") } }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось включить поиск"); }
    finally { setBusy(false); }
  };
  const search = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const value = await api("/api/rag/search", "POST", { query, harnesses: selected, from: from || undefined, to: to || undefined, project: project || undefined, limit: 20 });
      setResults(value.results || []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Поиск не выполнен"); }
    finally { setBusy(false); }
  };
  const reindex = async () => {
    setBusy(true); setError("");
    try { setSettings(await api("/api/rag/index", "POST", {})); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось запустить индексацию"); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setError("");
    try { setSettings(await api("/api/rag/settings", "PUT", { enabled: false })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выключить индексацию"); }
    finally { setBusy(false); }
  };
  const forget = async () => {
    if (!window.confirm("Удалить индекс Agent Herder из Qdrant? Исходные истории останутся без изменений.")) return;
    setBusy(true); setError("");
    try { setSettings(await api("/api/rag/index", "DELETE", {})); setResults([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить индекс"); }
    finally { setBusy(false); }
  };

  return <section className="rag-search-page" aria-label="Расширенный поиск">
    <header className="rag-search-heading"><div><span className="eyebrow">AGENT HERDER · QDRANT</span><h1>Поиск по сессиям</h1><p>Ищите по смыслу в разговорах Codex, ZCode и OpenCode.</p></div>
      {settings?.enabled && <div className="rag-index-actions"><button className="quiet-button" onClick={() => void reindex()} disabled={busy || settings.run?.status === "running"}>Обновить индекс</button><button className="quiet-button" onClick={() => void disable()} disabled={busy}>Приостановить</button><button className="quiet-button" onClick={() => void forget()} disabled={busy}>Удалить индекс</button></div>}
    </header>
    {settings?.run?.status === "running" && <div className="rag-index-status" role="status">Индексируются сессии{settings.run.current ? ` · ${settings.run.current}` : ""}. Обработано {settings.run.processed || 0}, фрагментов {settings.run.indexed || 0}.</div>}
    {settings?.run?.status === "complete" && <div className="rag-index-status" role="status">Индекс готов · фрагментов: {settings.run.indexed || 0}.</div>}
    {settings?.run?.status === "error" && <div className="rag-index-error" role="alert">Индексация остановилась: {settings.run.error || "ошибка подключения"}</div>}
    {!settings?.enabled ? <div className="rag-opt-in-card"><h2>Семантический поиск выключен</h2><p>При включении Agent Herder проиндексирует выбранные истории. Векторы и текст фрагментов хранятся в отдельной коллекции локального Qdrant; эмбеддинги создаёт внутренний Qwen gateway. В индекс попадают текстовые сообщения пользователя и агента, без результатов инструментов. Отключение приостанавливает обновление; «Удалить индекс» очищает векторные копии.</p><fieldset><legend>Источники</legend>{(Object.keys(labels) as Harness[]).map((harness) => <label key={harness}><input type="checkbox" checked={selected.includes(harness)} onChange={() => toggleHarness(harness)} /> {labels[harness]}</label>)}</fieldset><div className="rag-index-actions"><button className="primary-button" disabled={busy || selected.length === 0} onClick={() => void enable()}>{busy ? "Подключение…" : "Включить и проиндексировать"}</button>{settings?.run?.status === "paused" && <button className="quiet-button" onClick={() => void forget()} disabled={busy}>Удалить сохранённый индекс</button>}</div></div> : <>
      <form className="rag-search-form" onSubmit={(event) => void search(event)}>
        <label className="rag-query-label">Что ищем?<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: как мы восстанавливали подключение ZCode" /></label>
        <div className="rag-filter-row"><fieldset><legend>Среды</legend>{(Object.keys(labels) as Harness[]).map((harness) => <label key={harness}><input type="checkbox" checked={selected.includes(harness)} onChange={() => toggleHarness(harness)} /> {labels[harness]}</label>)}</fieldset>
          <label>С проекта<input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Папка проекта" /></label>
          <label>С даты<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>По дату<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button className="primary-button" disabled={busy || !query.trim()}>{busy ? "Ищем…" : "Найти"}</button>
        </div>
      </form>
      {results.length > 0 && <div className="rag-results" aria-live="polite"><h2>Результаты · {results.length}</h2>{results.map((hit, index) => <article className="rag-result" key={`${hit.harness}:${hit.session_id}:${hit.message_id}:${index}`}><div className="rag-result-meta"><span>{labels[hit.harness] || hit.harness}</span><time>{hit.timestamp ? new Date(hit.timestamp).toLocaleDateString("ru-RU") : ""}</time></div><h3><button className="rag-result-open" onClick={() => onOpenSession?.(hit.harness, hit.session_id)}>{hit.title || hit.session_id} ↗</button></h3>{hit.directory && <small>{hit.directory}</small>}<p>{hit.text}</p></article>)}</div>}
      {!results.length && !busy && <p className="rag-empty">Введите запрос, чтобы найти похожие темы и решения.</p>}
    </>}
    {error && <p className="rag-index-error" role="alert">{error}</p>}
    <footer className="rag-search-footer">Векторная модель {settings?.model || "qwen3-embedding:4b"} · {settings?.dimensions || 2048} измерения · отдельная коллекция Qdrant.</footer>
  </section>;
}
