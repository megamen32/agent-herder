import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery, type UserMessageInput } from "../src/user-message-delivery.js";
import type { HarnessAdapter, SendMessageResult } from "../src/types/index.js";

function fixture(options?: { jobs?: HerderJobRegistry; harness?: string; result?: SendMessageResult; maxWaitMs?: number }) {
  let status = "running";
  const harness = options?.harness || "codex";
  const getSession = vi.fn(async () => ({ id: "thread", harness, status, cwd: "/workspace" }));
  const sendMessage = vi.fn(async () => { status = "running"; return options?.result || { ok: true, admitted: true, turnId: "native-turn" }; });
  const adapter = { getSession } as unknown as HarnessAdapter;
  const jobs = options?.jobs || new HerderJobRegistry(new HerderEventBus());
  const delivery = new UserMessageDelivery(new Map([[harness, adapter]]), { sendMessage }, jobs, { pollMs: 5, maxWaitMs: options?.maxWaitMs ?? 1_000, maxPending: 4 });
  const input = (id: string, mode: "queue" | "steer" = "queue"): UserMessageInput => ({ harness, sessionId: "thread", inputId: id, message: id, mode });
  return { delivery, jobs, getSession, sendMessage, input, idle: () => { status = "idle"; } };
}

const completed = async (f: ReturnType<typeof fixture>, id: string) => {
  await vi.waitFor(() => expect(f.delivery.get(f.input(id).harness, "thread", id)?.job?.state).toBe("completed"), { interval: 5, timeout: 500 });
};

describe("actual human message queue admission", () => {
  it("waits for native idle, starts each distinct message in order, and deduplicates a retry", async () => {
    const f = fixture();
    try {
      const first = f.delivery.submit(f.input("one"));
      expect(f.delivery.submit(f.input("one")).job?.id).toBe(first.job?.id);
      f.delivery.submit(f.input("two"));
      await vi.waitFor(() => expect(f.getSession).toHaveBeenCalled());
      expect(f.sendMessage).not.toHaveBeenCalled();
      f.idle(); await completed(f, "one");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage.mock.calls[0][2]).toMatchObject({ message: "one", inputId: "one", origin: "human", queue: true, steer: false });
      f.idle(); await completed(f, "two");
      expect(f.sendMessage.mock.calls.map(call => call[2].message)).toEqual(["one", "two"]);
      expect(f.delivery.submit(f.input("one"))).toMatchObject({ admitted: true, turnId: "native-turn" });
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
    } finally { f.delivery.close(); }
  });

  it("steers immediately while the human queue waits for the current turn", async () => {
    const f = fixture();
    try {
      f.delivery.submit(f.input("after"));
      f.delivery.submit(f.input("now", "steer"));
      await completed(f, "now");
      expect(f.sendMessage.mock.calls.map(call => call[2].message)).toEqual(["now"]);
      expect(f.sendMessage.mock.calls[0][2].steer).toBe(true);
      f.idle(); await completed(f, "after");
    } finally { f.delivery.close(); }
  });

  it("delivers intentionally repeated human text once per distinct input identity", async () => {
    const f = fixture();
    const first = { ...f.input("intent-one"), message: "Продолжи эту задачу" };
    const second = { ...f.input("intent-two"), message: first.message };
    try {
      f.delivery.submit(first);
      f.delivery.submit(second);
      f.idle(); await completed(f, first.inputId);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      f.idle(); await completed(f, second.inputId);
      expect(f.sendMessage.mock.calls.map(call => [call[2].inputId, call[2].message])).toEqual([
        [first.inputId, first.message], [second.inputId, second.message],
      ]);
      f.delivery.submit(first); f.delivery.submit(second);
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
    } finally { f.delivery.close(); }
  });

  it("does not replay uncertain native admission or reuse an identity for different text", async () => {
    const f = fixture({ result: { ok: false, admissionUnknown: true, nonRetryable: true, error: "lost receipt" } });
    try {
      f.idle(); f.delivery.submit(f.input("unknown")); await completed(f, "unknown");
      expect(f.delivery.submit(f.input("unknown"))).toMatchObject({ ok: false, admissionUnknown: true });
      expect(() => f.delivery.submit({ ...f.input("unknown"), message: "other text" })).toThrow(/другого текста/);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { f.delivery.close(); }
  });

  it("keeps an interrupted durable job visible after restart and never silently resubmits it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-human-queue-"));
    const path = join(dir, "jobs.json");
    const first = fixture({ jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: path }) });
    let second: ReturnType<typeof fixture> | undefined;
    try {
      const record = first.delivery.submit(first.input("restart"));
      second = fixture({ jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: path }) });
      const replay = second.delivery.submit(second.input("restart"));
      expect(replay.job?.id).toBe(record.job?.id);
      expect(replay).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, job: { state: "interrupted" } });
      expect(second.sendMessage).not.toHaveBeenCalled();
    } finally { first.delivery.close(); second?.delivery.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not silently expose Codex steer semantics through ZCode sendPrompt", () => {
    const f = fixture({ harness: "zcode" });
    try {
      expect(() => f.delivery.submit(f.input("not-supported", "steer"))).toThrow(/пока не поддерживается/);
      expect(f.sendMessage).not.toHaveBeenCalled();
    } finally { f.delivery.close(); }
  });

  it("finishes a timed out native read without declaring admission or blocking another session", async () => {
    const f = fixture({ maxWaitMs: 20 });
    let release!: () => void;
    f.getSession.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ id: "thread", harness: "codex", cwd: "/workspace", status: "idle" });
    }));
    try {
      f.delivery.submit(f.input("unavailable"));
      await vi.waitFor(() => expect(f.getSession).toHaveBeenCalled());
      await completed(f, "unavailable");
      expect(f.delivery.get("codex", "thread", "unavailable")).toMatchObject({ ok: false, nonRetryable: true });
      expect(f.sendMessage).not.toHaveBeenCalled();
      f.delivery.submit({ ...f.input("other", "steer"), sessionId: "another-thread" });
      await vi.waitFor(() => expect(f.delivery.get("codex", "another-thread", "other")?.admitted).toBe(true));
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.delivery.close(); }
  });

  it("keeps late native admission unknown after cancellation and never repeats that input", async () => {
    const f = fixture();
    let release!: () => void;
    f.sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ ok: true, admitted: true, turnId: "late-turn" });
    }));
    try {
      f.idle(); f.delivery.submit(f.input("late"));
      await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
      f.delivery.cancelSession("codex", "thread");
      await completed(f, "late");
      expect(f.delivery.submit(f.input("late"))).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.delivery.get("codex", "thread", "late")?.admissionUnknown).toBe(true);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.delivery.close(); }
  });
});
