// Режимы доставки и очередь отправленных сообщений композера.
// Чистые помощники состояния: без React и fetch — App подключает их к UI.

export type DeliveryMode = "steer" | "queue";
export type OutboxStatus = "ready" | "sending" | "accepted" | "delivered" | "deferred" | "pending" | "unknown" | "failed";

export type OutboxEntry = {
  inputId: string;
  sessionKey: string;
  text: string;
  mode: DeliveryMode;
  createdAt: number;
  jobId?: string;
  status: OutboxStatus;
  error?: string;
  note?: string;
  nonRetryable?: boolean;
};

// Ответ POST /api/sessions/:harness/:id/message и GET .../message-status?inputId=:
// generic ok ещё не доказывает native-доставку.
export type MessageDeliveryResponse = {
  ok?: boolean;
  error?: string;
  inputId?: string;
  turnId?: string | number;
  admitted?: boolean;
  pending?: boolean;
  admissionUnknown?: boolean;
  nonRetryable?: boolean;
  delivery?: string;
  job?: { id?: string; state?: string; result?: unknown; error?: string };
};

export type OutboxStatusPatch = Pick<OutboxEntry, "status"> & Partial<Pick<OutboxEntry, "error" | "note" | "nonRetryable">>;

type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const DELIVERY_MODE_STORAGE_KEY = "agent-herder.delivery-mode";
export const DELIVERY_MODE_PINNED_STORAGE_KEY = "agent-herder.delivery-mode-pinned";
export const OUTBOX_STORAGE_KEY = "agent-herder.outbox";
const OUTBOX_MAX_ENTRIES = 50;
const OUTBOX_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set(["delivered", "failed"]);
// accepted — не подтверждённая terminal-доставка: такие строки тоже досматриваются до исхода
const UNFINISHED_STATUSES: ReadonlySet<OutboxStatus> = new Set(["ready", "sending", "accepted", "deferred", "pending", "unknown"]);
const STATUS_VALUES: ReadonlySet<string> = new Set(["ready", "sending", "accepted", "delivered", "deferred", "pending", "unknown", "failed"]);

export const isOutboxUnfinished = (entry: OutboxEntry): boolean => UNFINISHED_STATUSES.has(entry.status);

export const newInputId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

export const deliveryModeLabel = (mode: DeliveryMode): string => (mode === "steer" ? "В текущий ход" : "После ответа");

export const outboxStatusLabel = (status: OutboxStatus): string => {
  switch (status) {
    case "ready": return "Ожидает отправки";
    case "sending": return "Отправляется…";
    case "delivered": return "Доставлено";
    case "deferred": return "Ожидает окончания ответа";
    case "pending": return "Подтверждается доставка";
    case "unknown": return "Доставка не подтверждена";
    case "failed": return "Не удалось";
    case "accepted": return "Сервер принял";
  }
};

// Классификация ответа сервера. admissionUnknown проверяется раньше ошибок:
// неоднозначный приём нельзя считать обычной ошибкой и безопасно пересылать.
// Дальше: явная ошибка → подтверждённая доставка → отложенная → pending → generic ok → неизвестно.
export const classifyMessageDelivery = (payload: unknown, httpOk: boolean): OutboxStatusPatch => {
  const response = (payload && typeof payload === "object" ? payload : {}) as MessageDeliveryResponse;
  if (response.admissionUnknown === true) {
    return { status: "unknown", note: "Сервер не смог подтвердить доставку сообщения в агента. Исход неизвестен: не отправляйте это сообщение повторно без проверки." };
  }
  const error = typeof response.error === "string" && response.error.trim() ? response.error.trim() : undefined;
  if (error) return { status: "failed", error, nonRetryable: response.nonRetryable === true ? true : undefined };
  if (!httpOk) return { status: "failed", error: "Сервер отклонил сообщение", nonRetryable: response.nonRetryable === true ? true : undefined };
  if (response.admitted === true || response.turnId !== undefined) return { status: "delivered" };
  if (response.delivery === "deferred") {
    return { status: "deferred", note: "Сообщение в очереди и будет доставлено, когда агент закончит текущий ответ." };
  }
  if (response.pending === true) return { status: "pending" };
  if (response.ok === true) {
    return { status: "accepted", note: "Сервер принял сообщение; доставка агенту ещё не подтверждена — следим за статусом." };
  }
  return { status: "unknown", note: "Ответ сервера не содержит подтверждения доставки — исход неизвестен." };
};

// Сверка статуса доставки по GET message-status: admission-поля плюс исход фоновой доставки (job).
// Прямое подтверждение delivered не понижается исходом job; прерванная доставка — не вечное deferred.
export const reconcileMessageStatus = (payload: unknown, httpOk: boolean): OutboxStatusPatch => {
  const base = classifyMessageDelivery(payload, httpOk);
  const response = (payload && typeof payload === "object" ? payload : {}) as MessageDeliveryResponse;
  const job = response.job;
  if (!job || typeof job !== "object" || base.status === "delivered") return base;
  if (job.state === "failed") {
    return { status: "failed", error: typeof job.error === "string" && job.error.trim() ? job.error.trim() : "Фоновая доставка сообщения не удалась", nonRetryable: true };
  }
  if (job.state === "interrupted" || job.state === "cancelled") {
    return { status: "unknown", note: `Фоновая доставка прервана (${job.state}). Исход неизвестен — не повторяйте отправку этого сообщения без проверки.` };
  }
  return base;
};

