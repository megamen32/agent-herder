import { describe, expect, it } from "vitest";
import {
  MessageAdmissionDispatcher,
  appendOutboxEntry,
  beginOutboxAttempt,
  classifyMessageDelivery,
  deliveryConnectionFailure,
  deliveryModeLabel,
  isOutboxUnfinished,
  newInputId,
  outboxStatusLabel,
  readDefaultDeliveryMode,
  readDeliveryModePinned,
  readStoredOutbox,
  reconcileMessageStatus,
  removeOutboxEntry,
  updateOutboxEntry,
  writeDefaultDeliveryMode,
  writeDeliveryModePinned,
  writeStoredOutbox,
  DELIVERY_MODE_PINNED_STORAGE_KEY,
  DELIVERY_MODE_STORAGE_KEY,
  OUTBOX_STORAGE_KEY,
  type OutboxEntry,
} from "../src/web-ui/composer-delivery.js";


class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  inputId: "id-1", sessionKey: "codex:s1", text: "задача", mode: "queue", createdAt: Date.now(), status: "sending", ...overrides,
});

describe("composer delivery modes and status labels", () => {
  it("labels both delivery modes in plain Russian", () => {
    expect(deliveryModeLabel("steer")).toBe("В текущий ход");
    expect(deliveryModeLabel("queue")).toBe("После ответа");
  });

  it("labels every outbox status without inventing native delivery", () => {
    expect(outboxStatusLabel("sending")).toBe("Отправляется…");
    expect(outboxStatusLabel("accepted")).toBe("Сервер принял");
    expect(outboxStatusLabel("delivered")).toBe("Доставлено");
    expect(outboxStatusLabel("deferred")).toBe("Ожидает окончания ответа");
    expect(outboxStatusLabel("pending")).toBe("Подтверждается доставка");
    expect(outboxStatusLabel("unknown")).toBe("Доставка не подтверждена");
    expect(outboxStatusLabel("failed")).toBe("Не удалось");
  });

  it("gives every submitted message a distinct stable inputId", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInputId()));
    expect(ids.size).toBe(50);
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      expect(newInputId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe("composer delivery response classification", () => {
  it("treats a generic ok as server acceptance, not native delivery", () => {
    const patch = classifyMessageDelivery({ ok: true }, true);
    expect(patch.status).toBe("accepted");
  });

  it("marks confirmed admission or a turn id as delivered", () => {
    expect(classifyMessageDelivery({ ok: true, admitted: true }, true).status).toBe("delivered");
    expect(classifyMessageDelivery({ ok: true, turnId: "turn-9" }, true).status).toBe("delivered");
  });

  it("distinguishes deferred queue delivery and pending confirmation", () => {
    expect(classifyMessageDelivery({ ok: true, delivery: "deferred" }, true).status).toBe("deferred");
    expect(classifyMessageDelivery({ ok: true, pending: true }, true).status).toBe("pending");
  });

  it("keeps admission unknown explicit instead of guessing", () => {
    const patch = classifyMessageDelivery({ ok: true, admissionUnknown: true }, true);
    expect(patch.status).toBe("unknown");
    expect(patch.note).toContain("не отправляйте это сообщение повторно без проверки");
  });

  it("checks admissionUnknown before treating an ambiguous rejection as a plain failure", () => {
    // ok:false + admissionUnknown — неоднозначный приём native-ошибкой не становится безопасным повтором
    expect(classifyMessageDelivery({ ok: false, admissionUnknown: true, error: "native turn error" }, false).status).toBe("unknown");
  });

  it("reconciles background delivery job outcomes instead of waiting forever", () => {
    expect(reconcileMessageStatus({ ok: true, delivery: "deferred", job: { id: "j1", state: "failed", error: "boom" } }, true)).toMatchObject({ status: "failed", error: "boom", nonRetryable: true });
    expect(reconcileMessageStatus({ ok: true, delivery: "deferred", job: { id: "j1", state: "failed" } }, true).error).toBe("Фоновая доставка сообщения не удалась");
    const interrupted = reconcileMessageStatus({ ok: true, delivery: "deferred", job: { id: "j1", state: "interrupted" } }, true);
    expect(interrupted.status).toBe("unknown");
    expect(interrupted.note).toContain("не повторяйте отправку");
    expect(reconcileMessageStatus({ ok: true, delivery: "deferred", job: { id: "j1", state: "interrupted" } }, true).note).toContain("interrupted");
    expect(reconcileMessageStatus({ ok: true, delivery: "deferred", job: { id: "j1", state: "queued" } }, true).status).toBe("deferred");
    // прямое подтверждение доставки не понижается исходом фоновой доставки
    expect(reconcileMessageStatus({ ok: true, admitted: true, job: { id: "j1", state: "failed" } }, true).status).toBe("delivered");
  });

  it("marks server rejections as failures and can make them non-retryable", () => {
    const rejected = classifyMessageDelivery({ error: "mode must be queue or sync" }, false);
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toBe("mode must be queue or sync");
    expect(rejected.nonRetryable).toBeUndefined();
    expect(classifyMessageDelivery({ ok: false, error: "сессия занята", nonRetryable: true }, true).nonRetryable).toBe(true);
    expect(classifyMessageDelivery(undefined, false).error).toBe("Сервер отклонил сообщение");
  });

  it("treats answers without any confirmation as unknown", () => {
    expect(classifyMessageDelivery({}, true).status).toBe("unknown");
    expect(classifyMessageDelivery(null, true).status).toBe("unknown");
  });

  it("never calls a broken connection a safe retry", () => {
    const patch = deliveryConnectionFailure(new TypeError("Failed to fetch"));
    expect(patch.status).toBe("unknown");
    expect(patch.note).toContain("повторная отправка может задублировать задачу");
  });
});

describe("composer outbox entries", () => {
  it("keeps messages in send order and never duplicates an inputId", () => {
    const first = entry({ inputId: "a", text: "первая" });
    const second = entry({ inputId: "b", text: "вторая" });
    let list = appendOutboxEntry([], first);
    list = appendOutboxEntry(list, second);
    expect(list.map((item) => item.text)).toEqual(["первая", "вторая"]);
    const retried = appendOutboxEntry(list, { ...first, status: "sending" });
    expect(retried).toHaveLength(2);
    expect(retried[0]).toMatchObject({ inputId: "a", status: "sending" });
    expect(retried[1].inputId).toBe("b");
  });

  it("patches only the matching entry and keeps the rest untouched", () => {
    const list = [entry({ inputId: "a" }), entry({ inputId: "b", status: "deferred" })];
    const next = updateOutboxEntry(list, "a", classifyMessageDelivery({ ok: true, admitted: true }, true));
    expect(next[0].status).toBe("delivered");
    expect(next[1]).toBe(list[1]);
    expect(updateOutboxEntry(list, "missing", { status: "failed" })).toBe(list);
  });

  it("clears stale notes and errors when the status changes", () => {
    const list = [entry({ inputId: "a", status: "deferred", note: "старая заметка", error: "старая ошибка" })];
    expect(updateOutboxEntry(list, "a", { status: "delivered" }).note).toBeUndefined();
    const kept = updateOutboxEntry(list, "a", { status: "deferred" });
    expect(kept[0].note).toBe("старая заметка");
  });

  it("removes dismissed entries by inputId", () => {
    const list = [entry({ inputId: "a" }), entry({ inputId: "b" })];
    expect(removeOutboxEntry(list, "a").map((item) => item.inputId)).toEqual(["b"]);
  });
});

describe("composer outbox persistence", () => {
  it("keeps a new failure visible when there are more than fifty unfinished tasks", () => {
    const storage = new MemoryStorage();
    const pending = Array.from({ length: 64 }, (_, index) => entry({ inputId: `pending-${index}`, status: "pending" }));
    writeStoredOutbox(storage, [...pending, entry({ inputId: "new-failure", status: "failed" })]);
    expect(readStoredOutbox(storage)).toHaveLength(65);
    expect(readStoredOutbox(storage).at(-1)?.inputId).toBe("new-failure");
  });

  it("reports storage failure so the composer can stop before submitting untracked text", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    expect(writeStoredOutbox(storage, [entry()])).toBe(false);
  });
  it("round-trips entries through storage", () => {
    const storage = new MemoryStorage();
    const list = [entry({ inputId: "a", status: "delivered" }), entry({ inputId: "b", status: "deferred" })];
    writeStoredOutbox(storage, list);
    expect(readStoredOutbox(storage).map((item) => [item.inputId, item.status])).toEqual([["a", "delivered"], ["b", "deferred"]]);
  });

  it("revives entries interrupted by reload as pending reconciliation, never as a silent resend", () => {
    const storage = new MemoryStorage();
    writeStoredOutbox(storage, [entry({ inputId: "a", status: "sending", text: "незавершённая" })]);
    const restored = readStoredOutbox(storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ inputId: "a", status: "pending", text: "незавершённая" });
    expect(restored[0].note).toContain("уточняю состояние доставки у сервера");
  });

  it("drops malformed rows instead of failing the whole queue", () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify([{ inputId: 5 }, "junk", entry({ inputId: "ok", status: "failed", error: "сеть" })]));
    const restored = readStoredOutbox(storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ inputId: "ok", status: "failed", error: "сеть" });
    storage.setItem(OUTBOX_STORAGE_KEY, "not-json");
    expect(readStoredOutbox(storage)).toEqual([]);
  });

  it("caps the queue at 50 newest entries and prunes terminal rows older than a day", () => {
    const storage = new MemoryStorage();
    const many = Array.from({ length: 60 }, (_, index) => entry({ inputId: `id-${index}`, status: "delivered" }));
    writeStoredOutbox(storage, many);
    const restored = readStoredOutbox(storage);
    expect(restored).toHaveLength(50);
    expect(restored[0].inputId).toBe("id-10");
    const stale = entry({ inputId: "stale", createdAt: Date.now() - 25 * 60 * 60 * 1000, status: "delivered" });
    const fresh = entry({ inputId: "fresh", createdAt: Date.now() - 25 * 60 * 60 * 1000, status: "pending" });
    writeStoredOutbox(storage, [stale, fresh]);
    expect(readStoredOutbox(storage).map((item) => item.inputId)).toEqual(["fresh"]);
  });

  it("never drops unfinished entries when applying the terminal cap", () => {
    const storage = new MemoryStorage();
    const unfinished = Array.from({ length: 60 }, (_, index) => entry({ inputId: `p-${index}`, status: "pending" }));
    writeStoredOutbox(storage, unfinished);
    expect(readStoredOutbox(storage)).toHaveLength(60);
    expect(unfinished.every((item) => isOutboxUnfinished(item))).toBe(true);
    expect(isOutboxUnfinished(entry({ status: "delivered" }))).toBe(false);
    expect(isOutboxUnfinished(entry({ status: "failed" }))).toBe(false);
  });

  it("keeps accepted entries out of terminal pruning until their outcome is known", () => {
    const storage = new MemoryStorage();
    writeStoredOutbox(storage, [entry({ inputId: "acc", createdAt: Date.now() - 25 * 60 * 60 * 1000, status: "accepted" })]);
    expect(readStoredOutbox(storage)).toHaveLength(1);
  });

  it("stores the person's default delivery mode and its pinned flag in localStorage keys", () => {
    const storage = new MemoryStorage();
    expect(readDefaultDeliveryMode(storage)).toBe("queue");
    writeDefaultDeliveryMode(storage, "steer");
    expect(storage.getItem(DELIVERY_MODE_STORAGE_KEY)).toBe("steer");
    expect(readDefaultDeliveryMode(storage)).toBe("steer");
    expect(readDeliveryModePinned(storage)).toBe(false);
    writeDeliveryModePinned(storage, true);
    expect(storage.getItem(DELIVERY_MODE_PINNED_STORAGE_KEY)).toBe("1");
    expect(readDeliveryModePinned(storage)).toBe(true);
    writeDeliveryModePinned(storage, false);
    expect(storage.getItem(DELIVERY_MODE_PINNED_STORAGE_KEY)).toBeNull();
  });
});

