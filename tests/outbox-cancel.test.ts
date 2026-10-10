import { describe, expect, it } from "vitest";
import {
  cancelOutcomeOfJobState, canDeleteOutboxEntry, canSteerOutboxEntry, isTerminalJobState,
  readOutboxJobId, readStoredOutbox, withOutboxJobId, type OutboxEntry, type OutboxStatus,
} from "../src/web-ui/composer-delivery.js";

const entry = (status: OutboxStatus, mode: OutboxEntry["mode"] = "queue"): OutboxEntry => ({
  inputId: "in-1", sessionKey: "codex:s1", text: "текст", mode, createdAt: 1, status,
});

describe("canDeleteOutboxEntry", () => {
  it("разрешает удалить то, что ещё не доставлено агенту", () => {
    for (const status of ["ready", "deferred", "pending", "failed"] as OutboxStatus[]) {
      expect(canDeleteOutboxEntry(entry(status))).toBe(true);
    }
  });

  it("запрещает удалить сообщение с неясным или уже произошедшим исходом", () => {
    for (const status of ["sending", "accepted", "delivered", "unknown"] as OutboxStatus[]) {
      expect(canDeleteOutboxEntry(entry(status))).toBe(false);
    }
  });
});

describe("canSteerOutboxEntry", () => {
  it("разрешает steer только для отложенного сообщения в очереди у codex", () => {
    expect(canSteerOutboxEntry(entry("deferred"), "codex")).toBe(true);
    expect(canSteerOutboxEntry(entry("ready"), "codex")).toBe(true);
    expect(canSteerOutboxEntry(entry("pending"), "codex")).toBe(true);
  });

  it("отказывает агентам без поддержки вставки в текущий ход", () => {
    for (const harness of ["opencode", "zcode", "claude", "hermes", "fast-agent", "qoder"]) {
      expect(canSteerOutboxEntry(entry("deferred"), harness)).toBe(false);
    }
  });

  it("отказывает, когда исход уже нельзя переиграть", () => {
    for (const status of ["sending", "accepted", "delivered", "unknown"] as OutboxStatus[]) {
      expect(canSteerOutboxEntry(entry(status), "codex")).toBe(false);
    }
  });

  it("отказывает сообщению, которое уже отправлено steer-режимом", () => {
    expect(canSteerOutboxEntry(entry("deferred", "steer"), "codex")).toBe(false);
  });
});

describe("withOutboxJobId", () => {
  it("записывает jobId только своей строке", () => {
    const next = withOutboxJobId([entry("deferred"), { ...entry("deferred"), inputId: "in-2" }], "in-1", "job_x");
    expect(next[0].jobId).toBe("job_x");
    expect(next[1].jobId).toBeUndefined();
  });

  it("идемпотентен и не трогает список при пустом jobId", () => {
    const list = [entry("deferred")];
    expect(withOutboxJobId(list, "in-1", undefined)).toBe(list);
    const once = withOutboxJobId(list, "in-1", "job_x");
    expect(withOutboxJobId(once, "in-1", "job_x")).toBe(once);
  });
});

describe("readOutboxJobId", () => {
  it("достаёт job.id из ответа доставки", () => {
    expect(readOutboxJobId({ ok: true, delivery: "deferred", job: { id: "job_abc", state: "waiting" } })).toBe("job_abc");
  });

  it("возвращает undefined, когда job нет или он битый", () => {
    expect(readOutboxJobId({ ok: true })).toBeUndefined();
    expect(readOutboxJobId({ job: { state: "waiting" } })).toBeUndefined();
    expect(readOutboxJobId({ job: { id: "" } })).toBeUndefined();
    expect(readOutboxJobId(undefined)).toBeUndefined();
    expect(readOutboxJobId("строка")).toBeUndefined();
  });
});

describe("состояние задачи доставки", () => {
  it("различает терминальные состояния", () => {
    expect(isTerminalJobState("cancelled")).toBe(true);
    expect(isTerminalJobState("completed")).toBe(true);
    expect(isTerminalJobState("waiting")).toBe(false);
    expect(isTerminalJobState("cancelling")).toBe(false);
    expect(isTerminalJobState(undefined)).toBe(false);
  });

  it("отмена засчитывается только при реальной остановке задачи", () => {
    expect(cancelOutcomeOfJobState("cancelled")).toBe("cancelled");
    expect(cancelOutcomeOfJobState("completed")).toBe("delivered");
    expect(cancelOutcomeOfJobState("failed")).toBe("failed");
    expect(cancelOutcomeOfJobState("interrupted")).toBe("failed");
    expect(cancelOutcomeOfJobState("waiting")).toBe("failed");
  });
});

describe("сохранение jobId между перезагрузками", () => {
  it("jobId отложенного сообщения переживает readStoredOutbox", () => {
    const items = new Map([["agent-herder.outbox", JSON.stringify([{ ...entry("deferred"), jobId: "job_keep" }])]]);
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    };
    expect(readStoredOutbox(storage)[0].jobId).toBe("job_keep");
  });
});
