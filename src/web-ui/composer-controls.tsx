import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { DeliveryMode } from "./composer-delivery.js";

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
