import * as React from "react";

type ScheduledTaskAction = "pause" | "disable" | "cancel";
type ScheduledTask = {
  id: string;
  kind: "cadence" | "resume-after";
  state: string;
  harness: string;
  sessionId: string;
  sessionTitle: string | null;
  project: string | null;
  requestId: string | null;
  message: string;
  createdAt: string | null;
  dueAt: string | null;
  lastWakeAt: string | null;
  sequence: number | null;
  reason: string | null;
  overdue: boolean;
  actions: ScheduledTaskAction[];
};
type ScheduledTasksResponse = {
  tasks: ScheduledTask[];
  errors?: Array<{ source: string; error: string }>;
};

const stateLabels: Record<string, string> = {
  scheduled: "запланировано",
  waiting: "ждёт срока или зависимостей",
  dispatching: "передаётся",
  delivery_unknown: "исход неизвестен",
  blocked: "заблокировано",
  paused: "пауза",
  complete: "выключено",
  resumed: "выполнено",
  cancelled: "отменено",
  delivery_failed: "ошибка доставки",
  delivery_blocked: "доставка заблокирована",
};

function formatTime(value: string | null): string {
  if (!value) return "не задано";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "время не подтверждено";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(at);
}

function taskKindLabel(kind: ScheduledTask["kind"]): string {
  return kind === "cadence" ? "Периодическое продолжение" : "Одноразовое продолжение";
}

function actionLabel(action: ScheduledTaskAction): string {
  return action === "pause" ? "Пауза" : action === "disable" ? "Выключить" : "Отменить";
}

export function ScheduledTasksPanel() {
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  const [errors, setErrors] = React.useState<ScheduledTasksResponse["errors"]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState<string>();

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/scheduled-tasks", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => undefined) as ScheduledTasksResponse | { error?: string } | undefined;
      if (!response.ok) throw new Error((body && "error" in body && body.error) || "Не удалось прочитать расписания.");
      const result = body as ScheduledTasksResponse;
      setTasks(Array.isArray(result.tasks) ? result.tasks : []);
      setErrors(Array.isArray(result.errors) ? result.errors : []);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const control = async (task: ScheduledTask, action: ScheduledTaskAction) => {
    const key = task.kind + ":" + task.id;
    setSaving(key);
    setError(undefined);
    try {
      const response = await fetch("/api/scheduled-tasks/" + task.kind + "/" + encodeURIComponent(task.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ action }),
      });
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
      if (!response.ok) throw new Error(body?.error || "Действие над расписанием не подтверждено.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(undefined);
    }
  };

  return <section className="scheduled-tasks-panel" aria-label="Запланированные задачи">
    <div className="scheduled-tasks-heading">
      <div><span className="eyebrow">РАСПИСАНИЯ</span><h3>Запланированные задачи</h3><p>Здесь видны durable cadence и одноразовые wake из того же backend, который их выполняет.</p></div>
      <button className="quiet-button" disabled={loading} onClick={() => void load()}>{loading ? "Читаю…" : "Обновить"}</button>
    </div>
    {error && <div className="scheduled-tasks-error" role="alert">{error}</div>}
    {errors?.map((item) => <div className="scheduled-tasks-warning" key={item.source}>Источник {item.source} недоступен: {item.error}</div>)}
    {loading && tasks.length === 0 && <div className="scheduled-tasks-empty">Загружаю durable расписания…</div>}
    {!loading && tasks.length === 0 && !errors?.length && <div className="scheduled-tasks-empty">Запланированных задач нет.</div>}
    <div className="scheduled-tasks-list">
      {tasks.map((task) => {
        const key = task.kind + ":" + task.id;
        const due = task.dueAt ? formatTime(task.dueAt) : "после завершения зависимостей";
        return <article className={"scheduled-task-card" + (task.overdue ? " scheduled-task-overdue" : "")} key={key}>
          <div className="scheduled-task-head">
            <div><span className={"job-state job-state-" + task.state}>{task.overdue ? "просрочено · " : ""}{stateLabels[task.state] || task.state}</span><strong>{taskKindLabel(task.kind)}</strong></div>
            <span className="scheduled-task-harness">{task.harness}</span>
          </div>
          <p className="scheduled-task-message">{task.message}</p>
          <dl className="scheduled-task-facts">
            <div><dt>Следующее время</dt><dd className={task.overdue ? "scheduled-task-due-overdue" : ""}>{due}</dd></div>
            <div><dt>Проект</dt><dd title={task.project || undefined}>{task.project || "не определён"}</dd></div>
            <div><dt>Сессия</dt><dd title={task.sessionId}>{task.sessionTitle || task.sessionId}</dd></div>
            <div><dt>Создано</dt><dd>{formatTime(task.createdAt)}</dd></div>
            {task.lastWakeAt && <div><dt>Последний wake</dt><dd>{formatTime(task.lastWakeAt)}</dd></div>}
            {task.reason && <div><dt>Причина</dt><dd>{task.reason}</dd></div>}
          </dl>
          <div className="scheduled-task-meta"><code>{task.id}</code>{task.requestId && <span>ключ · <code>{task.requestId}</code></span>}{task.sequence !== null && <span>выполнений · {task.sequence}</span>}</div>
          {task.actions.length > 0 && <div className="scheduled-task-actions">{task.actions.map((action) => <button key={action} className={action === "disable" || action === "cancel" ? "danger-button" : "quiet-button"} disabled={saving !== undefined} onClick={() => void control(task, action)}>{saving === key ? "Сохраняю…" : actionLabel(action)}</button>)}</div>}
        </article>;
      })}
    </div>
  </section>;
}
