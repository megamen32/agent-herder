import { deferredMessages } from "../src/deferred-messages.js";
import { vi } from "vitest";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { HarnessAdapter } from "../src/types/index.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleetRecoveryAdmissionGate, evaluateFleetAdmission } from "../src/autopilot/recovery-admission.js";

const now = Date.parse("2026-10-08T00:00:00Z");
const session = { id: "owned" };
const state = (taskState = "active") => ({ utc: new Date(now).toISOString(), registry: { owned: { taskState } } });
describe("fleet admission authority", () => {
  it.each(["paused-unfinished", "resource-blocked", "component-complete-awaiting-integration"])("holds existing %s authority", (status) => {
    expect(evaluateFleetAdmission(state(status), session, now).allowed).toBe(false);
  });
  it("holds stale, malformed and foreign sessions", () => {
    expect(evaluateFleetAdmission(state(), session, now + 31 * 60_000).allowed).toBe(false);
    expect(evaluateFleetAdmission(null, session, now).allowed).toBe(false);
    expect(evaluateFleetAdmission(state(), { id: "foreign" }, now).allowed).toBe(false);
  });
  it("holds a fresh active task when the existing shared resource gate is denied", () => {
    const snapshot = { ...state(), heavy: { admission: "DENIED" } };
    expect(evaluateFleetAdmission(snapshot, session, now)).toEqual({ allowed: false, reason: "Existing fleet resource admission is denied" });
    expect(snapshot.registry.owned.taskState).toBe("active");
    expect(snapshot.heavy.admission).toBe("DENIED");
  });
  it("does not clear an existing blocker from an active task", () => {
    const snapshot = { ...state(), registry: { owned: { taskState: "active", stdioBlocker: "owner safety unproved" } } };
    expect(evaluateFleetAdmission(snapshot, session, now).allowed).toBe(false);
    expect(snapshot.registry.owned.stdioBlocker).toBe("owner safety unproved");
  });
  it.each([1, 2])("holds the independent supervisor admission check %s before native work or retry consumption", async (heldCheck) => {
    let resumes = 0;
    const adapter = { type: "codex", async getSession() { return null; }, async resumeSession() { resumes += 1; return { ok: true }; } } as HarnessAdapter;
    let gateChecks = 0;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async () => ++gateChecks >= heldCheck ? ({ allowed: false, reason: "existing fleet hold" }) : ({ allowed: true }) });
    const pending = { attempts: 0, inFlight: false };
    const internal = supervisor as unknown as { automaticResumes: Map<string, typeof pending>; runAutomaticResume(provider: string, id: string, adapter: HarnessAdapter, state: typeof pending): Promise<void> };
    internal.automaticResumes.set("codex:owned", pending);
    await internal.runAutomaticResume("codex", "owned", adapter, pending);
    expect(gateChecks).toBe(heldCheck);
    expect(resumes).toBe(0);
    expect(pending.attempts).toBe(0);
    expect(pending.inFlight).toBe(false);
  });
  it.each(["create", "rollover"] as const)("holds automatic %s while allowing authorized same-session resume", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-"));
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state()));
    const gate = createFleetRecoveryAdmissionGate(path, () => now);
    expect(await gate(session as never, operation)).toEqual({ allowed: false, reason: "Fleet authority permits existing-session recovery only" });
    expect(await gate(session as never, "resume")).toEqual({ allowed: true });
  });
  it.each(["paused-unfinished", "error", "resource-denied"])("holds automatic APIs for %s before native initialization", async (kind) => {
    const snapshot = kind === "resource-denied" ? { ...state(), heavy: { admission: "DENIED" } } : state(kind);
    let native = 0;
    const adapter = { type: "codex", async getSession() { native++; return null; }, async listSessions() { native++; return []; },
      async resumeSession() { native++; return { ok: true }; }, async sendMessage() { native++; return { ok: true }; },
      async recover() { native++; return { ok: true }; }, async forkSession() { native++; return { ok: true }; } } as HarnessAdapter;
    const deferred = vi.spyOn(deferredMessages, "add").mockImplementation(async () => ({ id: "stub", sessionId: "owned", message: "", createdAt: "" }));
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async (target, operation) => operation === "create" ? { allowed: false, reason: "existing identities only" } : evaluateFleetAdmission(snapshot, target, now) });
    try {
      expect((await supervisor.resumeSession("codex", "owned", "continue")).ok).toBe(false);
      expect((await supervisor.sendMessage("codex", "owned", { message: "continue", origin: "automation" }, "/owned")).ok).toBe(false);
      expect((await supervisor.recoverSession("codex", "owned")).ok).toBe(false);
      expect((await supervisor.forkSession("codex", "owned")).ok).toBe(false);
      expect(native).toBe(0);
      expect(deferred).not.toHaveBeenCalled();
    } finally { deferred.mockRestore(); }
  });
  it.each(["resume", "send"] as const)("rechecks automatic %s at the native boundary and preserves explicit human controls", async (operation) => {
    let resumes = 0, sends = 0, checks = 0;
    const adapter = { type: "codex", async getSession() { return null; },
      async resumeSession() { resumes++; return { ok: true }; }, async sendMessage() { sends++; return { ok: true }; } } as HarnessAdapter;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; }, async release() { return true; } } as never,
        admissionGate: async () => ++checks >= 2 ? { allowed: false, reason: "new authority hold" } : { allowed: true } });
    const result = operation === "resume" ? await supervisor.resumeSession("codex", "owned")
      : await supervisor.sendMessage("codex", "owned", { message: "continue" });
    expect(result.ok).toBe(false);
    expect(resumes + sends).toBe(0);
    if (operation === "resume") expect((await supervisor.resumeSession("codex", "owned", undefined, true)).ok).toBe(true);
    else expect((await supervisor.sendMessage("codex", "owned", { message: "human", origin: "human" })).ok).toBe(true);
    expect(resumes + sends).toBe(1);
    expect(checks).toBe(2);
  });
  it("holds deferred automatic insertion when admission changes after native busy response", async () => {
    let checks = 0;
    const adapter = { type: "codex", async getSession() { return null; },
      async sendMessage() { return { ok: false, error: "already has an active writer" }; } } as HarnessAdapter;
    const deferred = vi.spyOn(deferredMessages, "add").mockImplementation(async () => ({ id: "stub", sessionId: "owned", message: "", createdAt: "" }));
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async () => ++checks >= 3 ? { allowed: false, reason: "new hold" } : { allowed: true } });
    try {
      expect((await supervisor.sendMessage("codex", "owned", { message: "continue" })).ok).toBe(false);
      expect(checks).toBe(3);
      expect(deferred).not.toHaveBeenCalled();
    } finally { deferred.mockRestore(); }
  });
  it("rereads authoritative holds at the next boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-"));
    const path = join(root, "state.json");
    const gate = createFleetRecoveryAdmissionGate(path, () => now);
    expect((await gate(session as never, "attempt")).allowed).toBe(false);
    await writeFile(path, JSON.stringify(state()));
    expect((await gate(session as never, "resume")).allowed).toBe(true);
    await writeFile(path, JSON.stringify(state("paused-unfinished")));
    expect((await gate(session as never, "send")).allowed).toBe(false);
  });
});