describe("composer admission order", () => {
  it("preserves an unattempted queued message across reload while the first POST is delayed", async () => {
    const storage = new MemoryStorage();
    const dispatcher = new MessageAdmissionDispatcher();
    let entries = [entry({ inputId: "first", status: "ready" }), entry({ inputId: "second", status: "ready" })];
    writeStoredOutbox(storage, entries);
    let finish!: () => void;
    const first = dispatcher.run("session", async () => {
      entries = beginOutboxAttempt(storage, entries, "first")!;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const second = dispatcher.run("session", async () => { entries = beginOutboxAttempt(storage, entries, "second")!; });
    await new Promise(resolve => setTimeout(resolve, 0));
    const restored = readStoredOutbox(storage);
    expect(restored.map(item => [item.inputId, item.status])).toEqual([["first", "pending"], ["second", "ready"]]);
    expect(beginOutboxAttempt(storage, restored, "second")?.find(item => item.inputId === "second")?.status).toBe("sending");
    finish(); await Promise.all([first, second]);
  });

  it("cancels only unattempted submissions on stop without later POST or cancelling another chat", async () => {
    const dispatcher = new MessageAdmissionDispatcher();
    const called: string[] = [];
    let finish!: () => void;
    const first = dispatcher.run("session", async () => { called.push("first"); await new Promise<void>(resolve => { finish = resolve; }); }, { inputId: "first" });
    let cancelled = 0;
    const second = dispatcher.run("session", async () => { called.push("second"); }, { inputId: "second", onCancelled: () => { cancelled++; } });
    await dispatcher.run("other", async () => { called.push("other"); });
    dispatcher.cancelPending("session");
    expect(cancelled).toBe(1);
    expect(dispatcher.hasPending("second")).toBe(false);
    expect(dispatcher.hasPending("first")).toBe(true);
    finish(); await Promise.all([first, second]);
    expect(called).toEqual(["first", "other"]);
    await dispatcher.run("session", async () => { called.push("explicit new intent"); }, { inputId: "second" });
    expect(called).toContain("explicit new intent");
  });

  it("does not cross the persisted attempt boundary when storage is full", () => {
    const storage = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error("quota"); } };
    const entries = [entry({ inputId: "unsent", status: "ready" })];
    expect(beginOutboxAttempt(storage, entries, "unsent")).toBeNull();
    expect(entries[0].status).toBe("ready");
  });

  it("keeps later submissions behind the first admission but leaves another session independent", async () => {
    const dispatcher = new MessageAdmissionDispatcher();
    const called: string[] = [];
    let admit!: () => void;
    const first = dispatcher.run("one", () => { called.push("first"); return new Promise<void>(resolve => { admit = resolve; }); });
    const second = dispatcher.run("one", async () => { called.push("second"); });
    await dispatcher.run("other", async () => { called.push("independent"); });
    expect(called).toEqual(["first", "independent"]);
    admit(); await Promise.all([first, second]);
    expect(called).toEqual(["first", "independent", "second"]);
  });
});
