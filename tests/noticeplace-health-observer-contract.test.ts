import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeplaceHealthObserver, type NoticeplaceHealthTarget } from "../src/automation/noticeplace-health-observer.js";
import { createIncidentUpdateSink, readIncidentBinding, NoticeIncidentBindingError, type IncidentProgressUpdate } from "../src/autopilot/notice-incident.js";
import { describeHealthStep, HEALTH_STEP_LIMIT } from "../src/automation/noticeplace-health-text.js";
import { resolveLaunchHealthPlan, NOTICEPLACE_HEALTH_MODELS } from "../src/automation/noticeplace-health-policy.js";
import { validateNoticeplaceHealthLaunch } from "../src/automation/noticeplace-health-launch.js";
import { readArmedHealthCandidates, recoverNoticeplaceHealthObservation } from "../src/automation/noticeplace-health-recovery.js";
import type { AgentStatus, SessionDetails } from "../src/types/index.js";

let directory: string;

beforeEach(async () => {
  // The fixtures live in the ignored .tmp tree of the checkout, which a fresh
  // clone does not have yet.
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  directory = await mkdtemp(join(process.cwd(), ".tmp/noticeplace-observer-test-"));
  vi.stubEnv("GPTADMIN_HEALTH_CALLBACK_FILE", join(directory, "health-callback.json"));
  await writeFile(join(directory, "health-callback.json"), JSON.stringify({ url: "http://127.0.0.1:19999", tokens: { project: "project-token" } }), { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const binding = { incidentId: "inc_1", project: "project", planId: "repair" } as const;

function target(overrides: Partial<NoticeplaceHealthTarget> = {}): NoticeplaceHealthTarget {
  return { harness: "opencode", sessionId: "ses_1", cwd: "/work", binding, ...overrides };
}

function details(status: AgentStatus = "idle", lastActivity = new Date().toISOString()): SessionDetails {
  return {
    session: { id: "ses_1", harness: "opencode", status, title: "health", cwd: "/work", lastActivity, needsPermission: false, messageCount: 2, lastMessage: "Продолжаю разбор инцидента" },
    lineage: { kind: "root" },
    children: [],
    messages: [
      { id: "m1", role: "user", text: "почини инцидент", parts: [] },
      { id: "m2", role: "assistant", text: "Продолжаю разбор инцидента", parts: [{ type: "tool_call", name: "bash" }] },
    ],
    history: { source: "acp-load", complete: true },
  };
}

describe("Notice Place health observer", () => {
  it("keeps watching an idle executor and ends the observation only on a terminal status", async () => {
    const published: IncidentProgressUpdate[] = [];
    let status: AgentStatus = "idle";
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details(status),
      // The executor is busy: an idle status alone must not end the observation.
      readActiveTurn: async () => (status === "idle" ? "turn-active" : null),
      publish: async update => { published.push(update); },
      intervalMs: 20,
    });
    await observer.start(target());
    await vi.waitFor(() => expect(published.length).toBeGreaterThanOrEqual(1));
    expect(published.some(update => update.idempotencyKey.includes(":final:"))).toBe(false);
    status = "stopped";
    await vi.waitFor(() => expect(published.some(update => update.idempotencyKey.includes(":final:"))).toBe(true));
    const final = published.find(update => update.idempotencyKey.includes(":final:"))!;
    expect(final.step).toContain("Исполнитель закончил работу");
  });

  it("sends the selected plan of the launch in the progress body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(String(init.method)).toBe("POST");
      expect(String(init.headers as Record<string, string>)).toContain("idempotency-key");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const observer = new NoticeplaceHealthObserver({ readDetails: async () => details(), readActiveTurn: async () => "turn-active", intervalMs: 10_000 });
    await observer.start(target({ binding: { incidentId: "inc_1", project: "project", planId: "verify" } }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { plan_id: string };
    expect(body.plan_id).toBe("verify");
  });

  it("repeats a refused publication instead of losing it", async () => {
    const attempts: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details(),
      readActiveTurn: async () => "turn-active",
      publish: async update => { attempts.push(update.fingerprint); throw new Error("Notice incident progress rejected with HTTP 400"); },
      intervalMs: 10,
      retryIntervalMs: 0,
    });
    await observer.start(target());
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2));
    expect(new Set(attempts).size).toBe(1);
  });

  it("publishes nothing and schedules no new tick after stop() during a pending read", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const published: IncidentProgressUpdate[] = [];
    let reads = 0;
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => { reads += 1; await gate; return details(); },
      publish: async update => { published.push(update); },
      intervalMs: 10,
    });
    await observer.start(target());
    await vi.waitFor(() => expect(reads).toBe(1));
    observer.stop();
    release();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(published).toHaveLength(0);
    expect(reads).toBe(1);
    expect(observer.size).toBe(0);
  });

  it("gives two sessions of one incident different final keys", async () => {
    const published: IncidentProgressUpdate[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("stopped"),
      publish: async update => { published.push(update); },
    });
    await observer.start(target({ sessionId: "ses_a" }));
    await observer.start(target({ sessionId: "ses_b" }));
    await vi.waitFor(() => expect(published.length).toBe(2));
    const finals = published.filter(update => update.idempotencyKey.includes(":final:"));
    expect(finals).toHaveLength(2);
    expect(new Set(finals.map(update => update.idempotencyKey)).size).toBe(2);
  });

  it("reports the reason of a refusal without leaking a token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "health progress requires the selected plan" }), { status: 400, headers: { "content-type": "application/json" } }));
    const sink = createIncidentUpdateSink(process.env, fetchImpl as unknown as typeof fetch);
    await expect(sink.send({ binding, planId: "repair", idempotencyKey: "k", step: "s", evidenceRefs: [], fingerprint: "f" }))
      .rejects.toThrow(/health progress requires the selected plan/);
    const leaky = vi.fn(async () => new Response(JSON.stringify({ error: "unknown health plan: Bearer sk-secret-token-value" }), { status: 400, headers: { "content-type": "application/json" } }));
    const leakySink = createIncidentUpdateSink(process.env, leaky as unknown as typeof fetch);
    const error = await leakySink.send({ binding, planId: "repair", idempotencyKey: "k", step: "s", evidenceRefs: [], fingerprint: "f" }).catch((failure: Error) => failure);
    expect(error.message).toContain("unknown health plan");
    expect(error.message).not.toContain("sk-secret-token-value");
  });

  it("cleans token-shaped substrings out of the published step", () => {
    const step = describeHealthStep({
      status: "running",
      toolNames: ["bash"],
      lastMessageText: "Bearer sk-abcdef0123456789 api_key=supersecretvalue deadbeefdeadbeefdeadbeefdeadbeef",
    })!;
    expect(step).not.toContain("sk-abcdef0123456789");
    expect(step).not.toContain("supersecretvalue");
    expect(step).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(step.length).toBeLessThanOrEqual(HEALTH_STEP_LIMIT);
    expect(step).toContain("Исполнитель работает");
    expect(step).toContain("по данным сессии");
  });

  it("refuses to observe a binding the center does not confirm", async () => {
    const published: IncidentProgressUpdate[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details(),
      validateTarget: async () => "Notice incident inc_1 belongs to another project",
      publish: async update => { published.push(update); },
    });
    expect(await observer.start(target())).toBe("refused");
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(published).toHaveLength(0);
    expect(observer.size).toBe(0);
  });

  it.each([
    ["a missing incident", { status: 404, body: { error: "incident not found" } }],
    ["a foreign project", { status: 200, body: { id: "inc_1", project: "other", state: "open" } }],
    ["a closed incident", { status: 200, body: { id: "inc_1", project: "project", state: "resolved" } }],
  ])("rejects %s at the center", async (_name, answer) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
    await expect(readIncidentBinding(binding, process.env, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(NoticeIncidentBindingError);
    await expect(readIncidentBinding(binding, process.env, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ kind: "rejected" });
  });

  it("arms the armed sessions of the store again after a restart", async () => {
    const path = join(directory, "sessions.json");
    await writeFile(path, JSON.stringify({ version: 1, sessions: [
      { harness: "opencode", sessionId: "ses_alive", cwd: "/work", enabled: true, noticeIncident: { incidentId: "inc_1", project: "project", planId: "repair" } },
      { harness: "opencode", sessionId: "ses_finished", cwd: "/work", enabled: true, noticeIncident: { incidentId: "inc_2", project: "project", planId: "repair" } },
      { harness: "opencode", sessionId: "ses_disarmed", cwd: "/work", enabled: false, noticeIncident: { incidentId: "inc_3", project: "project", planId: "repair" } },
    ] }));
    const candidates = await readArmedHealthCandidates(path);
    expect(candidates.map(candidate => candidate.sessionId)).toEqual(["ses_alive", "ses_finished"]);
    let concurrent = 0;
    let peak = 0;
    const armed: string[] = [];
    const result = await recoverNoticeplaceHealthObservation({
      candidates,
      concurrency: 1,
      batchDelayMs: 0,
      isAlive: async candidate => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise(resolve => setTimeout(resolve, 5));
        concurrent -= 1;
        return candidate.sessionId === "ses_alive";
      },
      arm: candidate => { armed.push(candidate.sessionId); return "started"; },
    });
    expect(armed).toEqual(["ses_alive"]);
    expect(result.armed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(peak).toBe(1);
  });
});

