import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { coordinationNotes } from "../src/coordination-notes.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-resume-receipt-"));
  const adapter = new CodexAppServerAdapter({ codexDir: root, socketPath: join(root, "unused.sock"), requestTimeoutMs: 100 });
  let starts = 0, steers = 0, ambiguous = false, active = false, omitId = false;
  const native = adapter as unknown as { ensureReady(): Promise<void>; request(method: string, params: unknown): Promise<unknown> };
  vi.spyOn(native, "ensureReady").mockResolvedValue();
  vi.spyOn(adapter, "getSession").mockImplementation(async () => ({
    id: "owned", harness: "codex", status: active ? "running" : "idle", title: "fixture",
    cwd: root, lastActivity: new Date().toISOString(), needsPermission: false, messageCount: 1,
  }));
  vi.spyOn(native, "request").mockImplementation(async (method) => {
    if (method === "thread/resume") return { thread: { id: "owned", cwd: root } };
    if (method === "turn/start") {
      starts += 1; active = true;
      if (ambiguous) throw new Error("transport disconnected after admission");
      return { turn: { ...(omitId ? {} : { id: `native-turn-${starts}` }), status: "inProgress" } };
    }
    if (method === "turn/steer") { steers += 1; return { turnId: `native-turn-${starts}` }; }
    throw new Error("unexpected RPC " + method);
  });
  const notes = vi.spyOn(coordinationNotes, "inject").mockImplementation(async (_session, text) => text);
  const stops = { observe: async () => false, isHeld: async () => false, release: async () => true };
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined, {
    humanStopStore: stops as never, autoResumeFailedSessions: false,
  });
  return { adapter, supervisor, root, starts: () => starts, steers: () => steers, failReceipt: () => { ambiguous = true; },
    newFailure: () => { active = false; }, omitTurnId: () => { omitId = true; }, async cleanup() { notes.mockRestore(); await adapter.dispose(); await rm(root, { recursive: true, force: true }); } };
}

function forbidCompletionWait(adapter: CodexAppServerAdapter) {
  const native = adapter as unknown as { waitForCompletion(id: string): Promise<{ ok: boolean }> };
  return vi.spyOn(native, "waitForCompletion").mockImplementation(() => {
    throw new Error("Admission-only delivery must not wait for native task completion");
  });
}

