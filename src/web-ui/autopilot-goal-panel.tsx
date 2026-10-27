import * as React from "react";

type Session = { harness: string; id: string; cwd?: string };
type GoalEvent = { eventId: string; text: string; refs?: Array<{ uri: string; label?: string }>; receivedAt?: string };
type Requirement = { id: string; text: string; sourceEventIds: string[] };
type EvaluationState = { lastDecision: "continue" | "blocked" | "done-candidate"; lastReason?: string; requirementsStatus: Array<{ id: string; status: "open" | "fulfilled" | "blocked"; evidenceIds: string[] }> };
type GoalSnapshot = {
  armed: boolean; completed: boolean; stopped: boolean; goalRevision: number;
  primaryEvents: GoalEvent[]; requirements: Requirement[]; inputCursor: number; processedInputCursor: number;
  evaluation?: EvaluationState;
};
type GoalState = { available: boolean; goal: GoalSnapshot | null; judge: { model: string; transport: "configured-openai-compatible"; subscription: false } };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function AutopilotGoalPanel({ session, request, supported, onChanged }: { session: Session; request: Request; supported: boolean; onChanged?: (session: Session) => void }) {
  const identity = `${session.harness}\0${session.id}\0${session.cwd ?? ""}`;
  const identityRef = React.useRef(identity);
  identityRef.current = identity;
  const [state, setState] = React.useState<GoalState>();
  const [draft, setDraft] = React.useState("");
  const [refDraft, setRefDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const attemptRef = React.useRef<{ key: string; inputId: string } | undefined>(undefined);
  const loadIdRef = React.useRef(0);
  const getInFlightRef = React.useRef(false);

  const route = `/api/autopilot/goals/${encodeURIComponent(session.harness)}/${encodeURIComponent(session.id)}?cwd=${encodeURIComponent(session.cwd ?? "")}`;
  const projectRootUrl = session.cwd?.startsWith("/")
    ? new URL(`file://${(`/${session.cwd.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`).replace(/\/+$/u, "")}/`)
    : undefined;
  const resolveRef = (value: string): string | undefined => {
    if (!projectRootUrl) return undefined;
    try {
      const parsed = value.startsWith("file:") ? new URL(value)
        : value.startsWith("/") ? new URL(`file://${value}`)
          : new URL(value, projectRootUrl);
      if (parsed.protocol !== "file:" || (parsed.hostname && parsed.hostname !== "localhost") || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
      const rootPath = projectRootUrl.pathname;
      if (!(parsed.pathname === rootPath.slice(0, -1) || parsed.pathname.startsWith(rootPath))) return undefined;
      return parsed.href;
    } catch { return undefined; }
  };
  const refsFor = (text: string) => {
    const refs = new Map<string, { uri: string; label?: string }>();
    const invalid: string[] = [];
    for (const match of text.matchAll(/file:\/\/\/[^\s"'<>]+/gu)) {
      const uri = resolveRef(match[0]);
      if (uri) refs.set(uri, { uri }); else invalid.push(match[0]);
    }
    for (const line of refDraft.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
      const uri = resolveRef(line);
      if (uri) refs.set(uri, { uri }); else invalid.push(line);
    }
    return { refs: [...refs.values()], invalid };
  };
  const load = React.useCallback(async (silent = false) => {
    if (getInFlightRef.current) return;
    getInFlightRef.current = true;
    const loadId = ++loadIdRef.current;
    const capturedIdentity = identity;
    if (!silent) { setLoading(true); setError(""); }
    try {
      const result = await request<GoalState>(route);
      if (identityRef.current !== capturedIdentity) return;
      if (!result.available) { setError("Управление целью недоступно для этой сессии."); return; }
      setState(result);
    } catch (cause) {
      if (identityRef.current === capturedIdentity) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadIdRef.current === loadId) {
        getInFlightRef.current = false;
        if (identityRef.current === capturedIdentity) setLoading(false);
      }
    }
  }, [identity, request, route]);

  React.useEffect(() => {
    loadIdRef.current += 1; getInFlightRef.current = false; attemptRef.current = undefined;
    setState(undefined); setDraft(""); setRefDraft(""); setError(""); setSaving(false); setLoading(false);
    if (!supported) { setError("Для удалённой сессии управление целью пока недоступно."); return; }
    void load();
  }, [identity, load, supported]);

  const goal = state?.goal;
  React.useEffect(() => {
    if (!supported || !goal?.armed || goal.completed) return;
    const timer = window.setInterval(() => { if (!saving) void load(true); }, 7_000);
    return () => window.clearInterval(timer);
  }, [goal?.armed, goal?.completed, identity, load, saving, supported]);

  const mutate = async (action: "arm" | "amend" | "stop" | "resume") => {
    const capturedIdentity = identity;
    setSaving(true); setError("");
    try {
      const parsedRefs = refsFor(draft);
      const refs = parsedRefs.refs;
      const intentKey = `${action}\0${action === "arm" || action === "amend" ? draft : ""}\0${JSON.stringify(refs)}`;
      const inputId = action === "arm" || action === "amend"
        ? (attemptRef.current?.key === intentKey ? attemptRef.current.inputId : crypto.randomUUID())
        : undefined;
      if (inputId) attemptRef.current = { key: intentKey, inputId };
      const body = action === "arm"
        ? { cwd: session.cwd ?? "", action, objective: draft, inputId, refs }
        : action === "amend"
          ? { cwd: session.cwd ?? "", action, text: draft, inputId, refs }
          : { cwd: session.cwd ?? "", action };
      const result = await request<GoalState>(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (identityRef.current !== capturedIdentity) return;
      if (!result.available) { setError("Управление целью недоступно для этой сессии."); return; }
      if (inputId && attemptRef.current?.inputId === inputId) attemptRef.current = undefined;
      setState(result);
      if (action === "arm" || action === "amend") { setDraft(""); setRefDraft(""); }
      onChanged?.({ ...session });
    } catch (cause) {
      if (identityRef.current === capturedIdentity) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (identityRef.current === capturedIdentity) setSaving(false);
    }
  };

  const status = !goal ? "Цель ещё не сохранена" : goal.stopped ? "Остановлен" : goal.completed ? "Завершён по проверке" : !goal.armed ? "Выключен" : goal.inputCursor !== goal.processedInputCursor ? "Ожидает обработки уточнения" : "В работе";
  const refInput = refsFor(draft);
  const existingRefs = [...new Map((goal?.primaryEvents.flatMap(event => event.refs ?? []) ?? []).map(ref => [ref.uri, ref])).values()];
  return <section className="autopilot-control autopilot-goal-panel" aria-label="Полная цель автопилота">
    <div className="autopilot-goal-heading"><span><span className="eyebrow">ЦЕЛЬ АВТОПИЛОТА</span><strong>{status}</strong><small>Сохранение цели задаёт поручение автопилоту; само по себе оно не означает выполнения.</small></span>{supported && <button type="button" className="quiet-button" disabled={loading || saving} onClick={() => void load()}>{loading ? "Обновляю…" : "Обновить"}</button>}</div>
    {!supported ? <p role="status">Для удалённой сессии управление целью пока недоступно. Локальное состояние не подменяет удалённую цель.</p> : <>
      {loading && !state && <p role="status">Загружаю цель…</p>}
      {state?.judge && <small>Судья: {state.judge.model} · настроенный OpenAI совместимый маршрут</small>}
      {goal && <><h4>Исходное поручение и уточнения</h4><ol>{goal.primaryEvents.map((event) => <li key={event.eventId}><p>{event.text}</p></li>)}</ol><h4>Требования</h4>{goal.requirements.length ? <ul>{goal.requirements.map((item) => {
        const reqStatus = goal.evaluation?.requirementsStatus.find(value => value.id === item.id);
        return <li key={item.id}>{item.text}{reqStatus && <small> — {reqStatus.status === "fulfilled" ? "подтверждено" : reqStatus.status === "blocked" ? "заблокировано" : "открыто"}</small>}</li>;
      })}</ul> : <small>Требования пока не выделены.</small>}{goal.evaluation?.lastReason && <p role="status">Последняя проверка: {goal.evaluation.lastReason}</p>}</>}
      {!goal && <label>Полный текст цели<textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} placeholder="Введите исходное поручение целиком" disabled={saving} /></label>}
      {goal?.armed && !goal.completed && <label>Уточнение цели<textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} placeholder="Добавьте уточнение, не удаляя исходное поручение" disabled={saving} /></label>}
      {(!goal || (goal.armed && !goal.completed)) && <label>Файлы результата для проверки (по одному пути на строку)<textarea value={refDraft} onChange={(event) => setRefDraft(event.target.value)} rows={2} placeholder="gamma.md или subdir/result.md" disabled={saving} /></label>}
      {(existingRefs.length > 0 || refInput.refs.length > 0) && <small>Файлы для проверки: {[...existingRefs.map(ref => ref.uri), ...refInput.refs.map(ref => ref.uri)].join(", ")}</small>}
      {refInput.invalid.length > 0 && <small role="alert">Некорректные пути к файлам: {refInput.invalid.join(", ")}. Укажите имя или путь внутри проекта, абсолютный путь внутри проекта либо file:// URI.</small>}
      <div className="inspector-actions">
        {!goal && <button className="primary-button" disabled={saving || loading || !draft.trim() || refInput.invalid.length > 0} onClick={() => void mutate("arm")}>{saving ? "Сохраняю…" : "Сохранить цель и включить"}</button>}
        {goal?.armed && !goal.completed && <><button className="quiet-button" disabled={saving || loading || !draft.trim() || refInput.invalid.length > 0} onClick={() => void mutate("amend")}>{saving ? "Сохраняю…" : "Добавить уточнение"}</button><button className="stop-button" disabled={saving || loading} onClick={() => void mutate("stop")}>Остановить цель</button></>}
        {goal?.stopped && <button className="quiet-button" disabled={saving || loading} onClick={() => void mutate("resume")}>Возобновить цель</button>}
      </div>
      {error && <p role="alert" className="permission-mode-error">{error}</p>}
    </>}
  </section>;
}
