import * as React from "react";
import { readAdvancedSearchPreferences, writeAdvancedSearchPreferences, type SearchHarness } from "./search-preferences.js";

type Harness = SearchHarness;
type SearchHit = { harness: Harness; session_id: string; message_id: string; role: string; title: string; directory: string; project: string; timestamp: string; text: string; score: number; source?: "exact" | "semantic" };
type RagSettings = { enabled: boolean; harnesses: Record<Harness, boolean>; model: string; dimensions: number; run?: { status: string; processed?: number; indexed?: number; current?: string; error?: string } };
type SearchTimings = { exactMs?: number; semanticMs?: number; totalMs?: number };
const labels: Record<Harness, string> = { codex: "Codex", zcode: "ZCode", opencode: "OpenCode" };

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

export type RagIndexRun = { status: string; processed?: number; indexed?: number; current?: string; error?: string };
export type RagIndexNotice = { text: string; tone: "status" | "warning" };

/**
 * Статус индекса поиска — по-русски и без сырых счётчиков: пустой индекс
 * называется прямо, иначе владелец не понимает, ищет панель или нет.
 */
export function ragIndexNoticeRu(run: RagIndexRun | undefined): RagIndexNotice | undefined {
  if (!run) return undefined;
  const processed = typeof run.processed === "number" && Number.isFinite(run.processed) ? Math.max(0, Math.floor(run.processed)) : 0;
  const indexed = typeof run.indexed === "number" && Number.isFinite(run.indexed) ? Math.max(0, Math.floor(run.indexed)) : 0;
  if (run.status === "running") {
    if (indexed === 0) {
      return { tone: "warning", text: processed === 0
        ? "Индекс поиска пуст — ищите по списку сессий. Индексация ещё не началась."
        : `Индекс поиска пуст: обработано ${processed} сессий, фрагментов пока нет — ищите по списку сессий.` };
    }
    return { tone: "status", text: `Индексируются сессии${run.current ? ` · ${run.current}` : ""}. Обработано ${processed}, фрагментов ${indexed}.` };
  }
  if (run.status === "complete") {
    if (indexed === 0) return { tone: "warning", text: "Индекс поиска пуст — ищите по списку сессий." };
    return { tone: "status", text: `Индекс готов · фрагментов: ${indexed}.` };
  }
  if (run.status === "error") {
    return { tone: "warning", text: "Индексация остановилась — поиск по тексту и смыслу сейчас не работает. Ищите по списку сессий." };
  }
  return undefined;
}

