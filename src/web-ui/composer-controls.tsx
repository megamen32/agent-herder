import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { newInputId, type DeliveryMode } from "./composer-delivery.js";

export type QueueProcessingTarget = { hostId: string; harness: string; sessionId: string };

export type QueueProcessingState = QueueProcessingTarget & {
  scope: string;
  loaded: boolean;
  canResume: boolean;
  capability?: string;
  revision: number;
  autoDrain: boolean;
  pendingCount: number;
  oldestQueueItemId?: string | null;
  nativeStatus?: string;
  pendingRequestCount?: number;
  reason?: string;
};

export type QueueProcessingRead =
  | { available: true; state: QueueProcessingState }
  | { available: false; reason: string };

export type QueueProcessingResumeResult = {
  inputId: string;
  status: "accepted" | "stale" | "unknown" | "unsupported" | "noop";
  state?: QueueProcessingState;
  nativeInputActuallyStarted?: boolean;
  reason?: string;
};

type QueueProcessingIntent = { inputId: string; status: "pending" | "unknown" | "accepted"; expectedRevision?: number; acceptedRevision?: number };
type QueueProcessingIntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function queueProcessingIntentStorageKey(target: QueueProcessingTarget): string {
  return `agent-herder.queue-processing-intent:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.harness)}:${encodeURIComponent(target.sessionId)}`;
}

function readQueueProcessingIntent(storage: QueueProcessingIntentStorage | undefined, key: string): QueueProcessingIntent | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { inputId: "unknown", status: "unknown" };
    const candidate = value as Partial<QueueProcessingIntent>;
    if (typeof candidate.inputId !== "string" || !candidate.inputId || !["pending", "unknown", "accepted"].includes(candidate.status || "")) {
      return { inputId: "unknown", status: "unknown" };
    }
    return {
      inputId: candidate.inputId,
      status: candidate.status as QueueProcessingIntent["status"],
      ...(Number.isSafeInteger(candidate.expectedRevision) ? { expectedRevision: candidate.expectedRevision } : {}),
      ...(Number.isSafeInteger(candidate.acceptedRevision) ? { acceptedRevision: candidate.acceptedRevision } : {}),
    };
  } catch {
    return { inputId: "unknown", status: "unknown" };
  }
}

export function queueProcessingStateMatchesTarget(state: QueueProcessingState, target: QueueProcessingTarget): boolean {
  return state.hostId === target.hostId && state.harness === target.harness && state.sessionId === target.sessionId;
}

export function queueProcessingCanResume(state: QueueProcessingState | undefined, target: QueueProcessingTarget, unresolved: boolean): boolean {
  return Boolean(state
    && !unresolved
    && queueProcessingStateMatchesTarget(state, target)
    && state.scope === "session"
    && state.loaded === true
    && state.canResume === true
    && state.capability === "setAutoDrain"
    && Number.isSafeInteger(state.revision)
    && state.revision >= 0
    && Number.isSafeInteger(state.pendingCount)
    && state.pendingCount > 0);
}

export function queueProcessingIntentCanClearOnReadback(
  intent: QueueProcessingIntent | undefined,
  state: QueueProcessingState,
): boolean {
  const priorRevision = intent?.status === "accepted" ? intent.acceptedRevision : intent?.expectedRevision;
  return Boolean(intent && priorRevision !== undefined && state.revision > priorRevision);
}

export type QueueProcessingAttempt = {
  kind: "accepted" | "started" | "stale" | "unknown" | "unsupported" | "noop" | "not-ready";
  inputId?: string;
  state?: QueueProcessingState;
  message: string;
};

