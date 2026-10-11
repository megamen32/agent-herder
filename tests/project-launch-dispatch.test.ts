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
  models: { codex: "gpt-6.1-sol", zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high", opencode: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview" },
  projectRoutes: {
    "/home/roomhacker/PycharmProjects/TelegramAuto": { harnesses: ["opencode", "zcode"], aliases: ["tg-commentator", "autotelegramviews"] },
    "/home/roomhacker/PycharmProjects/AutoFindClient": { harnesses: ["codex", "zcode", "opencode"] },
  },
});

type Outcome = "accepted" | "quota" | "unavailable" | "unknown";

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