describe("Codex resume admission receipts", () => {
  it("acknowledges explicit idle steer without waiting for task completion", async () => {
    const f = await fixture();
    try {
      const completion = forbidCompletionWait(f.adapter);
      const result = await f.adapter.sendMessage("owned", {
        message: "one idle input", origin: "human", steer: true, inputId: "idle-steer-1",
      });
      expect(completion).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, admitted: true, turnId: "native-turn-1", inputId: "idle-steer-1" });
      expect(f.starts()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("returns the same persisted idle-steer receipt after adapter restart without a second native input", async () => {
    const f = await fixture();
    const second = new CodexAppServerAdapter({ codexDir: f.root, socketPath: join(f.root, "unused.sock") });
    try {
      const options = { message: "one idle input", origin: "human" as const, steer: true, inputId: "persisted-steer-1" };
      const first = await f.adapter.sendMessage("owned", options);
      const native = second as unknown as { ensureReady(): Promise<void> };
      const ready = vi.spyOn(native, "ensureReady").mockRejectedValue(new Error("Must not dispatch duplicate"));
      expect(await second.sendMessage("owned", options)).toEqual(first);
      expect(first).toMatchObject({ admitted: true, turnId: "native-turn-1", inputId: options.inputId });
      expect(ready).not.toHaveBeenCalled();
      expect(f.starts()).toBe(1);
    } finally { await second.dispose(); await f.cleanup(); }
  });

  it("steers the verified active turn without starting another turn", async () => {
    const f = await fixture();
    try {
      await f.adapter.sendMessage("owned", { message: "start", origin: "human", steer: true, inputId: "active-start-1" });
      expect(await f.adapter.sendMessage("owned", { message: "adjust", origin: "human", steer: true, inputId: "active-adjust-1" }))
        .toMatchObject({ ok: true, admitted: true, turnId: "native-turn-1", inputId: "active-adjust-1" });
      expect(f.starts()).toBe(1);
      expect(f.steers()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("keeps sync pending until matched native completion and retains admission identity", async () => {
    const f = await fixture();
    try {
      let settled = false;
      const sending = f.adapter.sendMessage("owned", { message: "sync", origin: "human", inputId: "sync-1" })
        .then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(f.starts()).toBe(1));
      expect(settled).toBe(false);
      const native = f.adapter as unknown as { consumeMessage(message: unknown): void };
      native.consumeMessage({ method: "turn/started", params: { threadId: "owned", turn: { id: "native-turn-1" } } });
      native.consumeMessage({ method: "turn/completed", params: { threadId: "owned", turn: { id: "native-turn-1", status: "completed" } } });
      expect(await sending).toMatchObject({ ok: true, admitted: true, turnId: "native-turn-1", inputId: "sync-1" });
    } finally { await f.cleanup(); }
  });

  it("retains sync admission after a completion timeout and does not replay the input", async () => {
    const f = await fixture();
    try {
      const options = { message: "sync", origin: "human" as const, inputId: "sync-timeout-1" };
      const sending = f.adapter.sendMessage("owned", options);
      await vi.waitFor(() => expect(f.starts()).toBe(1));
      const native = f.adapter as unknown as {
        completions: Map<string, { resolve(value: { ok: boolean; error: string }): void }>;
        clearCompletion(id: string): void;
      };
      native.completions.get("owned")!.resolve({ ok: false, error: "Marked native completion timeout" });
      native.clearCompletion("owned");
      const result = await sending;
      expect(result).toMatchObject({ ok: false, admitted: true, nonRetryable: true,
        turnId: "native-turn-1", inputId: "sync-timeout-1" });
      expect(await f.adapter.sendMessage("owned", options)).toEqual(result);
      expect(f.starts()).toBe(1);
      expect(f.steers()).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("returns accepted turn identity before completion and deduplicates an explicit retry", async () => {
    const f = await fixture();
    try {
      const resume = f.supervisor.resumeSession as (h: string, id: string, message: string, human: boolean, inputId?: string) => Promise<unknown>;
      const completion = forbidCompletionWait(f.adapter);
      const result = await resume.call(f.supervisor, "codex", "owned", "continue exact checkpoint", true, "attempt-1");
      expect(completion).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, admitted: true, turnId: "native-turn-1", inputId: "attempt-1" });
      expect(await resume.call(f.supervisor, "codex", "owned", "continue exact checkpoint", true, "attempt-1")).toMatchObject({
        ok: true, turnId: "native-turn-1", inputId: "attempt-1",
      });
      expect(f.starts()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("holds ambiguous acceptance without replaying the same explicit operation", async () => {
    const f = await fixture(); f.failReceipt();
    try {
      const options = { message: "continue exact checkpoint", origin: "human" as const, queue: true, inputId: "uncertain-1" };
      expect(await f.adapter.sendMessage("owned", options)).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      expect(await f.adapter.sendMessage("owned", options)).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      expect(f.starts()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("admits a distinct explicit attempt after a new failure even with identical message text", async () => {
    const f = await fixture();
    try {
      const options = { message: "continue", origin: "human" as const, queue: true };
      expect(await f.adapter.sendMessage("owned", { ...options, inputId: "failure-1" })).toMatchObject({ ok: true, turnId: "native-turn-1" });
      f.newFailure();
      expect(await f.adapter.sendMessage("owned", { ...options, inputId: "failure-2" })).toMatchObject({ ok: true, turnId: "native-turn-2" });
      expect(f.starts()).toBe(2);
    } finally { await f.cleanup(); }
  });
  it("holds a malformed admission receipt without manufacturing a turn ID or replaying", async () => {
    const f = await fixture(); f.omitTurnId();
    try {
      const options = { message: "continue", origin: "human" as const, queue: true, inputId: "missing-turn-1" };
      const result = await f.adapter.sendMessage("owned", options);
      expect(result).toMatchObject({ ok: false, admitted: true, admissionUnknown: true, nonRetryable: true });
      expect(result.turnId).toBeUndefined();
      expect(await f.adapter.sendMessage("owned", options)).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      expect(f.starts()).toBe(1);
    } finally { await f.cleanup(); }
  });

});
