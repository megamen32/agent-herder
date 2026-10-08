import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { coordinationNotes } from "../src/coordination-notes.js";

async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".tmp/codex-resume-receipt-"));
  const adapter = new CodexAppServerAdapter({ codexDir: root, socketPath: join(root, "unused.sock"), requestTimeoutMs: 100 });
  let starts = 0, ambiguous = false, active = false, omitId = false;
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
    throw new Error("unexpected RPC " + method);
  });
  const notes = vi.spyOn(coordinationNotes, "inject").mockImplementation(async (_session, text) => text);
  const stops = { observe: async () => false, isHeld: async () => false, release: async () => true };
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined, {
    humanStopStore: stops as never, autoResumeFailedSessions: false,
  });
  return { adapter, supervisor, starts: () => starts, failReceipt: () => { ambiguous = true; },
    newFailure: () => { active = false; }, omitTurnId: () => { omitId = true; }, async cleanup() { notes.mockRestore(); await adapter.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("Codex resume admission receipts", () => {
  it("returns accepted turn identity before completion and deduplicates an explicit retry", async () => {
    const f = await fixture();
    try {
      const resume = f.supervisor.resumeSession as (h: string, id: string, message: string, human: boolean, inputId?: string) => Promise<unknown>;
      const result = await Promise.race([
        resume.call(f.supervisor, "codex", "owned", "continue exact checkpoint", true, "attempt-1"),
        new Promise(resolve => setTimeout(() => resolve("completion wait"), 100)),
      ]);
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
