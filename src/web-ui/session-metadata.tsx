import React from "react";

/**
 * The metadata of one session: the project, the goal and the stage.
 *
 * The three fields compose the title of the session, and the title is written
 * through the native channel of the harness: the adapter reads the name back
 * after the write, so the screen never shows a name that the runtime did not
 * accept. The panel shows what is stored and lets the owner change it; the
 * answer of the server says plainly whether the rename happened.
 */
export interface SessionMetadataLabel {
  project?: string;
  goal?: string;
  stage?: string;
}

/** The answer of POST /api/sessions/label: the label is stored even when the name is not changed. */
export interface SessionLabelSaveAnswer {
  ok?: boolean;
  title?: string;
  nativeTitle?: string;
  renamed?: boolean;
  renameError?: string;
  error?: string;
}

/** What the panel shows after a save: the text and whether it is a failure. */
export interface SessionLabelSaveOutcome {
  message: string;
  failed: boolean;
}

/**
 * The outcome of a save follows the field `renamed`, not the presence of an
 * error: a harness without a native rename channel still stores the label,
 * so the panel says so calmly instead of crying about a failure.
 */
export function sessionLabelSaveOutcome(answer: SessionLabelSaveAnswer, status: number): SessionLabelSaveOutcome {
  const accepted = status >= 200 && status < 300;
  if (!accepted || answer.ok !== true) {
    return { failed: true, message: answer.error || `Нативное переименование не удалось (${status}).` };
  }
  if (answer.renamed === true) {
    return { failed: false, message: `Сохранено. Название сессии: «${answer.nativeTitle ?? answer.title ?? ""}».` };
  }
  const reason = answer.renameError?.trim() ? answer.renameError : "у среды нет нативного канала переименования";
  return { failed: false, message: `Метка сохранена. Имя сессии не изменилось — ${reason}` };
}

/** The line under the fields: a calm hint for a stored label, an error only for a real refusal. */
export function SessionLabelNotice({ message, failed }: { message: string; failed: boolean }): React.ReactElement {
  return (
    <small className={failed ? "autopilot-error" : "settings-hint"} role={failed ? "alert" : "status"}>
      {message}
    </small>
  );
}

interface SessionMetadataProps {
  sessionId: string;
  harness: string;
}

export function SessionMetadata({ sessionId, harness }: SessionMetadataProps): React.ReactElement {
  const [project, setProject] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [stage, setStage] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(
        `/api/sessions/label?sessionId=${encodeURIComponent(sessionId)}&harness=${encodeURIComponent(harness)}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error(`label_read_${response.status}`);
      const data = (await response.json()) as { label?: SessionMetadataLabel };
      setProject(data.label?.project ?? "");
      setGoal(data.label?.goal ?? "");
      setStage(data.label?.stage ?? "");
      setFailed(false);
    } catch {
      setFailed(true);
      setMessage("Метаданные сессии недоступны.");
    }
  }, [sessionId, harness]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = React.useCallback(async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/sessions/label", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sessionId, harness, project, goal, stage }),
      });
      const data = (await response.json().catch(() => ({}))) as SessionLabelSaveAnswer;
      const outcome = sessionLabelSaveOutcome(data, response.status);
      setFailed(outcome.failed);
      setMessage(outcome.message);
    } catch (error) {
      setFailed(true);
      setMessage(`Нативное переименование не удалось: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [sessionId, harness, project, goal, stage]);

  return (
    <div className="settings-block session-metadata" aria-label="Проект, цель и этап">
      <span className="eyebrow">ПРОЕКТ · ЦЕЛЬ · ЭТАП</span>
      <small className="settings-hint">
        ПРОЕКТ, ЦЕЛЬ и ЭТАП сохраняются в Herder. Имя сессии меняется только там, где у среды есть нативный канал
        переименования.
      </small>
      <label className="herder-settings-field">
        Проект
        <input className="herder-settings-input" value={project} onChange={(event) => setProject(event.target.value)} placeholder="проект" />
      </label>
      <label className="herder-settings-field">
        Цель
        <input className="herder-settings-input" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="цель" />
      </label>
      <label className="herder-settings-field">
        Этап
        <input className="herder-settings-input" value={stage} onChange={(event) => setStage(event.target.value)} placeholder="этап" />
      </label>
      <div className="inspector-actions">
        <button type="button" className="quiet-button" disabled={saving} onClick={() => void save()}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </button>
      </div>
      {message ? <SessionLabelNotice message={message} failed={failed} /> : null}
    </div>
  );
}