/** One explicit CAS intent. It never retries, and writes a durable-in-tab intent before POST. */
export async function attemptQueueProcessingResume(input: {
  target: QueueProcessingTarget;
  displayedState: QueueProcessingState;
  readState: (target: QueueProcessingTarget) => Promise<QueueProcessingRead>;
  resume: (target: QueueProcessingTarget, request: { inputId: string; expectedRevision: number }) => Promise<QueueProcessingResumeResult>;
  storage: QueueProcessingIntentStorage;
  makeInputId?: () => string;
}): Promise<QueueProcessingAttempt> {
  const storageKey = queueProcessingIntentStorageKey(input.target);
  const existing = readQueueProcessingIntent(input.storage, storageKey);
  if (existing) {
    return { kind: existing.status === "accepted" ? "accepted" : "unknown", inputId: existing.inputId, message: existing.status === "accepted"
      ? "Настройка очереди принята. Повтор заблокирован до изменения native revision; начало обработки не подтверждено."
      : "Предыдущая команда не получила подтверждённого исхода. Повтор заблокирован; проверьте состояние вручную." };
  }
  if (!queueProcessingStateMatchesTarget(input.displayedState, input.target)) {
    return { kind: "unsupported", message: "Состояние принадлежит другой сессии; команда не отправлена." };
  }

  let fresh: QueueProcessingRead;
  try { fresh = await input.readState(input.target); }
  catch { return { kind: "not-ready", message: "Не удалось обновить состояние очереди. Команда не отправлена." }; }
  if (!fresh.available) return { kind: "unsupported", message: fresh.reason || "Управление очередью недоступно для этой сессии." };
  if (!queueProcessingStateMatchesTarget(fresh.state, input.target)) {
    return { kind: "unsupported", message: "Свежее состояние относится к другой сессии; команда не отправлена." };
  }
  if (fresh.state.revision !== input.displayedState.revision) {
    return { kind: "stale", state: fresh.state, message: "Состояние очереди изменилось. Я обновил его; действие не повторялось." };
  }
  if (!queueProcessingCanResume(fresh.state, input.target, false)) {
    return { kind: "not-ready", state: fresh.state, message: fresh.state.reason || "Для этой сессии сейчас нет загруженной поддерживаемой очереди для возобновления." };
  }

  const inputId = (input.makeInputId ?? newInputId)();
  try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "pending" } satisfies QueueProcessingIntent)); }
  catch { return { kind: "not-ready", state: fresh.state, message: "Не удалось сохранить идентификатор команды; ничего не отправлено." }; }

  let result: QueueProcessingResumeResult;
  try { result = await input.resume(input.target, { inputId, expectedRevision: fresh.state.revision }); }
  catch {
    try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "unknown", expectedRevision: fresh.state.revision } satisfies QueueProcessingIntent)); } catch { /* the original pending key still fails closed */ }
    return { kind: "unknown", inputId, message: "Исход команды неизвестен. Повтор не выполняется." };
  }
  if (result.inputId !== inputId) {
    try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "unknown", expectedRevision: fresh.state.revision } satisfies QueueProcessingIntent)); } catch { /* keep the existing pending key */ }
    return { kind: "unknown", inputId, message: "Ответ не совпадает с этой командой. Повтор заблокирован." };
  }
  if (result.status === "unknown") {
    try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "unknown", expectedRevision: fresh.state.revision } satisfies QueueProcessingIntent)); } catch { /* keep the existing pending key */ }
    const exactState = result.state && queueProcessingStateMatchesTarget(result.state, input.target) ? result.state : undefined;
    return { kind: "unknown", inputId, state: exactState, message: result.reason || "Исход команды неизвестен. Повтор не выполняется." };
  }
  if (result.status === "accepted") {
    if (!result.state || !queueProcessingStateMatchesTarget(result.state, input.target) || result.state.scope !== "session"
      || !result.state.loaded || result.state.capability !== "setAutoDrain" || !result.state.autoDrain
      || result.state.revision < fresh.state.revision) {
      try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "unknown", expectedRevision: fresh.state.revision } satisfies QueueProcessingIntent)); } catch { /* keep the existing pending key */ }
      return { kind: "unknown", inputId, state: result.state, message: "Команда принята, но точный readback настройки очереди не подтверждён. Повтор заблокирован." };
    }
    try { input.storage.setItem(storageKey, JSON.stringify({ inputId, status: "accepted", expectedRevision: fresh.state.revision, acceptedRevision: result.state.revision } satisfies QueueProcessingIntent)); } catch { /* keep the previous pending key */ }
    return result.nativeInputActuallyStarted === true
      ? { kind: "started", inputId, state: result.state, message: "Обработка очереди началась в этой сессии." }
      : { kind: "accepted", inputId, state: result.state, message: "Настройка очереди сохранена для этой сессии и следующих сообщений; начало обработки не подтверждено." };
  }
  input.storage.removeItem(storageKey);
  if (result.status === "stale") return { kind: "stale", inputId, state: result.state, message: result.reason || "Состояние очереди изменилось. Действие не повторялось." };
  if (result.status === "noop") return { kind: "noop", inputId, state: result.state, message: result.reason || "Настройка уже применена; новая команда не отправлена." };
  return { kind: "unsupported", inputId, state: result.state, message: result.reason || "Эта сессия не поддерживает возобновление обработки очереди." };
}

