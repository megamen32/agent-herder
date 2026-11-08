import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { HerderEventBus } from "../src/herder-events.js";
import type { JudgeClient } from "../src/autopilot/index.js";
import { V1NoticePlaceAutopilot, type V1Completion, type V1AutopilotSnapshot, type V1AutopilotRustPort } from "../src/automation/v1-noticeplace-autopilot.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const incident = { incidentId: "original", project: "infra", planId: "repair" as const };
const attempt = { incidentId: "current", attemptId: "attempt1" };
const event = { sessionRef: "rust-ref", nativeSessionId: "ses_native_exact", turnId: "native-turn-1" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "v1-notice-autopilot-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new AutopilotSessionStore(join(dir, "sessions.json"));
  const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(dir, "jobs.json") });
  const row = { session_ref: event.sessionRef, address: { native_session_id: event.nativeSessionId, instance_id: "oc1", node: "100" }, native: { harness: "opencode", cwd: dir } };
  let snapshot: V1AutopilotSnapshot = { sessionRef: event.sessionRef, nativeSessionId: event.nativeSessionId,
    cwd: dir, status: "idle", humanStopHeld: false, turnId: event.turnId, revision: "history1",
    model: "minimax-coding-plan/MiniMax-M3.1-Flash", messages: [{ role: "user", text: "Исправь инцидент" }, { role: "assistant", text: "Осталась проверка" }] };
  let handler: ((e: V1Completion) => Promise<unknown>) | undefined;
  let active = true;
  const deliver = vi.fn(async (_input: Parameters<V1AutopilotRustPort["deliver"]>[0]) => ({ status: "accepted" }));
  const decide = vi.fn(async (_input: Parameters<JudgeClient["decide"]>[0]): Promise<unknown> => ({ kind: "continue", nextGoal: "Проверь результат" }));
  const send = vi.fn(async () => {});
  const register = vi.fn(async (_ref: string, cb: typeof handler) => {
    handler = cb; return { isActive: () => active, close: () => { active = false; } };
  });
  const deps = { store, jobs, stateDir: dir,
    rust: { listSessions: vi.fn(async () => [row]), snapshot: vi.fn(async () => structuredClone(snapshot)), deliver },
    registerCompletion: register, createJudge: vi.fn(() => ({ decide })),
    core: { notify: { send: vi.fn(async () => { throw Error("generic notification forbidden"); }) }, incidentUpdates: { send },
      pendingQuestions: { blocks: vi.fn(async () => false) }, maxContinuationsPerSession: 3 },
  };
  const service = new V1NoticePlaceAutopilot(deps);
  const arm = () => service.arm({ sessionRef: event.sessionRef, enabled: true, noticeIncident: incident, noticeAttempt: attempt });
  return { dir, store, jobs, row, deps, service, arm, decide, deliver, send, register,
    emit: () => handler!(event), setSnapshot: (delta: Partial<V1AutopilotSnapshot>) => { snapshot = { ...snapshot, ...delta }; },
    setActive: (value: boolean) => { active = value; } };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  await vi.waitFor(() => expect(["completed", "failed", "interrupted"]).toContain(f.jobs.get(id)?.state));
  return f.jobs.get(id)!;
}