export function RagSearchView({ initialQuery, onInitialQueryApplied, onOpenSession }: { initialQuery?: string; onInitialQueryApplied?: () => void; onOpenSession?: (harness: Harness, sessionId: string) => void }) {
  const [savedPreferences] = React.useState(() => readAdvancedSearchPreferences(window.localStorage));
  const [settings, setSettings] = React.useState<RagSettings>();
  const [query, setQuery] = React.useState(initialQuery ?? savedPreferences.query);
  const [selected, setSelected] = React.useState<Harness[]>(savedPreferences.harnesses);
  const [from, setFrom] = React.useState(savedPreferences.from);
  const [to, setTo] = React.useState(savedPreferences.to);
  const [project, setProject] = React.useState(savedPreferences.project);
  const [exactResults, setExactResults] = React.useState<SearchHit[]>([]);
  const [semanticResults, setSemanticResults] = React.useState<SearchHit[]>([]);
  const [exactExpanded, setExactExpanded] = React.useState(true);
  const [semanticExpanded, setSemanticExpanded] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [searchStage, setSearchStage] = React.useState<"exact" | "semantic" | null>(null);
  const [timings, setTimings] = React.useState<SearchTimings>();
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
    event.preventDefault(); setBusy(true); setSearchStage("exact"); setTimings(undefined); setExactResults([]); setSemanticResults([]); setError("");
    try {
      const response = await fetch("/api/rag/search/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ query, harnesses: selected, from: from || undefined, to: to || undefined, project: project || undefined, limit: 20 }),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw new Error(value.error || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Сервер не открыл поток результатов");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = (block: string) => {
        const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!data) return;
        const progress = JSON.parse(data);
        if (progress.type === "phase") {
          setSearchStage(progress.stage === "semantic" ? "semantic" : "exact");
        } else if (progress.type === "results") {
          const incoming = Array.isArray(progress.results) ? progress.results as SearchHit[] : [];
          if (progress.source === "semantic") setSemanticResults(incoming);
          else setExactResults(incoming);
          setTimings((current) => ({ ...current, [progress.source === "semantic" ? "semanticMs" : "exactMs"]: progress.elapsedMs }));
        } else if (progress.type === "complete") {
          setTimings({ exactMs: progress.exactMs, semanticMs: progress.semanticMs, totalMs: progress.totalMs });
        } else if (progress.type === "error") {
          setError(progress.message || "Поиск не выполнен");
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) consume(block);
        if (done) {
          if (buffer.trim()) consume(buffer);
          break;
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Поиск не выполнен"); }
    finally { setBusy(false); setSearchStage(null); }
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
    try { setSettings(await api("/api/rag/index", "DELETE", {})); setExactResults([]); setSemanticResults([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить индекс"); }
    finally { setBusy(false); }
  };

  const renderHits = (hits: SearchHit[]) => hits.map((hit, index) => <article className="rag-result" key={`${hit.harness}:${hit.session_id}:${hit.message_id}:${index}`}><div className="rag-result-meta"><span>{labels[hit.harness] || hit.harness}</span><time>{hit.timestamp ? new Date(hit.timestamp).toLocaleDateString("ru-RU") : ""}</time></div><h3><button className="rag-result-open" onClick={() => onOpenSession?.(hit.harness, hit.session_id)}>{hit.title || hit.session_id} ↗</button></h3>{hit.directory && <small>{hit.directory}</small>}<p>{hit.text}</p></article>);
  const exactPending = busy && searchStage === "exact" && timings?.exactMs === undefined;
  const semanticPending = busy && searchStage !== null && timings?.semanticMs === undefined;
  const indexNotice = ragIndexNoticeRu(settings?.run);

  return <section className="rag-search-page" aria-label="Расширенный поиск">
    <header className="rag-search-heading"><div><span className="eyebrow">AGENT HERDER · QDRANT</span><h1>Поиск по сессиям</h1><p>Ищите по тексту и смыслу в разговорах Codex, ZCode и OpenCode.</p></div>
      {settings?.enabled && <div className="rag-index-actions"><button className="quiet-button" onClick={() => void reindex()} disabled={busy || settings.run?.status === "running"}>Обновить индекс</button><button className="quiet-button" onClick={() => void disable()} disabled={busy}>Приостановить</button><button className="quiet-button" onClick={() => void forget()} disabled={busy}>Удалить индекс</button></div>}
    </header>
    {indexNotice && <div className="rag-index-status" role="status">{indexNotice.text}</div>}
    {settings?.run?.status === "error" && <div className="rag-index-error" role="alert" title={settings.run.error || ""}>Индексация остановилась — поиск по тексту и смыслу сейчас не работает. Ищите по списку сессий.</div>}
    {!settings?.enabled ? <div className="rag-opt-in-card"><h2>Семантический поиск выключен</h2><p>При включении Agent Herder проиндексирует выбранные истории. Векторы и текст фрагментов хранятся в отдельной коллекции локального Qdrant; эмбеддинги создаёт внутренний Qwen gateway. В индекс попадают текстовые сообщения пользователя и агента, без результатов инструментов. Отключение приостанавливает обновление; «Удалить индекс» очищает векторные копии.</p><fieldset><legend>Источники</legend>{(Object.keys(labels) as Harness[]).map((harness) => <label key={harness}><input type="checkbox" checked={selected.includes(harness)} onChange={() => toggleHarness(harness)} /> {labels[harness]}</label>)}</fieldset><div className="rag-index-actions"><button className="primary-button" disabled={busy || selected.length === 0} onClick={() => void enable()}>{busy ? "Подключение…" : "Включить и проиндексировать"}</button>{settings?.run?.status === "paused" && <button className="quiet-button" onClick={() => void forget()} disabled={busy}>Удалить сохранённый индекс</button>}</div></div> : <>
      <form className="rag-search-form" onSubmit={(event) => void search(event)}>
        <label className="rag-query-label">Что ищем?<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: как мы восстанавливали подключение ZCode" /></label>
        <div className="rag-filter-row"><fieldset><legend>Среды</legend>{(Object.keys(labels) as Harness[]).map((harness) => <label key={harness}><input type="checkbox" checked={selected.includes(harness)} onChange={() => toggleHarness(harness)} /> {labels[harness]}</label>)}</fieldset>
          <label>С проекта<input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Папка проекта" /></label>
          <label>С даты<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>По дату<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button className="primary-button" disabled={busy || !query.trim()}>{busy ? searchStage === "semantic" ? "Ищем по смыслу…" : "Ищем в тексте…" : "Найти"}</button>
        </div>
      </form>
      {(busy || timings) && <div className="rag-result-groups" aria-live="polite">
        <section className="rag-result-group" aria-label="Точный поиск">
          <button className="rag-result-fold" type="button" aria-expanded={exactExpanded} aria-controls="rag-exact-results" onClick={() => setExactExpanded((open) => !open)}><span>{exactExpanded ? "⌄" : "›"} Точный поиск · {exactResults.length}</span><small>{timings?.exactMs === undefined ? exactPending ? "Ищет…" : "—" : `${timings.exactMs} мс`}</small></button>
          <div id="rag-exact-results" hidden={!exactExpanded} className="rag-results">
            {exactPending ? <p className="rag-empty">Ищу совпадения в тексте…</p> : exactResults.length ? renderHits(exactResults) : <p className="rag-empty">Точных совпадений не найдено.</p>}
          </div>
        </section>
        <section className="rag-result-group" aria-label="Семантический поиск">
          <button className="rag-result-fold" type="button" aria-expanded={semanticExpanded} aria-controls="rag-semantic-results" onClick={() => setSemanticExpanded((open) => !open)}><span>{semanticExpanded ? "⌄" : "›"} Семантический RAG · {semanticResults.length}</span><small>{timings?.semanticMs === undefined ? semanticPending ? "Ищет…" : "—" : `${timings.semanticMs} мс`}</small></button>
          <div id="rag-semantic-results" hidden={!semanticExpanded} className="rag-results">
            {semanticPending ? <p className="rag-empty">{searchStage === "semantic" ? "Подбираю похожие по смыслу…" : "Начнётся после текстового поиска."}</p> : semanticResults.length ? renderHits(semanticResults) : <p className="rag-empty">Семантических совпадений не найдено.</p>}
          </div>
        </section>
      </div>}
      {!timings && !busy && <p className="rag-empty">Введите запрос, чтобы отдельно найти совпадения в тексте и похожие темы.</p>}
    </>}
    {error && <p className="rag-index-error" role="alert">{error}</p>}
    <footer className="rag-search-footer">Векторная модель {settings?.model || "qwen3-embedding:4b"} · {settings?.dimensions || 2048} измерения · отдельная коллекция Qdrant.</footer>
  </section>;
}