describe("Notice Place health launch policy", () => {
  it("reads the selected plan of the center's launch message", () => {
    expect(resolveLaunchHealthPlan("Apply the plan.\nselected plan verify\nselected plan details (untrusted data): {\"plan_id\":\"verify\"}")?.planId).toBe("verify");
    expect(resolveLaunchHealthPlan("Работай repair-first до результата в этой же native-сессии")?.planId).toBe("repair");
    expect(resolveLaunchHealthPlan("обычное сообщение без плана")).toBeUndefined();
    expect(resolveLaunchHealthPlan("selected plan unknown-plan")?.planId).toBeUndefined();
  });

  it("uses one model allowlist for the analysis and the repair of an incident", () => {
    for (const model of NOTICEPLACE_HEALTH_MODELS) {
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model, operationId: "op" })).toBeUndefined();
    }
    // No other provider is allowed on either path.
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: "zai/GLM-4.6", operationId: "op" })).toBeTruthy();
    // The allowlist is an exact set, not a prefix rule: the approved routes are
    // the OmniRoute gateway routes to the MiniMax M3.1 Flash combos. The paid
    // subscription route is not approved.
    expect([...NOTICEPLACE_HEALTH_MODELS].sort()).toEqual([
      "omniroute/glm-5.3-flash-minimax-m3.1",
      "omniroute/minimax-combo-m3.1",
    ]);
    expect(NOTICEPLACE_HEALTH_MODELS).not.toContain("minimax-coding-plan/MiniMax-M3.1-Flash");
  });
});