describe("V1 NoticePlace event-driven autopilot", () => {
  it("arms durably only with a live callback and continues exact Rust ref/native identity once", async () => {
    const f = await fixture();
    expect(await f.arm()).toMatchObject({ armed: true, enabled: true, sessionId: event.sessionRef, nativeSessionId: event.nativeSessionId });
    expect(await new AutopilotSessionStore(join(f.dir, "sessions.json")).get("opencode", event.nativeSessionId)).toMatchObject({ noticeIncident: incident, noticeAttempt: attempt });
    const job = await f.emit() as { id: string }; await finish(f, job.id);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.decide.mock.calls[0]?.[0]).toMatchObject({ hook: { session_id: event.nativeSessionId, model: "minimax-coding-plan/MiniMax-M3.1-Flash", cwd: f.dir } });
    expect(f.deps.createJudge).toHaveBeenCalledWith({ provider: "minimax-coding-plan", model: "MiniMax-M3.1-Flash" });
    expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionRef: event.sessionRef, nativeSessionId: event.nativeSessionId, message: "Проверь результат", requestKey: expect.stringMatching(/^v1-notice-auto:/), model: "minimax-coding-plan/MiniMax-M3.1-Flash" }));
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ binding: incident }));
    expect((await f.emit() as { id: string }).id).toBe(job.id);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const restarted = new V1NoticePlaceAutopilot({ ...f.deps, jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "jobs.json") }) });
    expect(await restarted.get(event.sessionRef)).toMatchObject({ armed: false, enabled: true });
    f.setActive(true); await restarted.restore();
    expect(await restarted.get(event.sessionRef)).toMatchObject({ armed: true });
    expect((await restarted.reconcile(event)).id).toBe(job.id);
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("never advertises armed on store-only toggle or failed subscription", async () => {
    const f = await fixture(); f.setActive(false);
    await expect(f.arm()).rejects.toThrow("completion_callback_unavailable");
    expect(await f.store.get("opencode", event.nativeSessionId)).toBeNull();
    await f.store.set({ harness: "opencode", sessionId: event.nativeSessionId, cwd: f.dir, noticeIncident: incident }, true);
    expect(await f.service.get(event.sessionRef)).toMatchObject({ enabled: true, armed: false });
  });
  it.each(["stop", "disable", "history", "binding", "attempt", "disconnect", "human-question"])("fences continuation after %s during judge", async (reason) => {
    const f = await fixture(); let release!: (value: unknown) => void;
    f.decide.mockImplementation(async () => await new Promise(resolve => { release = resolve; }) as never);
    await f.arm(); const job = await f.emit() as { id: string };
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    if (reason === "stop") f.setSnapshot({ humanStopHeld: true });
    if (reason === "disable") await f.service.arm({ sessionRef: event.sessionRef, enabled: false });
    if (reason === "history") f.setSnapshot({ revision: "new-history" });
    if (reason === "binding") f.row.address.native_session_id = "other-native";
    if (reason === "attempt") await f.store.set({ harness: "opencode", sessionId: event.nativeSessionId, cwd: f.dir, noticeAttempt: { ...attempt, attemptId: "attempt2" } }, true);
    if (reason === "disconnect") f.setActive(false);
    if (reason === "human-question") f.deps.core.pendingQuestions.blocks.mockResolvedValue(true);
    release({ kind: "continue", nextGoal: "late" }); await finish(f, job.id);
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("rejects wrong native event and stopped/busy snapshot before judging", async () => {
    const f = await fixture(); await f.arm();
    await expect(f.service.reconcile({ ...event, nativeSessionId: "forged" })).rejects.toThrow("native_identity_mismatch");
    f.setSnapshot({ status: "running" }); const job = await f.emit() as { id: string }; await finish(f, job.id);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  });
  it("preserves original binding and suppresses replay after unknown delivery", async () => {
    const f = await fixture(); f.deliver.mockImplementation(async () => { throw Error("lost ACK"); });
    await f.arm(); const job = await f.emit() as { id: string }; expect((await finish(f, job.id)).state).toBe("failed");
    await f.emit(); expect(f.deliver).toHaveBeenCalledTimes(1);
    await expect(f.service.arm({ sessionRef: event.sessionRef, enabled: true, noticeIncident: { ...incident, incidentId: "replacement" } })).rejects.toThrow("original Notice incident");
    expect(await f.store.get("opencode", event.nativeSessionId)).toMatchObject({ noticeIncident: incident, noticeAttempt: attempt });
  });
  it("coalesces concurrent completion callbacks into one durable job", async () => {
    const f = await fixture(); await f.arm();
    const jobs = await Promise.all([f.emit(), f.emit(), f.emit()]) as Array<{ id: string }>;
    expect(new Set(jobs.map(job => job.id)).size).toBe(1); await finish(f, jobs[0]!.id);
    expect(f.decide).toHaveBeenCalledTimes(1); expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("requires durable job persistence before registering or enabling", async () => {
    const f = await fixture();
    const service = new V1NoticePlaceAutopilot({ ...f.deps, jobs: new HerderJobRegistry(new HerderEventBus()) });
    await expect(service.arm({ sessionRef: event.sessionRef, enabled: true, noticeIncident: incident })).rejects.toThrow("durable_jobs_required");
    expect(f.register).not.toHaveBeenCalled(); expect(await f.store.list()).toEqual([]);
  });
  it("keeps pending human requests fenced through the existing semantic core", async () => {
    const f = await fixture(); f.deps.core.pendingQuestions.blocks.mockResolvedValue(true);
    await f.arm(); const job = await f.emit() as { id: string }; await finish(f, job.id);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  });
  it("delivers an original-incident done verdict without a continuation", async () => {
    const f = await fixture(); f.decide.mockResolvedValue({ kind: "done", summary: "Проверено" } as never);
    await f.arm(); const job = await f.emit() as { id: string }; await finish(f, job.id);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ binding: incident }));
    expect(f.deps.core.notify.send).not.toHaveBeenCalled();
  });
});