// Ответа не было вовсе (сеть оборвалась): доставка неоднозначна, повтор не безопасен.
export const deliveryConnectionFailure = (error: unknown): OutboxStatusPatch => {
  const detail = error instanceof Error ? error.message : String(error);
  return { status: "unknown", note: `Не удалось связаться с сервером (${detail}). Неизвестно, дошло ли сообщение, — повторная отправка может задублировать задачу.` };
};

// Лимит применяется только к завершённым строкам: незавершённые (включая accepted/deferred/pending)
// сохраняются все — молчаливая потеря недоставленного сообщения запрещена.
const capOutbox = (entries: OutboxEntry[]): OutboxEntry[] => {
  let kept = entries.filter(entry => TERMINAL_STATUSES.has(entry.status)).length;
  if (kept <= OUTBOX_MAX_ENTRIES) return entries;
  const drop = new Set<number>();
  for (let index = 0; index < entries.length && kept > OUTBOX_MAX_ENTRIES; index++) {
    if (TERMINAL_STATUSES.has(entries[index].status)) {
      drop.add(index);
      kept -= 1;
    }
  }
  return drop.size === 0 ? entries : entries.filter((_, index) => !drop.has(index));
};

export const pruneOutbox = (entries: OutboxEntry[], now: number): OutboxEntry[] =>
  capOutbox(entries.filter((entry) => !(TERMINAL_STATUSES.has(entry.status) && now - entry.createdAt > OUTBOX_TERMINAL_TTL_MS)));

// Добавление по inputId; повтор запроса того же inputId обновляет существующую строку на месте и не создаёт вторую.
export const appendOutboxEntry = (entries: OutboxEntry[], entry: OutboxEntry): OutboxEntry[] => {
  const index = entries.findIndex((item) => item.inputId === entry.inputId);
  if (index === -1) return capOutbox([...entries, entry]);
  const next = entries.slice();
  next[index] = { ...entry, createdAt: entries[index].createdAt };
  return next;
};

export const updateOutboxEntry = (entries: OutboxEntry[], inputId: string, patch: OutboxStatusPatch): OutboxEntry[] => {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.inputId !== inputId) return entry;
    changed = true;
    // при смене статуса старые note/error не переносятся, если патч не задал новые
    const statusChanged = patch.status !== entry.status;
    return { ...entry, ...patch, error: patch.error ?? (statusChanged ? undefined : entry.error), note: patch.note ?? (statusChanged ? undefined : entry.note) };
  });
  return changed ? next : entries;
};

export const removeOutboxEntry = (entries: OutboxEntry[], inputId: string): OutboxEntry[] => entries.filter((entry) => entry.inputId !== inputId);

const reviveOutboxEntry = (raw: unknown): OutboxEntry | null => {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Partial<OutboxEntry>;
  if (typeof entry.inputId !== "string" || !entry.inputId) return null;
  if (typeof entry.sessionKey !== "string" || typeof entry.text !== "string") return null;
  if (entry.mode !== "steer" && entry.mode !== "queue") return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  if (typeof entry.status !== "string" || !STATUS_VALUES.has(entry.status)) return null;
  const base = { inputId: entry.inputId, sessionKey: entry.sessionKey, text: entry.text, mode: entry.mode, createdAt: entry.createdAt, jobId: typeof entry.jobId === "string" && entry.jobId ? entry.jobId : undefined };
  if (entry.status === "sending") {
    // Отправка прервалась перезагрузкой: состояние уточняется у сервера (GET message-status),
    // повторный POST автоматически не отправляется.
    return { ...base, status: "pending", note: "Страница перезагрузилась во время отправки — уточняю состояние доставки у сервера." };
  }
  return {
    ...base,
    status: entry.status,
    error: typeof entry.error === "string" ? entry.error : undefined,
    note: typeof entry.note === "string" ? entry.note : undefined,
    nonRetryable: entry.nonRetryable === true ? true : undefined,
  };
};

export const readStoredOutbox = (storage: WebStorage): OutboxEntry[] => {
  try {
    const raw = storage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneOutbox(parsed.map(reviveOutboxEntry).filter((entry): entry is OutboxEntry => entry !== null), Date.now());
  } catch {
    return [];
  }
};

export const writeStoredOutbox = (storage: WebStorage, entries: OutboxEntry[]): boolean => {
  try {
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(pruneOutbox(entries, Date.now())));
    return true;
  } catch {
    return false;
  }
};

