import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../src/types/index.js";
import type { ResumeAfterService, ResumeAfterWait } from "../src/resume-after.js";
import { DeliverSchema } from "../src/mcp-tools/definitions.js";
import { scheduleDeliver } from "../src/mcp-tools/handlers.js";

function fakeAdapter(known: string[] = ["s1"]): HarnessAdapter {
  return {
    async getSession(id: string) {
      return known.includes(id) ? { id, harness: "codex", status: "idle" } as never : null;
    },
  } as unknown as HarnessAdapter;
}

function stubService(state: ResumeAfterWait["state"] = "waiting") {
  const registered: Array<Record<string, unknown>> = [];
  const service = {
    register: async (input: Record<string, unknown>) => {
      registered.push(input);
      return {
        id: "wait_test1",
        owner: input.owner,
        dependencies: [],
        message: input.message,
        trigger: input.trigger,
        scheduledAt: "2026-11-01T00:10:00.000Z",
        createdAt: "2026-11-01T00:00:00.000Z",
        state,
        completed: {},
      } as ResumeAfterWait;
    },
  } as unknown as ResumeAfterService;
  return { service, registered };
}

describe("scheduleDeliver", () => {
  it("fails safely when target lookup never returns, without registering a wait", async () => {
    vi.useFakeTimers();
    try {
      const { service, registered } = stubService();
      let release!: (value: unknown) => void;
      const stuck = { getSession: () => new Promise(resolve => { release = resolve; }) } as unknown as HarnessAdapter;
      const result = scheduleDeliver(new Map([["opencode", stuck]]), service,
        { sessionId: "ses_test", harness: "opencode", inputId: "stable", message: "hi", deliverIn: 60 });
      const assertion = expect(result).rejects.toThrow(/session_lookup_timeout/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      release({ id: "ses_test", harness: "opencode", status: "idle" });
      await vi.runAllTimersAsync();
      expect(registered).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it("rejects a call without a schedule trigger", async () => {
    const { service } = stubService();
    await expect(scheduleDeliver(new Map([["codex", fakeAdapter()]]), service, { sessionId: "s1", message: "hi" }))
      .rejects.toThrow(/scheduled_delivery_needs_trigger/);
  });

  it("registers a durable delay wait and reports the receipt", async () => {
    const { service, registered } = stubService();
    const out = JSON.parse(await scheduleDeliver(new Map([["codex", fakeAdapter()]]), service,
      { sessionId: "s1", harness: "codex", message: "hi", deliverIn: 600 }));
    expect(out.scheduled).toBe(true);
    expect(out.waitId).toBe("wait_test1");
    expect(out.deliverAt).toBe("2026-11-01T00:10:00.000Z");
    expect(registered[0]!["trigger"]).toEqual({ kind: "delay", delayMs: 600000 });
    expect(registered[0]!["owner"]).toEqual({ harness: "codex", sessionId: "s1" });
  });

  it("keeps a stable requestId across retries with the same inputId", async () => {
    const { service, registered } = stubService();
    const adapters = new Map([["codex", fakeAdapter()]]);
    const args = { sessionId: "s1", message: "hi", deliverIn: 60, inputId: "in-1" };
    await scheduleDeliver(adapters, service, args);
    await scheduleDeliver(adapters, service, args);
    expect(registered[0]!["requestId"]).toBe("in-1");
    expect(registered[1]!["requestId"]).toBe("in-1");
  });

  it("refuses remote hosts and named targets", async () => {
    const { service } = stubService();
    const adapters = new Map([["codex", fakeAdapter()]]);
    await expect(scheduleDeliver(adapters, service, { sessionId: "s1", message: "hi", deliverIn: 60, hostId: "other-host" }))
      .rejects.toThrow(/scheduled_delivery_remote_host/);
    await expect(scheduleDeliver(adapters, service, { harness: "codex", name: "t", cwd: "/tmp/x", message: "hi", deliverIn: 60 }))
      .rejects.toThrow(/scheduled_delivery_needs_session_id/);
  });

  it("refuses a missing target session", async () => {
    const { service } = stubService();
    await expect(scheduleDeliver(new Map([["codex", fakeAdapter()]]), service, { sessionId: "nope", message: "hi", deliverIn: 60 }))
      .rejects.toThrow(/scheduled_delivery_target_missing/);
  });

  it("reports a wait that did not enter the waiting state", async () => {
    const { service } = stubService("cancelled");
    const out = JSON.parse(await scheduleDeliver(new Map([["codex", fakeAdapter()]]), service, { sessionId: "s1", message: "hi", deliverIn: 60 }));
    expect(out.ok).toBe(false);
    expect(out.state).toBe("cancelled");
  });

  it("rejects both triggers and model overrides at the schema level", () => {
    expect(DeliverSchema.safeParse({ sessionId: "s1", message: "hi", deliverIn: 60, deliverAt: "2026-11-01T00:00:00Z" }).success).toBe(false);
    expect(DeliverSchema.safeParse({ sessionId: "s1", message: "hi", deliverIn: 60, model: "gpt" }).success).toBe(false);
    expect(DeliverSchema.safeParse({ sessionId: "s1", message: "hi", deliverIn: 600 }).success).toBe(true);
  });
});
