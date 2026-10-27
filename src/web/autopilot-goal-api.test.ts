import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../types/index.js";
import { GoalStore } from "../autopilot/goal-store.js";
import type { AutopilotSessionStore } from "../autopilot/session-store.js";
import { autopilotGoalApi } from "./autopilot-goal-api.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { status?: string; hostId?: string; baselineUnavailable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "herder-goal-api-")); roots.push(root);
  const cwd = resolve(root, "project");
  const session = { id: "session-1", harness: "opencode", cwd, status: options.status ?? "running", hostId: options.hostId };
  const adapter = { getSession: async () => session, getSessionMessages: async () => options.baselineUnavailable ? undefined : [] } as unknown as HarnessAdapter;
  const adapters = new Map<string, HarnessAdapter>([["opencode", adapter]]);
  const sessionStore = { set: vi.fn(async () => undefined) } as unknown as AutopilotSessionStore;
  const store = new GoalStore(join(root, "state"));
  const base = { harness: "opencode", sessionId: session.id, cwd, adapters, sessionStore, store };
  return { root, cwd, session, adapters, sessionStore, store, base };
}

describe("autopilotGoalApi", () => {
  it("GET is read only; arming requires explicit PUT and does not send a message", async () => {
    const f = await fixture({ status: "running" });
    const kick = vi.fn();
    const read = await autopilotGoalApi({ ...f.base, method: "GET", kick });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ available: true, goal: null, judge: { transport: "configured-openai-compatible", subscription: false } });
    expect(kick).not.toHaveBeenCalled();
    expect((await f.store.snapshot({ harness: "opencode", sessionId: f.session.id, cwd: f.cwd }).catch(() => null))).toBeNull();

    const armed = await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "arm", cwd: f.cwd, objective: "Implement the requested result", inputId: "intent-1", refs: [] }, kick });
    expect(armed.status).toBe(200);
    expect((armed.body.goal as { armed: boolean }).armed).toBe(true);
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses a non-local exact session without creating local goal state", async () => {
    const f = await fixture({ hostId: "another-host" });
    const result = await autopilotGoalApi({ ...f.base, method: "GET" });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ available: false });
    expect(JSON.stringify(result.body)).not.toContain(f.cwd);
  });

  it("does not arm when the read-only baseline cursor is unavailable", async () => {
    const f = await fixture({ baselineUnavailable: true });
    const result = await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "arm", cwd: f.cwd, objective: "A complete objective", inputId: "intent-no-baseline", refs: [] } });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("исходное состояние истории");
    await expect(f.store.snapshot({ harness: "opencode", sessionId: f.session.id, cwd: f.cwd })).rejects.toThrow("not armed");
  });

  it("stops and resumes the same goal through the explicit control actions", async () => {
    const f = await fixture({ status: "running" });
    await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "arm", cwd: f.cwd, objective: "Keep this objective", inputId: "intent-arm", refs: [] } });
    const stopped = await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "stop", cwd: f.cwd } });
    expect((stopped.body.goal as { stopped: boolean }).stopped).toBe(true);
    const resumed = await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "resume", cwd: f.cwd } });
    expect(resumed.status).toBe(200);
    expect(resumed.body.goal).toMatchObject({ armed: true, stopped: false, primaryEvents: [{ text: "Keep this objective" }] });
  });

  it("rejects secret-bearing file URI query data without echoing it", async () => {
    const f = await fixture();
    const secret = "private-test-marker";
    const result = await autopilotGoalApi({ ...f.base, method: "PUT", body: { action: "arm", cwd: f.cwd, objective: "Check output", inputId: "intent-secret", refs: [{ uri: `file://${f.cwd}/out.txt?token=${secret}` }] } });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    await expect(f.store.snapshot({ harness: "opencode", sessionId: f.session.id, cwd: f.cwd })).rejects.toThrow("not armed");
  });
});
