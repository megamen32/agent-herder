import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateAutomationLaunchPolicy, type AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import {
  attemptInputId,
  dispatchProjectLaunch,
  namedSessionRunner,
  outcomeOf,
  ProjectLaunchAttemptLog,
} from "../src/automation/project-launch-dispatch.js";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter } from "../src/types/index.js";
import type { NamedSessionResult } from "../src/named-session.js";

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  // Never touch the live human-stop store while dispatching fake harnesses.
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-project-launch-stops-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(dir, "human-stops.json"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-project-launch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The named-session seam resolves a real workspace path. */
async function workspace(): Promise<string> {
  return await root();
}

const policy = validateAutomationLaunchPolicy({
  version: 1,
  allowedHarnesses: ["codex", "zcode", "opencode"],
  preferredHarness: "codex",
  models: { codex: "gpt-6.1-sol", zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high", opencode: "minimax-coding-plan/MiniMax-M3.1-Flash" },
  projectRoutes: {
    "/home/roomhacker/PycharmProjects/TelegramAuto": { harnesses: ["opencode", "zcode"], aliases: ["tg-commentator", "autotelegramviews"] },
    "/home/roomhacker/PycharmProjects/AutoFindClient": { harnesses: ["codex", "zcode", "opencode"] },
  },
});

type Outcome = "accepted" | "quota" | "unavailable" | "unknown";
type Delivery = { harness: string; inputId?: string };

/** A typed native adapter whose real attempt outcome the test controls. */
function nativeAdapter(type: "opencode" | "zcode" | "codex", outcome: Outcome, log: Array<{ harness: string; inputId?: string }>, cwd: string): HarnessAdapter {
  let created = 0;
  return {
    type,
    name: `${type} fake native`,
    async init() {},
    async listSessions() { return []; },
    async getSession() { return null; },
    async createSession(options: CreateSessionOptions) {
      created += 1;
      return {
        id: `${type}-${created}`, harness: type, status: "idle", title: "launch", cwd: options.cwd ?? cwd,
        lastActivity: new Date().toISOString(), needsPermission: false,
      } as AgentSession;
    },
    async changeModel() { return { ok: true }; },
    async sendMessage(_id, options) {
      log.push({ harness: type, ...(options.inputId ? { inputId: options.inputId } : {}) });
      void cwd;
      if (outcome === "accepted") return { ok: true };
      if (outcome === "unknown") return { ok: false, admissionUnknown: true, nonRetryable: true, error: "admission unknown" };
      if (outcome === "quota") return { ok: false, nonRetryable: true, error: "quota exhausted for account" };
      return { ok: false, nonRetryable: true, error: "native runtime unavailable" };
    },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

describe("project launch dispatch", () => {
  it.each([
    { ok: true, admitted: true, delivery: "accepted" as const, pending: false },
    { ok: true, admitted: false, delivery: "accepted_unconfirmed" as const, pending: true },
    { ok: false, admitted: true, delivery: "accepted_failed" as const, nonRetryable: true, error: "native failed" },
    { ok: false, admissionUnknown: true, nonRetryable: true, pending: true, error: "receipt lost" },
  ])("preserves the full existing-session receipt on first response and restart replay: %j", async (status) => {
    const dir = await root();
    const path = join(dir, "attempts.json");
    const input = { policy, project: "tg-commentator", message: "repair", operationId: "existing" };
    const run = vi.fn(async (request: Parameters<import("../src/automation/project-launch-dispatch.js").ProjectLaunchRunner>[0]): Promise<NamedSessionResult> => ({
      ...status, created: false, harness: request.harness, name: "original", cwd: request.cwd,
      sessionId: "native-existing", inputId: request.inputId, turnId: "native-turn", model: request.model,
    }));
    const first = await dispatchProjectLaunch(input, new ProjectLaunchAttemptLog(path), run);
    const native = await run.mock.results[0]!.value;
    expect(first).toMatchObject({ ...native, mode: "resume" });
    const replay = await dispatchProjectLaunch({ ...input, project: "/home/roomhacker/PycharmProjects/TelegramAuto/" }, new ProjectLaunchAttemptLog(path), run);
    expect(replay).toEqual(first);
    // A concurrent caller can read before completion and reserve after it.
    const raced = new ProjectLaunchAttemptLog(path);
    vi.spyOn(raced, "attempts").mockResolvedValueOnce([]);
    expect(await dispatchProjectLaunch(input, raced, run)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("maps a real named-session result onto a launch outcome", () => {
    expect(outcomeOf({ ok: true, created: true, harness: "opencode", name: "n", cwd: "/w", delivery: "accepted" })).toBe("accepted");
    expect(outcomeOf({ ok: false, created: true, harness: "opencode", name: "n", cwd: "/w", admitted: true, delivery: "accepted_failed", error: "turn failed" })).toBe("accepted");
    expect(outcomeOf({ ok: false, created: true, harness: "opencode", name: "n", cwd: "/w", admissionUnknown: true, nonRetryable: true, error: "unknown" })).toBe("admission_unknown");
    expect(outcomeOf({ ok: false, created: false, harness: "opencode", name: "n", cwd: "/w", delivery: "not_attempted", error: "Чат явно остановлен. Автопродолжение заблокировано; требуется новое сообщение человека или явное продолжение." })).toBe("human_hold");
    expect(outcomeOf({ ok: false, created: true, harness: "opencode", name: "n", cwd: "/w", nonRetryable: true, error: "quota exhausted" })).toBe("pre_admission_rejected");
  });

  it("advances to the next harness only after a definite pre-admission failure", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["opencode", nativeAdapter("opencode", "quota", attempts, cwd)],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "tg-commentator",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-quota",
    }, log, namedSessionRunner(adapters, "tg-repair"));

    // The quota on OpenCode advanced to ZCode, which accepted exactly once.
    expect(result.attempts.map((attempt) => [attempt.harness, attempt.outcome])).toEqual([["opencode", "pre_admission_rejected"], ["zcode", "accepted"]]);
    expect(result).toMatchObject({ outcome: "accepted", selectedHarness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high", mode: "create" });
    expect(result.routingReason).toContain("не запустилась до подтверждения приёма");
    expect(result.routingReason).toContain("Выбираем следующую среду маршрута");
    expect(result.attempts[0]?.reason).toContain("quota exhausted");
    expect(result.sessionId).toBe("zcode-1");
    expect(attempts.map((entry) => entry.harness)).toEqual(["opencode", "zcode"]);
    expect(attempts[0]?.inputId).toBe(attemptInputId("op-quota", "opencode"));
    expect(attempts[1]?.inputId).toBe(attemptInputId("op-quota", "zcode"));
  });

  it("stops on an unknown admission and never starts a second executor", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["codex", nativeAdapter("codex", "unknown", attempts, cwd)],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)],
      ["opencode", nativeAdapter("opencode", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "/home/roomhacker/PycharmProjects/AutoFindClient",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-unknown",
    }, log, namedSessionRunner(adapters, "af-repair"));

    expect(result).toMatchObject({ outcome: "admission_unknown", selectedHarness: "codex", model: "gpt-6.1-sol" });
    expect(result.routingReason).toContain("не подтвердил приём запуска");
    expect(attempts.map((entry) => entry.harness)).toEqual(["codex"]);

    // A repeated callback for the same operation reports the same stop.
    const repeated = await dispatchProjectLaunch({
      policy,
      project: "/home/roomhacker/PycharmProjects/AutoFindClient",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-unknown",
    }, log, namedSessionRunner(adapters, "af-repair"));
    expect(repeated).toMatchObject({ outcome: "admission_unknown", selectedHarness: "codex" });
    expect(attempts).toHaveLength(1);
  });

  it("stops when a human hold blocks the launch", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const held = nativeAdapter("opencode", "accepted", attempts, cwd);
    held.sendMessage = async () => ({ ok: false, nonRetryable: true, error: "Чат явно остановлен. Автопродолжение заблокировано; требуется новое сообщение человека или явное продолжение." });
    held.changeModel = async () => ({ ok: true });
    const adapters = new Map<string, HarnessAdapter>([
      ["opencode", held],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "autotelegramviews",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-hold",
    }, log, namedSessionRunner(adapters, "tg-hold"));

    expect(result).toMatchObject({ outcome: "human_hold", selectedHarness: "opencode" });
    expect(result.routingReason).toContain("остановлена человеком");
    // The route stops at the held session: ZCode is never attempted.
    expect(result.attempts).toMatchObject([{ harness: "opencode", outcome: "human_hold" }]);
    expect(result.attempts.map((attempt) => attempt.harness)).not.toContain("zcode");
  });

  it("uses the default runtime for a project without a route and reports the reason", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["codex", nativeAdapter("codex", "accepted", attempts, cwd)],
      ["opencode", nativeAdapter("opencode", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "/home/roomhacker/PycharmProjects/AutoSellBot",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-default",
    }, log, namedSessionRunner(adapters, "other"));

    expect(result).toMatchObject({ outcome: "accepted", selectedHarness: "codex", model: "gpt-6.1-sol", mode: "create" });
    expect(result.routingReason).toContain("нет маршрута");
    expect(attempts.map((entry) => entry.harness)).toEqual(["codex"]);
  });

  it("reports a handoff request instead of cloning a live session of another harness", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["codex", nativeAdapter("codex", "quota", attempts, cwd)],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "/home/roomhacker/PycharmProjects/AutoFindClient",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-handoff",
    }, log, namedSessionRunner(adapters, "af-handoff"));

    // ZCode runs after the Codex quota failure. A live Codex session means the
    // caller must use the existing handoff, not a silent clone.
    expect(result).toMatchObject({ outcome: "accepted", selectedHarness: "zcode", sessionId: "zcode-1" });
    expect(result.mode).toBe("create");
    const resolution = await import("../src/automation-launch-policy.js").then((module) => module.resolveProjectLaunch(policy, {
      project: "/home/roomhacker/PycharmProjects/AutoFindClient",
      attempted: ["codex"],
      outcome: "pre_admission_rejected",
      activeSession: { harness: "codex", sessionId: "codex-7" },
    }));
    expect(resolution).toMatchObject({ mode: "handoff", sessionId: "codex-7", fromHarness: "codex" });
  });

  it("lets a configured route override the profile harness, model and workspace", async () => {
    const dir = await root();
    const profileCwd = await workspace();
    const routeCwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["codex", nativeAdapter("codex", "accepted", attempts, routeCwd)],
      ["opencode", nativeAdapter("opencode", "accepted", attempts, routeCwd)],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, routeCwd)],
    ]);
    const routed = validateAutomationLaunchPolicy({
      ...policy,
      projectRoutes: { [routeCwd]: { harnesses: ["codex", "zcode", "opencode"] } },
    });

    // The Notice profile still defaults to OpenCode/MiniMax and its own cwd.
    const result = await dispatchProjectLaunch({
      policy: routed,
      project: routeCwd,
      cwd: profileCwd,
      message: "Исправить инцидент",
      harness: "opencode",
      model: "minimax-coding-plan/MiniMax-M3.1-Flash",
      operationId: "op-profile",
    }, log, namedSessionRunner(adapters, "af-profile"));

    expect(result).toMatchObject({
      outcome: "accepted",
      selectedHarness: "codex",
      model: "gpt-6.1-sol",
      project: routeCwd,
    });
    expect(result.routingReason).toContain(`рабочую папку ${routeCwd}`);
    expect(result.routingReason).toContain("Профиль предлагал OpenCode");
    expect(result.routingReason).toContain("маршрут проекта выбирает Codex");
    expect(result.routingReason).toContain("Модель профиля minimax-coding-plan/MiniMax-M3.1-Flash проигнорирована");
    expect(attempts.map((entry) => entry.harness)).toEqual(["codex"]);
  });

  it("uses the profile only for a project without a configured route", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["opencode", nativeAdapter("opencode", "accepted", attempts, cwd)],
      ["codex", nativeAdapter("codex", "accepted", attempts, cwd)],
    ]);

    const result = await dispatchProjectLaunch({
      policy,
      project: "/home/roomhacker/PycharmProjects/AutoSellBot",
      cwd,
      message: "Исправить инцидент",
      harness: "opencode",
      model: "minimax-coding-plan/MiniMax-M3.1-Flash",
      operationId: "op-unconfigured",
    }, log, namedSessionRunner(adapters, "other"));

    expect(result).toMatchObject({ outcome: "accepted", selectedHarness: "opencode", model: "minimax-coding-plan/MiniMax-M3.1-Flash" });
    expect(result.routingReason).toContain("используется профиль OpenCode");
  });

  it("reserves the attempt before the native call and never launches it twice", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([["opencode", nativeAdapter("opencode", "accepted", attempts, cwd)]]);

    // A crash after the reservation leaves a durable in-flight attempt.
    const crashed = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const reservation = await crashed.reserve(policy.projectRoutes!["/home/roomhacker/PycharmProjects/TelegramAuto"].harnesses ? "/home/roomhacker/PycharmProjects/TelegramAuto" : "", "op-crash", { harness: "opencode", inputId: attemptInputId("op-crash", "opencode"), mode: "sync" });
    expect(reservation).toMatchObject({ claimed: true });
    expect(reservation.record).toMatchObject({ outcome: "in_flight", harness: "opencode" });

    const result = await dispatchProjectLaunch({
      policy,
      project: "tg-commentator",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-crash",
    }, crashed, namedSessionRunner(adapters, "tg-crash"));

    expect(result).toMatchObject({ outcome: "in_flight", selectedHarness: "opencode" });
    expect(result.routingReason).toContain("уже зарезервирован");
    expect(attempts).toHaveLength(0);
  });

  it("never posts twice to a harness without native input deduplication", async () => {
    const dir = await root();
    const cwd = await workspace();
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([["opencode", nativeAdapter("opencode", "accepted", attempts, cwd)]]);
    const routeCwd = await workspace();
    const routed = validateAutomationLaunchPolicy({
      ...policy,
      projectRoutes: { [routeCwd]: { harnesses: ["opencode"] } },
    });

    // Two concurrent callers of the same operation. OpenCode has no native
    // input-id dedup, so only the durable claim can prevent a second POST.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = dispatchProjectLaunch({
      policy: routed, project: routeCwd, cwd: routeCwd, message: "Исправить", operationId: "op-concurrent",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), async (request) => {
      entered();
      await gate;
      return await namedSessionRunner(adapters, "tg")(request);
    });
    await started;
    const second = dispatchProjectLaunch({
      policy: routed, project: routeCwd, cwd: routeCwd, message: "Исправить", operationId: "op-concurrent",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), namedSessionRunner(adapters, "tg"));
    const secondResult = await second.finally(release);
    const firstResult = await first;

    expect(attempts).toHaveLength(1);
    expect(secondResult).toMatchObject({ outcome: "in_flight", selectedHarness: "opencode" });
    expect(secondResult.routingReason).toMatch(/уже зарезервирован|уже выполняется другим вызовом/);
    expect(firstResult).toMatchObject({ outcome: "accepted", selectedHarness: "opencode" });
    expect(firstResult.attempts).toMatchObject([{ harness: "opencode", created: true, model: "minimax-coding-plan/MiniMax-M3.1-Flash", mode: "sync" }]);
  });

  it("replays the full receipt of a completed attempt", async () => {
    const dir = await root();
    const cwd = await workspace();
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)]]);

    const first = await dispatchProjectLaunch({
      policy, project: "tg-commentator", cwd, message: "Исправить инцидент", operationId: "op-receipt",
    }, log, namedSessionRunner(adapters, "tg-receipt"));
    const replay = await dispatchProjectLaunch({
      policy, project: "tg-commentator", cwd, message: "Исправить инцидент", operationId: "op-receipt",
    }, log, namedSessionRunner(adapters, "tg-receipt"));

    expect(replay).toMatchObject({
      outcome: "accepted",
      selectedHarness: "zcode",
      model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      sessionId: "zcode-1",
    });
    const accepted = replay.attempts[replay.attempts.length - 1]!;
    expect(accepted).toMatchObject({
      harness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high", mode: "sync",
      delivery: "completed", created: true,
    });
    expect(replay.mode).toBe("create");
    expect(first.attempts.map((attempt) => attempt.inputId)).toEqual(replay.attempts.map((attempt) => attempt.inputId));
    expect(attempts).toHaveLength(1);
  });

  it("serves the real HTTP dispatch contract with a user-visible routing reason", async () => {
    const dir = await root();
    const cwd = await workspace();
    const attempts: Array<{ harness: string; inputId?: string }> = [];
    const adapters = new Map<string, HarnessAdapter>([
      ["opencode", nativeAdapter("opencode", "unavailable", attempts, cwd)],
      ["zcode", nativeAdapter("zcode", "accepted", attempts, cwd)],
    ]);
    const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));

    const server = createWebServer({
      adapters,
      converter: { async convert() { throw new Error("unused"); } },
      projectLaunchDispatch: async (request) => {
        const result = await dispatchProjectLaunch(
          { policy, ...request, name: request.name ?? "tg-http" },
          log,
          namedSessionRunner(adapters, request.name ?? "tg-http"),
        );
        return result;
      },
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/automation/project-launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "tg-commentator", cwd, message: "Исправить инцидент", operation_id: "op-http" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      outcome: string; selectedHarness: string; model: string; routingReason: string; attempts: Array<{ harness: string; outcome: string }>; sessionId?: string;
    };
    expect(body.outcome).toBe("accepted");
    expect(body.selectedHarness).toBe("zcode");
    expect(body.model).toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
    expect(body.sessionId).toBe("zcode-1");
    expect(body.routingReason).toMatch(/OpenCode[\s\S]*ZCode|ZCode/);
    expect(body.attempts.map((attempt) => [attempt.harness, attempt.outcome])).toEqual([["opencode", "pre_admission_rejected"], ["zcode", "accepted"]]);
    expect(attempts.map((entry) => entry.harness)).toEqual(["opencode", "zcode"]);

    // Repeating the same operation is answered from the durable attempt log.
    const repeat = await fetch(`http://127.0.0.1:${address.port}/api/automation/project-launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "tg-commentator", cwd, message: "Исправить инцидент", operation_id: "op-http" }),
    });
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toMatchObject({ outcome: "accepted", selectedHarness: "zcode" });
    expect(attempts).toHaveLength(2);
  });
});