export function QueueProcessingControl({
  target,
  readState,
  resume,
  storage,
}: {
  target: QueueProcessingTarget;
  readState: (target: QueueProcessingTarget) => Promise<QueueProcessingRead>;
  resume: (target: QueueProcessingTarget, request: { inputId: string; expectedRevision: number }) => Promise<QueueProcessingResumeResult>;
  storage?: QueueProcessingIntentStorage;
}) {
  const targetKey = `${target.hostId}\0${target.harness}\0${target.sessionId}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const readStateRef = useRef(readState);
  readStateRef.current = readState;
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const storageRef = useRef(storage);
  storageRef.current = storage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const intentKey = queueProcessingIntentStorageKey(target);
  const [intent, setIntent] = useState<QueueProcessingIntent | undefined>(() => readQueueProcessingIntent(storageRef.current, intentKey));
  const [state, setState] = useState<QueueProcessingState>();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const value = await readStateRef.current(targetRef.current);
      if (signal?.aborted) return;
      if (value.available && queueProcessingStateMatchesTarget(value.state, targetRef.current)) {
        const storedIntent = readQueueProcessingIntent(storageRef.current, intentKey);
        if (queueProcessingIntentCanClearOnReadback(storedIntent, value.state)) {
          storageRef.current?.removeItem(intentKey);
          setIntent(undefined);
          setMessage("Свежая версия очереди отличается от предыдущей команды. Проверьте состояние перед новым действием.");
        }
        setState(value.state);
        setReason("");
      } else {
        setState(undefined);
        setReason(value.available ? "Ответ состояния не относится к выбранной сессии." : value.reason);
      }
    } catch {
      if (!signal?.aborted) { setState(undefined); setReason("Не удалось прочитать состояние обработки очереди."); }
    } finally { if (!signal?.aborted) setLoading(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    setState(undefined); setReason(""); setMessage(""); setLoading(true);
    setIntent(readQueueProcessingIntent(storageRef.current, queueProcessingIntentStorageKey(targetRef.current)));
    void refresh(controller.signal);
    return () => controller.abort();
  }, [targetKey]);

  const run = async () => {
    if (!state || busy || intent) return;
    setBusy(true); setMessage("");
    try {
      const attempt = await attemptQueueProcessingResume({
        target: targetRef.current,
        displayedState: state,
        readState: (exactTarget) => readStateRef.current(exactTarget),
        resume: (exactTarget, request) => resumeRef.current(exactTarget, request),
        storage: storageRef.current ?? { getItem: () => null, setItem: () => { throw new Error("storage unavailable"); }, removeItem: () => {} },
      });
      if (attempt.kind === "stale") {
        setState(undefined);
        setReason("Состояние очереди изменилось. Нажмите «Обновить очередь» перед новым действием.");
      } else if (attempt.state && queueProcessingStateMatchesTarget(attempt.state, targetRef.current)) setState(attempt.state);
      if ((attempt.kind === "unknown" || attempt.kind === "accepted") && attempt.inputId) {
        const nextIntent = readQueueProcessingIntent(storageRef.current, intentKey) ?? { inputId: attempt.inputId, status: attempt.kind === "accepted" ? "accepted" as const : "unknown" as const };
        setIntent(nextIntent);
      } else if (attempt.kind === "unknown" || attempt.kind === "accepted") {
        setIntent(readQueueProcessingIntent(storageRef.current, intentKey));
      } else if (["accepted", "started", "stale", "unsupported", "noop"].includes(attempt.kind)) {
        setIntent(readQueueProcessingIntent(storageRef.current, intentKey));
      }
      setMessage(attempt.message);
    } finally { setBusy(false); }
  };

  const unresolved = Boolean(intent);
  const ready = queueProcessingCanResume(state, target, unresolved);
  return <section className="queue-processing-control" aria-label="Обработка очереди этой сессии">
    <div className="queue-processing-copy">
      <strong>Обработка очереди</strong>
      <small>{state?.scope === "session" ? "Настройка сохраняется только для этой сессии и следующих сообщений." : "Управление относится только к точно выбранной сессии."}</small>
      {state && <small>{state.pendingCount} сообщений ожидают · статус: {state.nativeStatus || "не сообщён"}</small>}
      {reason && <small role="status">{reason}</small>}
      {message && <small role={message.includes("неизвест") || message.includes("не подтвержд") ? "alert" : "status"}>{message}</small>}
      {intent && <small role="alert">{intent.status === "accepted" ? "Настройка очереди принята; начало обработки не подтверждено. Повтор заблокирован до изменения native revision." : "Исход команды не подтверждён. Идентификатор сохранён; повтор заблокирован."}</small>}
    </div>
    <div className="queue-processing-actions">
      <button type="button" className="quiet-button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? "Читаю…" : "Обновить очередь"}</button>
      {state?.autoDrain && <span className="queue-processing-enabled" role="status">Обработка включена</span>}
      {ready && <button type="button" className="quiet-button" disabled={loading || busy || unresolved} title="Изменяет только эту сессию и сохраняется для следующих сообщений." onClick={() => void run()}>{busy ? "Применяю…" : "Возобновить обработку очереди"}</button>}
      {state && !ready && !state.autoDrain && !unresolved && !loading && <small>{state.reason || (state.pendingCount === 0 ? "Очередь пуста." : !state.loaded ? "Нативная сессия не загружена; возобновление недоступно." : !state.canResume ? "Нативный контрол очереди недоступен." : "Состояние очереди пока не позволяет действие.")}</small>}
    </div>
  </section>;
}

export function isComposerSubmitShortcut(
  event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  platform?: string,
): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  const os =
    platform ??
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(os) ? event.metaKey : event.ctrlKey;
}

export async function acquireCurrentVoiceStream(
  request: () => Promise<MediaStream>,
  isCurrent: () => boolean,
): Promise<MediaStream | undefined> {
  const acquired = await request();
  if (isCurrent()) return acquired;
  acquired.getTracks().forEach((track) => track.stop());
  return undefined;
}

type ComposerSendControlProps = {
  disabled: boolean;
  busy?: boolean;
  onSend: (mode?: DeliveryMode) => void;
  icon?: ReactNode;
  label?: string;
  title?: string;
  allowModeChoice?: boolean;
  supportsSteer?: boolean;
  className?: string;
};

export function ComposerSendControl({
  disabled,
  busy = false,
  onSend,
  icon = "↑",
  label = "Отправить сообщение",
  title,
  allowModeChoice = true,
  supportsSteer = true,
  className = "",
}: ComposerSendControlProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const canChoose = allowModeChoice && !disabled && !busy;

  const clearTimer = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const startHold = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || !canChoose || open) return;
    clearTimer();
    held.current = false;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      held.current = true;
      setOpen(true);
    }, 550);
  };
  const choose = (mode: DeliveryMode) => {
    setOpen(false);
    held.current = false;
    onSend(mode);
  };
  const click = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    onSend();
  };

  useEffect(() => {
    if (open) firstChoice.current?.focus();
    else held.current = false;
  }, [open]);
  useEffect(() => () => clearTimer(), []);

  return (
    <>
      {open && (
        <div
          className="composer-send-mode-menu"
          role="dialog"
          aria-label="Выберите режим отправки"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <strong>Как отправить сообщение?</strong>
          <button ref={firstChoice} type="button" disabled={!supportsSteer} onClick={() => choose("steer")}>
            <span>Steer</span>
            <small>{supportsSteer ? "В текущий ход агента" : "Для этой среды недоступно"}</small>
          </button>
          <button type="button" onClick={() => choose("queue")}>
            <span>Queue</span>
            <small>После текущего ответа</small>
          </button>
          <button type="button" className="composer-send-mode-cancel" onClick={() => setOpen(false)}>
            Отмена
          </button>
        </div>
      )}
      <button
        className={`send-button ${className}`}
        title={title}
        type="button"
        onPointerDown={startHold}
        onPointerUp={clearTimer}
        onPointerLeave={clearTimer}
        onPointerCancel={clearTimer}
        onContextMenu={(event) => {
          if (held.current) event.preventDefault();
        }}
        onClick={click}
        aria-haspopup={canChoose ? "dialog" : undefined}
        aria-expanded={canChoose ? open : undefined}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        aria-label={busy ? "Отправляю сообщение" : label}
      >
        {icon}
      </button>
    </>
  );
}

type VoiceComposerControlProps = {
  sessionKey: string;
  disabled: boolean;
  onTranscript: (text: string, sessionKey: string) => void;
};

export function VoiceComposerControl({ sessionKey, disabled, onTranscript }: VoiceComposerControlProps) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const target = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const discard = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentSessionKey = useRef(sessionKey);
  const currentDisabled = useRef(disabled);
  const startingGeneration = useRef<number | undefined>(undefined);
  if (currentSessionKey.current !== sessionKey) {
    currentSessionKey.current = sessionKey;
    generation.current += 1;
  }
  if (currentDisabled.current !== disabled) {
    currentDisabled.current = disabled;
    if (disabled) generation.current += 1;
  }
  const isCurrentOperation = (token: number, key: string) =>
    mounted.current &&
    generation.current === token &&
    currentSessionKey.current === key &&
    !currentDisabled.current;

  const stopTracks = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  const transcribe = async (blob: Blob, key: string, token: number) => {
    if (!blob.size) {
      setError("Запись не содержит аудио.");
      return;
    }
    if (blob.size > 25 * 1024 * 1024) {
      setError("Запись больше 25 МБ. Сделайте более короткую запись.");
      return;
    }

    setTranscribing(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 300_000);
    try {
      const extension = blob.type.startsWith("audio/mp4")
        ? "m4a"
        : blob.type.startsWith("audio/wav")
          ? "wav"
          : "webm";
      const form = new FormData();
      form.append("audio", blob, `voice-input.${extension}`);
      const response = await fetch("/api/composer/transcription", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => undefined)) as
        | { text?: unknown; error?: unknown }
        | undefined;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `Не удалось распознать запись (${response.status}).`);
      }
      if (typeof body?.text !== "string" || !body.text.trim()) {
        throw new Error("Сервис распознавания вернул пустой текст.");
      }
      if (target.current !== key || !isCurrentOperation(token, key)) {
        throw new Error("Выбранная сессия изменилась во время распознавания. Текст не добавлен.");
      }
      onTranscript(body.text.trim(), key);
    } catch (cause) {
      if (target.current === key && isCurrentOperation(token, key)) {
        const failure = cause as Error;
        setError(
          failure.name === "AbortError"
            ? "Распознавание прервано или превысило лимит времени. Запишите и отправьте запрос вручную, если хотите повторить."
            : failure.message || "Не удалось распознать запись.",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (abort.current === controller) abort.current = null;
      setTranscribing(false);
    }
  };
  const cancel = () => {
    if (recording) {
      discard.current = true;
      setError("Запись отменена. Аудио не отправлено.");
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
    } else if (transcribing) {
      abort.current?.abort();
    }
  };
  const start = async () => {
    if (disabled || recording || transcribing || startingGeneration.current === generation.current) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Запись голоса не поддерживается этим браузером.");
      return;
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/wav"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) {
      setError("Браузер не предлагает поддерживаемый формат аудио.");
      return;
    }

    const key = sessionKey;
    const token = generation.current;
    startingGeneration.current = token;
    setStarting(true);
    let acquired: MediaStream | undefined;
    try {
      acquired = await acquireCurrentVoiceStream(
        () => navigator.mediaDevices.getUserMedia({ audio: true }),
        () => isCurrentOperation(token, key),
      );
    } catch (cause) {
      if (isCurrentOperation(token, key)) {
        const name = (cause as Error).name;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Браузер не разрешил доступ к микрофону."
            : name === "NotFoundError"
              ? "Микрофон не найден."
              : name === "NotReadableError"
                ? "Микрофон занят или недоступен."
                : "Не удалось открыть микрофон.",
        );
      }
      return;
    } finally {
      if (startingGeneration.current === token) {
        startingGeneration.current = undefined;
        if (isCurrentOperation(token, key)) setStarting(false);
      }
    }
    if (!acquired || !isCurrentOperation(token, key)) {
      acquired?.getTracks().forEach((track) => track.stop());
      return;
    }

    try {
      const activeRecorder = new MediaRecorder(acquired, { mimeType });
      stream.current = acquired;
      recorder.current = activeRecorder;
      target.current = key;
      discard.current = false;
      chunks.current = [];
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      activeRecorder.onerror = () => {
        discard.current = true;
        setError("Ошибка записи с микрофона. Запустите новую запись.");
        if (activeRecorder.state !== "inactive") activeRecorder.stop();
      };
      activeRecorder.onstop = () => {
        const parts = chunks.current;
        chunks.current = [];
        const key = target.current;
        recorder.current = null;
        stopTracks();
        setRecording(false);
        if (discard.current || !key || !isCurrentOperation(token, key)) {
          discard.current = false;
          return;
        }
        void transcribe(new Blob(parts, { type: activeRecorder.mimeType || mimeType }), key, token);
      };
      activeRecorder.start(250);
      setRecording(true);
      timer.current = window.setTimeout(() => {
        if (activeRecorder.state !== "inactive") activeRecorder.stop();
      }, 240_000);
    } catch (cause) {
      acquired.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      setError((cause as Error).message || "Не удалось начать запись.");
    }
  };

  useEffect(() => {
    if (startingGeneration.current !== undefined && startingGeneration.current !== generation.current) {
      startingGeneration.current = undefined;
      setStarting(false);
    }
    if (disabled) {
      discard.current = true;
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
      abort.current?.abort();
    }
    if (target.current && target.current !== sessionKey) {
      discard.current = true;
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
      abort.current?.abort();
      target.current = undefined;
    }
  }, [sessionKey, disabled]);
  useEffect(
    () => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        generation.current += 1;
        startingGeneration.current = undefined;
        discard.current = true;
        abort.current?.abort();
        stopTracks();
        if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      };
    },
    [],
  );

  return (
    <>
      <div className="composer-voice-actions">
        <button
          type="button"
          className={`composer-voice-button ${recording ? "recording" : ""}`}
          aria-label={recording ? "Остановить запись голоса" : starting ? "Открываю микрофон" : transcribing ? "Распознаю голос" : "Записать голосовой ввод"}
          title={recording ? "Остановить запись голоса" : starting ? "Открываю микрофон" : "Записать голосовой ввод (до 4 минут)"}
          disabled={disabled || starting || transcribing}
          onClick={() => (recording ? recorder.current?.stop() : void start())}
        >
          {starting ? (
            <span className="voice-loading" aria-hidden="true">…</span>
          ) : transcribing ? (
            <span className="voice-loading" aria-hidden="true">…</span>
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="2.5" width="6" height="10" rx="3" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7.5 18h5" />
            </svg>
          )}
        </button>
        {(recording || transcribing) && (
          <button
            type="button"
            className="composer-voice-cancel"
            aria-label={recording ? "Отменить запись голоса" : "Отменить распознавание"}
            title={recording ? "Отменить запись без отправки аудио" : "Отменить распознавание"}
            onClick={cancel}
          >
            ×
          </button>
        )}
      </div>
      {recording && (
        <span className="composer-voice-status" role="status" aria-live="polite">
          Записываю голос… остановите, чтобы получить текст
        </span>
      )}
      {transcribing && (
        <span className="composer-voice-status" role="status" aria-live="polite">
          Распознаю голос. Текст появится в поле и не будет отправлен.
        </span>
      )}
      {error && <span className="composer-voice-error" role="alert">{error}</span>}
    </>
  );
}
