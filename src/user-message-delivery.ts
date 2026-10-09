import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HerderJobRegistry, type HerderJob } from "./herder-jobs.js";
import type { SessionSupervisor } from "./session-supervisor.js";
import type { HarnessAdapter, SendMessageResult } from "./types/index.js";

export type UserMessageInput = { harness: string; sessionId: string; inputId: string; message: string; mode: "queue" | "steer" };
export type UserMessageReceipt = SendMessageResult & { delivery?: "deferred"; job?: HerderJob<SendMessageResult> };

/** Process-owned human queue. Coordination continues through its native steer path. */
export class UserMessageDelivery {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<AbortController, { harness: string; sessionId: string }>();
  private active = 0;
  private slots = 4;
  private readonly slotWaiters: Array<() => void> = [];

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly supervisor: Pick<SessionSupervisor, "sendMessage">,
    private readonly jobs: HerderJobRegistry,
    private readonly options = { pollMs: 2_000, maxWaitMs: 24 * 60 * 60 * 1_000, maxPending: 64 },
  ) {}

  submit(input: UserMessageInput): UserMessageReceipt {
    if (Buffer.byteLength(input.message, "utf8") > 256 * 1024) throw new Error("Сообщение слишком большое для очереди отправки");
    if (input.mode === "steer" && input.harness !== "codex") {
      throw new Error("Вставка в текущий ход для этого агента пока не поддерживается. Выберите «После ответа».");
    }
    if (!this.adapters.has(input.harness)) throw new Error("Агент недоступен");
    const key = `${input.harness}\0${input.sessionId}\0${input.inputId}`;
    const fingerprint = createHash("sha256").update(`${input.mode}\0${input.message}`).digest("hex");
    const humanRequestedAt = Date.now();
    const jobId = `job_${createHash("sha256").update(`user-message\0${key}`).digest("hex")}`;
    const existing = this.jobs.get<SendMessageResult>(jobId);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw new Error("Идентификатор сообщения уже использован для другого текста или режима");
      return this.receipt(existing, input.inputId);
    }
    if (this.active >= this.options.maxPending) throw new Error("Очередь отправки заполнена. Дождитесь доставки текущих сообщений.");
    const lane = `${input.harness}\0${input.sessionId}`;
    const previous = input.mode === "queue" ? this.tails.get(lane) : undefined;
    const controller = new AbortController();
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { release = resolve; });
    const tail = (previous ?? Promise.resolve()).then(() => admitted);
    // Reserve the lane before the job runner begins; native callers never block on it.
    if (input.mode === "queue") this.tails.set(lane, tail);
    this.active++;
    this.controllers.set(controller, { harness: input.harness, sessionId: input.sessionId });
    const finish = () => {
      release();
      controller.abort();
      this.active--;
      this.controllers.delete(controller);
      if (this.tails.get(lane) === tail) this.tails.delete(lane);
    };
    let job: HerderJob<SendMessageResult>;
    try {
      job = this.jobs.start({
        kind: "Доставка сообщения", ownerSessionId: input.sessionId,
        idempotencyKey: `user-message\0${key}`, requestFingerprint: fingerprint,
        run: async ({ signal, waiting, progress }) => {
          const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(this.options.maxWaitMs)]);
          let attempted = false;
          try {
            waiting(input.mode === "queue" ? "Ожидает окончания ответа" : "Вставляется в текущий ход");
            if (previous) await Promise.race([previous, delay(this.options.maxWaitMs, undefined, { signal: combined })]);
            const adapter = this.adapters.get(input.harness)!;
            while (true) {
              combined.throwIfAborted();
              const session = await this.withSlot(combined, () => adapter.getSession(input.sessionId));
              if (!session) return { ok: false, nonRetryable: true, inputId: input.inputId, error: "Сессия недоступна" };
              if (input.mode === "queue" && (session.status === "running" || session.status === "needs_input")) {
                await delay(this.options.pollMs, undefined, { signal: combined });
                continue;
              }
              progress(0.5, "Отправляется агенту");
              attempted = true;
              const result = await this.withSlot(combined, () => this.supervisor.sendMessage(input.harness, input.sessionId, {
                message: input.message, origin: "human", inputId: input.inputId,
                humanRequestedAt,
                steer: input.mode === "steer", queue: input.harness === "codex",
              }));
              // A writer rejected admission before input submission. Recheck the
              // native turn; uncertain/accepted input is never replayed.
              if (input.mode === "queue" && !result.ok && !result.nonRetryable && !result.admitted && !result.admissionUnknown
                && /already has an active writer|prompt is already running/i.test(result.error ?? "")) {
                waiting("Ожидает окончания ответа");
                attempted = false;
                await delay(this.options.pollMs, undefined, { signal: combined });
                continue;
              }
              if (result.ok && !result.admitted && !result.turnId && adapter.getMessageAdmission) {
                const native = await this.withSlot(combined, () => adapter.getMessageAdmission!(input.sessionId, input.inputId, session.cwd));
                if (native.state === "admitted") return { ...result, inputId: input.inputId, admitted: true };
                if (native.state === "failed") return { ok: false, admitted: true, nonRetryable: true, inputId: input.inputId, error: native.error };
                return { ...result, inputId: input.inputId, pending: true };
              }
              return { ...result, inputId: input.inputId };
            }
          } catch (error) {
            return { ok: false, inputId: input.inputId, nonRetryable: true, ...(attempted ? { admissionUnknown: true } : {}),
              error: error instanceof Error && error.name === "TimeoutError" ? "Время ожидания доставки истекло" : error instanceof Error ? error.message : String(error) };
          } finally { finish(); }
        },
      });
    } catch (error) {
      if (input.mode === "queue" && this.tails.get(lane) === tail && previous) this.tails.set(lane, previous);
      finish();
      throw error;
    }
    return this.receipt(job, input.inputId);
  }

  private receipt(job: HerderJob<SendMessageResult>, inputId: string): UserMessageReceipt {
    if (["failed", "cancelled", "interrupted"].includes(job.state)) {
      return { ok: false, inputId, nonRetryable: true, admissionUnknown: true,
        error: job.error || "Доставка прервана; проверьте состояние сообщения перед повторной отправкой", job };
    }
    return job.state === "completed" && job.result
      ? { ...job.result, inputId, job }
      : { ok: true, inputId, pending: true, delivery: "deferred", job };
  }

  get(harness: string, sessionId: string, inputId: string): UserMessageReceipt | null {
    const key = `user-message\0${harness}\0${sessionId}\0${inputId}`;
    const job = this.jobs.get<SendMessageResult>(`job_${createHash("sha256").update(key).digest("hex")}`);
    return job ? this.receipt(job, inputId) : null;
  }

  async reconcile(harness: string, sessionId: string, inputId: string): Promise<UserMessageReceipt | null> {
    const receipt = this.get(harness, sessionId, inputId);
    const job = receipt?.job;
    if (!job || job.state !== "completed" || !job.result?.pending || job.result.admissionUnknown) return receipt;
    const adapter = this.adapters.get(harness);
    if (adapter?.getMessageAdmission) {
      const native = await this.withSlot(AbortSignal.timeout(30_000), () => adapter.getMessageAdmission!(sessionId, inputId));
      if (native.state === "admitted" || native.state === "failed") {
        this.jobs.updateCompletedResult(job.id, { ...job.result, pending: false, admitted: true,
          ...(native.state === "failed" ? { ok: false, nonRetryable: true, error: native.error } : {}) });
        return this.get(harness, sessionId, inputId);
      }
    }
    if (Date.now() - Date.parse(job.createdAt) >= this.options.maxWaitMs) {
      this.jobs.updateCompletedResult(job.id, { ok: false, inputId, pending: false, admissionUnknown: true, nonRetryable: true,
        error: "Не удалось подтвердить доставку сообщения; проверьте чат перед повторной отправкой" });
      return this.get(harness, sessionId, inputId);
    }
    return receipt;
  }

  private async withSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.slots > 0) this.slots--;
    else await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener("abort", cancel); resolve(); };
      const cancel = () => {
        const index = this.slotWaiters.indexOf(grant);
        if (index !== -1) this.slotWaiters.splice(index, 1);
        reject(signal.reason);
      };
      this.slotWaiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
    const release = () => {
      const next = this.slotWaiters.shift();
      if (next) next(); else this.slots++;
    };
    try { signal.throwIfAborted(); }
    catch (error) { release(); throw error; }
    // A deadline abandons observation, never the native operation. Retain its
    // slot until it settles so unavailable transports cannot spawn more reads
    // or duplicate a possibly admitted prompt after the caller times out.
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const pending = Promise.resolve().then(operation).finally(release);
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(bounded.reason);
      bounded.addEventListener("abort", cancel, { once: true });
      pending.then(resolve, reject).finally(() => bounded.removeEventListener("abort", cancel));
    });
  }

  close(): void {
    for (const controller of this.controllers.keys()) controller.abort(new Error("Отправка прервана остановкой сервера; состояние сообщения нужно проверить"));
  }

  cancelSession(harness: string, sessionId: string): void {
    for (const [controller, target] of this.controllers) {
      if (target.harness === harness && target.sessionId === sessionId) controller.abort(new Error("Вы остановили чат; ожидавшее сообщение не будет отправлено автоматически"));
    }
  }
}