/** Persist the attempt boundary before any POST can reach the server. */
export const beginOutboxAttempt = (storage: WebStorage, entries: OutboxEntry[], inputId: string): OutboxEntry[] | null => {
  if (!entries.some(entry => entry.inputId === inputId && entry.status === "ready")) return null;
  const next = updateOutboxEntry(entries, inputId, { status: "sending", nonRetryable: undefined });
  return writeStoredOutbox(storage, next) ? next : null;
};

export const readDefaultDeliveryMode = (storage: WebStorage): DeliveryMode => {
  try {
    return storage.getItem(DELIVERY_MODE_STORAGE_KEY) === "steer" ? "steer" : "queue";
  } catch {
    return "queue";
  }
};

export const writeDefaultDeliveryMode = (storage: WebStorage, mode: DeliveryMode): void => {
  try {
    storage.setItem(DELIVERY_MODE_STORAGE_KEY, mode);
  } catch {
    // несохранённое предпочтение не блокирует отправку
  }
};

export const readDeliveryModePinned = (storage: WebStorage): boolean => {
  try {
    return storage.getItem(DELIVERY_MODE_PINNED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeDeliveryModePinned = (storage: WebStorage, pinned: boolean): void => {
  try {
    if (pinned) storage.setItem(DELIVERY_MODE_PINNED_STORAGE_KEY, "1");
    else storage.removeItem(DELIVERY_MODE_PINNED_STORAGE_KEY);
  } catch {
    // несохранённое предпочтение не блокирует отправку
  }
};

/** Preserve submission order while the composer keeps accepting new drafts. */
export class MessageAdmissionDispatcher {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly operations = new Set<{ sessionKey: string; inputId?: string; started: boolean; cancelled: boolean; onCancelled?: () => void }>();

  hasPending(inputId: string): boolean {
    return [...this.operations].some(operation => operation.inputId === inputId && !operation.cancelled);
  }

  /** Отмена одного ещё не начатого сообщения: соседние сообщения той же сессии не трогаются. */
  cancelInput(sessionKey: string, inputId: string): boolean {
    let cancelled = false;
    for (const operation of this.operations) {
      if (operation.sessionKey !== sessionKey || operation.inputId !== inputId || operation.started || operation.cancelled) continue;
      operation.cancelled = true;
      cancelled = true;
    }
    return cancelled;
  }

  cancelPending(sessionKey: string): void {
    for (const operation of this.operations) {
      if (operation.sessionKey !== sessionKey || operation.started || operation.cancelled) continue;
      operation.cancelled = true;
      operation.onCancelled?.();
    }
  }

  run<T>(sessionKey: string, submit: () => Promise<T>, options: { inputId?: string; onCancelled?: () => void } = {}): Promise<T | undefined> {
    const previous = this.tails.get(sessionKey) ?? Promise.resolve();
    const pending = { sessionKey, ...options, started: false, cancelled: false };
    this.operations.add(pending);
    const operation = previous.catch(() => undefined).then(() => {
      if (pending.cancelled) return undefined;
      pending.started = true;
      return submit();
    });
    const tail = operation.finally(() => {
      this.operations.delete(pending);
      if (this.tails.get(sessionKey) === tail) this.tails.delete(sessionKey);
    });
    this.tails.set(sessionKey, tail);
    return tail;
  }
}

// ---- Управление отложенным сообщением: отмена доставки, steer вместо очереди ----
// jobId хранится в строке очереди, поэтому отмена и «отправить сейчас» переживают
// перезагрузку страницы и не требуют повторного POST сообщения.

/** Статусы, в которых сообщение ещё не передано агенту: его можно отменить. */
const DELETEABLE_STATUSES: ReadonlySet<OutboxStatus> = new Set(["ready", "deferred", "pending", "failed"]);

export const canDeleteOutboxEntry = (entry: OutboxEntry): boolean => DELETEABLE_STATUSES.has(entry.status);

/** Steer умеет только codex: остальные адаптеры не принимают вставку в текущий ход. */
export const canSteerOutboxEntry = (entry: OutboxEntry, harness: string): boolean =>
  entry.mode === "queue" && canDeleteOutboxEntry(entry) && harness === "codex";

export const withOutboxJobId = (entries: OutboxEntry[], inputId: string, jobId: string | undefined): OutboxEntry[] => {
  if (!jobId) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.inputId !== inputId || entry.jobId === jobId) return entry;
    changed = true;
    return { ...entry, jobId };
  });
  return changed ? next : entries;
};

/** job.id из ответа /message и /message-status: нужен для отмены отложенной доставки. */
export const readOutboxJobId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const job = (payload as { job?: { id?: unknown } }).job;
  return job && typeof job.id === "string" && job.id ? job.id : undefined;
};

const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const isTerminalJobState = (state: unknown): boolean => typeof state === "string" && TERMINAL_JOB_STATES.has(state);

/** Отмена сошла успешно только если задача доставки реально остановлена и не доставила сообщение. */
export type CancelOutcome = "cancelled" | "delivered" | "failed";
export const cancelOutcomeOfJobState = (state: unknown): CancelOutcome =>
  state === "cancelled" ? "cancelled" : state === "completed" ? "delivered" : "failed";
