import { deferredMessages } from "../src/deferred-messages.js";
import { vi } from "vitest";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { HarnessAdapter } from "../src/types/index.js";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFleetRecoveryAdmissionGate, evaluateFleetAdmission } from "../src/autopilot/recovery-admission.js";

const now = Date.parse("2026-10-08T00:00:00Z");
const session = { id: "owned" };
const state = (taskState = "active") => ({ utc: new Date(now).toISOString(), registry: { owned: { taskState } } });
describe("fleet admission authority", () => {
  it("separates opted-in Stop delivery from the historical recovery campaign without clearing holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-autopilot-admission-"));
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state("paused-unfinished")));
    const gate = createFleetRecoveryAdmissionGate(path, () => now + 31 * 60_000);
    const fresh = { id: "new-opted-in-session", harness: "codex" } as never;
    expect(await gate(fresh, "autopilot-send")).toEqual({ allowed: true });
    expect((await gate(fresh, "send")).allowed).toBe(false);
    expect((await gate({ id: "owned", harness: "codex" } as never, "autopilot-send")).allowed).toBe(false);
    await writeFile(path, JSON.stringify({ ...state(), heavy: { admission: "DENIED" } }));
    expect((await gate(fresh, "autopilot-send")).allowed).toBe(false);
    await writeFile(path, JSON.stringify({ utc: new Date(now).toISOString() }));
    expect((await gate(fresh, "autopilot-send")).allowed).toBe(false);
  });
  it("propagates semantic Stop purpose through both native admission checks", async () => {
    const seen: string[] = [];
    const adapter = { type: "codex", async getSession() { return null; }, async sendMessage() { return { ok: true }; } } as HarnessAdapter;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async (_target, operation) => { seen.push(operation); return { allowed: operation === "autopilot-send" }; } });
    expect((await supervisor.sendMessage("codex", "new-session", { message: "second stage", origin: "automation", automationPurpose: "autopilot" })).ok).toBe(true);
    expect(seen).toEqual(["autopilot-send", "autopilot-send"]);
    expect((await supervisor.sendMessage("codex", "new-session", { message: "recovery", origin: "automation" })).ok).toBe(false);
  });
  it("does not apply the historical Codex campaign registry to bounded same-ID ZCode work", async () => {
    const gate = createFleetRecoveryAdmissionGate("/missing/historical-codex-campaign");
    for (const operation of ["attempt", "resume", "send"] as const) {
      expect(await gate({ id: "sess_zcode", harness: "zcode" } as never, operation)).toEqual({ allowed: true });
    }
    expect((await gate({ id: "sess_zcode", harness: "zcode" } as never, "create")).allowed).toBe(false);
    expect((await gate({ id: "codex", harness: "codex" } as never, "send")).allowed).toBe(false);
  });
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
        admissionGate: async () => ++gateChecks >= heldCheck ? ({ allowed: false, reason: "unique automatic resume blocker" }) : ({ allowed: true }) });
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = { attempts: 0, inFlight: false };
    const internal = supervisor as unknown as { automaticResumes: Map<string, typeof pending>; runAutomaticResume(provider: string, id: string, adapter: HarnessAdapter, state: typeof pending): Promise<void> };
    internal.automaticResumes.set("codex:owned", pending);
    try {
      await internal.runAutomaticResume("codex", "owned", adapter, pending);
      expect(gateChecks).toBe(heldCheck);
      expect(resumes).toBe(0);
      expect(pending.attempts).toBe(0);
      expect(pending.inFlight).toBe(false);
      expect(reported.mock.calls.flat().join(" ")).toContain("unique automatic resume blocker");
    } finally { reported.mockRestore(); }
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

  // Fast unit: the 2026-10-07 campaign snapshot stopped being refreshed when the
  // campaign ended, so an enforced gate silently held every non-ZCode session
  // for days. Retirement is an explicit operator switch, never inferred.
  it("retires the ended campaign gate only by explicit operator decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-retired-"));
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state("active")));
    const enforced = createFleetRecoveryAdmissionGate(path, () => now, {});
    expect((await enforced({ id: "foreign", harness: "codex" } as never, "resume")).allowed).toBe(false);
    const retired = createFleetRecoveryAdmissionGate(path, () => now, { AGENT_HERDER_FLEET_ADMISSION: "retired" });
    for (const operation of ["attempt", "resume", "send", "autopilot-send"] as const) {
      expect((await retired({ id: "foreign", harness: "codex" } as never, operation)).allowed).toBe(true);
    }
    // Retirement drops only the campaign registry, never Herder's own fences.
    for (const operation of ["create", "rollover"] as const) {
      expect((await retired({ id: "foreign", harness: "codex" } as never, operation)).allowed).toBe(false);
    }
  });

  it("ignores stale campaign resource observations after retirement but preserves a fresh explicit denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-retired-stale-"));
    const path = join(root, "state.json");
    const retired = createFleetRecoveryAdmissionGate(path, () => now, { AGENT_HERDER_FLEET_ADMISSION: "retired" });
    try {
      await writeFile(path, JSON.stringify({ utc: new Date(now - 11 * 24 * 60 * 60_000).toISOString(), heavy: { admission: "DENIED" }, registry: {} }));
      await utimes(path, new Date(now), new Date(now - 60_000));
      expect(await retired({ id: "foreign", harness: "codex" } as never, "send")).toEqual({ allowed: true });

      await writeFile(path, JSON.stringify({ utc: new Date(now).toISOString(), heavy: { admission: "DENIED" }, registry: {} }));
      await utimes(path, new Date(now), new Date(now));
      expect(await retired({ id: "foreign", harness: "codex" } as never, "send")).toEqual({ allowed: false, reason: "Existing fleet resource admission is denied" });

      await writeFile(path, JSON.stringify({ utc: new Date(now - 11 * 24 * 60 * 60_000).toISOString(), heavy: { admission: "DENIED_UNLESS_FRESH_EXACT_CASE" }, registry: {} }));
      await utimes(path, new Date(now), new Date(now + 60_000));
      let submissions = 0;
      const existing = { id: "continued", harness: "codex" as const, status: "idle" as const, title: "Existing", cwd: "/workspace", lastActivity: new Date(now).toISOString(), needsPermission: false };
      const adapter = { type: "codex", async getSession() { return existing; }, async sendMessage() { submissions += 1; return { ok: true, admitted: true, turnId: "fixture-turn" }; } } as unknown as HarnessAdapter;
      const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as never, undefined,
        { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never, admissionGate: retired });
      const result = await supervisor.sendMessage("codex", "continued", { message: "one dependency continuation", origin: "automation" });
      expect(result).toMatchObject({ ok: true, admitted: true, turnId: "fixture-turn" });
      expect(submissions).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not bypass a fresh resource denial while the retired snapshot cache is populated concurrently", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-retired-cold-race-"));
    const path = join(root, "state.json");
    try {
      await writeFile(path, JSON.stringify({ utc: new Date(now).toISOString(), heavy: { admission: "DENIED" }, registry: {} }));
      const gate = createFleetRecoveryAdmissionGate(path, () => now, { AGENT_HERDER_FLEET_ADMISSION: "retired" });
      const results = await Promise.all(Array.from({ length: 32 }, (_, index) =>
        gate({ id: `fixture-${index}`, harness: "codex" } as never, "send")));
      expect(results.every(result => !result.allowed)).toBe(true);
      expect(results.every(result => result.allowed === false && result.reason === "Existing fleet resource admission is denied")).toBe(true);

      await writeFile(path, JSON.stringify({ utc: new Date(now).toISOString(), registry: { owned: { taskState: "active", stdioBlocker: "owner decision remains" } } }));
      const sessionGate = createFleetRecoveryAdmissionGate(path, () => now, { AGENT_HERDER_FLEET_ADMISSION: "retired" });
      const sessionResults = await Promise.all(Array.from({ length: 32 }, () =>
        sessionGate({ id: "owned", harness: "codex" } as never, "send")));
      expect(sessionResults.every(result => result.allowed === false && result.reason === "Fleet task retains stdioBlocker")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["stdioBlocker", "owner-confirmation-required"],
    ["recoveryBlockedReason", "recovery-authority-held"],
    ["resourceBlockedReason", "resource-owner-denied"],
  ] as const)("preserves a fresh per-session %s denial after campaign retirement", async (field, value) => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-retired-session-blocker-"));
    const path = join(root, "state.json");
    const gate = createFleetRecoveryAdmissionGate(path, () => now, { AGENT_HERDER_FLEET_ADMISSION: "retired" });
    try {
      await writeFile(path, JSON.stringify({ utc: new Date(now).toISOString(), registry: { owned: { taskState: "active", [field]: value } } }));
      expect(await gate({ id: "owned", harness: "codex" } as never, "send")).toEqual({
        allowed: false,
        reason: `Fleet task retains ${field}`,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns exact pre-send admission provenance from resume, recovery and fork APIs", async () => {
    const reason = "Fleet task retains stdioBlocker";
    let native = 0;
    const adapter = { type: "codex", async getSession() { native++; return null; },
      async resumeSession() { native++; return { ok: true }; }, async recover() { native++; return { ok: true }; },
      async forkSession() { native++; return { ok: true }; } } as unknown as HarnessAdapter;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), {} as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async () => ({ allowed: false, reason }) });

    for (const result of [
      await supervisor.resumeSession("codex", "owned", "continue"),
      await supervisor.recoverSession("codex", "owned"),
      await supervisor.forkSession("codex", "owned"),
    ]) {
      expect(result).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true, error: reason });
    }
    expect(native).toBe(0);
  });

  it("returns exact pre-send admission refusal and proves no native submission occurred", async () => {
    const reason = "Fleet admission observation is stale or invalid";
    let submissions = 0;
    const session = { id: "owned", harness: "codex", status: "idle", title: "Owned", cwd: "/workspace", lastActivity: new Date(now).toISOString(), needsPermission: false } as const;
    const adapter = { type: "codex", async getSession() { return session; }, async sendMessage() { submissions += 1; return { ok: true, admitted: true }; } } as unknown as HarnessAdapter;
    const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as never, undefined,
      { humanStopStore: { async isHeld() { return false; }, async observe() { return false; } } as never,
        admissionGate: async () => ({ allowed: false, reason }) });

    const result = await supervisor.sendMessage("codex", "owned", { message: "bounded continuation", origin: "automation" });

    expect(result).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true, error: reason });
    expect(submissions).toBe(0);
  });

  it("reports a silent campaign hold once per interval instead of denying without a trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-admission-warn-"));
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state()));
    const gate = createFleetRecoveryAdmissionGate(path, () => now + 31 * 60_000, {});
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await gate({ id: "owned", harness: "codex" } as never, "attempt")).allowed).toBe(false);
      }
      expect(reported).toHaveBeenCalledTimes(1);
      expect(String(reported.mock.calls[0]![0])).toContain("AGENT_HERDER_FLEET_ADMISSION=retired");
    } finally { reported.mockRestore(); }
  });
});
