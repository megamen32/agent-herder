import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import { projectWorkKey, sessionWorkKey } from "../src/automation-disarm/work-key.js";
import { setAutomationDisarm, type FleetDisarmTransport } from "../src/automation-disarm/service.js";
import { createNamedSession, newOrResumeNamedSession } from "../src/named-session.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { handleSendMessage } from "../src/mcp-tools/handlers.js";
import {
  dispatchProjectLaunch,
  ProjectLaunchAttemptLog,
  type ProjectLaunchRunner,
} from "../src/automation/project-launch-dispatch.js";
import { validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter } from "../src/types/index.js";

const cleanups: string[] = [];
let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-choke-"));
  cleanups.push(stateDir);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-work-"));
  cleanups.push(dir);
  return realpath(dir);
}

/** A native adapter whose created sessions are countable. */
function fakeAdapter(type: "opencode" | "codex" = "opencode", initial: AgentSession[] = []): { adapter: HarnessAdapter; creates: () => number } {
  const sessions: AgentSession[] = [...initial];
  let creates = 0;
  const adapter: HarnessAdapter = {
    type,
    name: `Fake ${type}`,
    async init() {},
    async listSessions() { return [...sessions]; },
    async getSession(id) { return sessions.find((item) => item.id === id) ?? null; },
    async createSession(options: CreateSessionOptions) {
      creates += 1;
      const created: AgentSession = {
        id: `${type}-${creates}`,
        harness: type,
        status: "idle",
        title: options.name,
        cwd: options.cwd ?? "",
        lastActivity: new Date().toISOString(),
        needsPermission: false,
      };
      sessions.push(created);
      return created;
    },
    async sendMessage() { return { ok: true }; },
    async changeModel() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return { adapter, creates: () => creates };
}

const policy = validateAutomationLaunchPolicy({
  version: 1,
  allowedHarnesses: ["opencode"],
  preferredHarness: "opencode",
  models: { opencode: "minimax-coding-plan/MiniMax-M3.1-Flash" },
});

describe("owner-level automation lever: the launch chokepoint", () => {
  it("keeps human-started work running while automatic runs are forbidden", async () => {
    await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true });
    const { adapter, creates } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);
    const cwd = await workspace();

    // An explicit creation request for one concrete session keeps working.
    const explicit = await createNamedSession(adapters, { harness: "opencode", name: "manual-card", cwd });
    expect(explicit.ok).toBe(true);

    // A run a person started keeps working.
    const human = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "manual-card-2", cwd, message: "продолжай", humanRequested: true,
    });
    expect(human.ok).toBe(true);

    // The automatic run of the same shape is refused, and no executor appears.
    const automatic = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "auto-card", cwd, message: "продолжай",
    });
    expect(automatic.ok).toBe(false);
    expect(automatic.delivery).toBe("not_attempted");
    expect(automatic.error).toContain("запрещён владельцем");
    expect(creates()).toBe(2);
  });

  it("blocks a repeat of the same work under a new session id", async () => {
    const cwd = await workspace();
    const { adapter, creates } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    // The first automatic run of the work is allowed.
    const first = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "work-alpha", cwd, message: "работа", inputId: "operation-1",
    });
    expect(first.ok).toBe(true);
    const firstSessionId = first.sessionId;
    expect(firstSessionId).toBeTruthy();

    // The owner blocks the logical work, not the session id.
    const workKey = sessionWorkKey("opencode", "work-alpha", cwd);
    await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: false, workKeys: [workKey] });

    // The same work under a new operation identity and a new session id is blocked.
    const repeat = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "work-alpha", cwd, message: "работа", inputId: "operation-2",
    });
    expect(repeat.ok).toBe(false);
    expect(repeat.error).toContain("логическому ключу");
    expect(repeat.sessionId).toBeUndefined();
    expect(creates()).toBe(1);

    // The blocked key carries no session id, so a new id cannot escape it.
    expect(workKey).not.toContain(firstSessionId!);
  });

  it("refuses an automatic project dispatch and does not lift the lever", async () => {
    await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true });
    const cwd = await workspace();
    let nativeCalls = 0;
    const run: ProjectLaunchRunner = async (request) => {
      nativeCalls += 1;
      return {
        ok: true, created: true, harness: request.harness, name: request.cwd, cwd: request.cwd,
        delivery: "accepted", inputId: request.inputId,
      };
    };
    const log = new ProjectLaunchAttemptLog(join(stateDir, "attempts.json"));

    const result = await dispatchProjectLaunch(
      { policy, project: "/home/roomhacker/PycharmProjects/TelegramAuto", cwd, message: "запуск" },
      log,
      run,
    );
    expect(result.outcome).toBe("no_harness");
    expect(result.error).toContain("запрещён владельцем");
    expect(result.routingReason).toContain("запрещён владельцем");
    expect(nativeCalls).toBe(0);

    // The automatic attempt did not lift the owner state.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("blocks a re-dispatch of the same project under a new operation id", async () => {
    const cwd = await workspace();
    const project = "/home/roomhacker/PycharmProjects/TelegramAuto";
    await AutomationDisarmStore.forRuntime().apply({
      source: "owner", disarmed: false, workKeys: [projectWorkKey(project)],
    });
    let nativeCalls = 0;
    const run: ProjectLaunchRunner = async (request) => {
      nativeCalls += 1;
      return {
        ok: true, created: true, harness: request.harness, name: request.cwd, cwd: request.cwd,
        delivery: "accepted", inputId: request.inputId,
      };
    };
    const log = new ProjectLaunchAttemptLog(join(stateDir, "attempts.json"));

    const first = await dispatchProjectLaunch(
      { policy, project, cwd, message: "запуск", operationId: "operation-1" }, log, run,
    );
    expect(first.outcome).toBe("no_harness");
    expect(first.error).toContain("логическому ключу");

    const repeat = await dispatchProjectLaunch(
      { policy, project, cwd, message: "запуск", operationId: "operation-2" }, log, run,
    );
    expect(repeat.outcome).toBe("no_harness");
    expect(nativeCalls).toBe(0);
  });

  it("refuses an automatic send and an automatic resume while a human run keeps working", async () => {
    await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true });
    const cwd = await workspace();
    const existing: AgentSession = {
      id: "opencode-existing",
      harness: "opencode",
      status: "idle",
      title: "watched-work",
      cwd,
      lastActivity: new Date().toISOString(),
      needsPermission: false,
    };
    const { adapter } = fakeAdapter("opencode", [existing]);
    const stops = { observe: async () => false, isHeld: async () => false, release: async () => true };
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), {} as never, undefined, {
      humanStopStore: stops as never, autoResumeFailedSessions: false,
    });

    // The automatic send is refused with the reason.
    const automatic = await supervisor.sendMessage("opencode", existing.id, { message: "работа", origin: "automation" });
    expect(automatic.ok).toBe(false);
    expect(automatic.error).toContain("запрещён владельцем");

    // The automatic resume of the same session is refused too.
    const automaticResume = await supervisor.resumeSession("opencode", existing.id, "работа");
    expect(automaticResume.ok).toBe(false);
    expect(automaticResume.error).toContain("запрещён владельцем");

    // The human run keeps working.
    const human = await supervisor.sendMessage("opencode", existing.id, { message: "работа", origin: "human" });
    expect(human.ok).toBe(true);
    const humanResume = await supervisor.resumeSession("opencode", existing.id, "работа", true);
    expect(humanResume.ok).toBe(true);
  });

  it("refuses an automatic send_message tool call while a human one keeps working", async () => {
    await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true });
    const cwd = await workspace();
    const existing: AgentSession = {
      id: "opencode-existing",
      harness: "opencode",
      status: "idle",
      title: "watched-work",
      cwd,
      lastActivity: new Date().toISOString(),
      needsPermission: false,
    };
    const { adapter } = fakeAdapter("opencode", [existing]);
    const adapters = new Map([["opencode", adapter]]);

    // The tool delivers straight to the native adapter, and the lever still holds.
    const automatic = await handleSendMessage(adapters, {
      sessionId: existing.id, harness: "opencode", message: "работа",
    });
    expect(automatic).toContain("запрещён владельцем");

    // A message a person sent keeps working.
    const human = await handleSendMessage(adapters, {
      sessionId: existing.id, harness: "opencode", message: "работа", humanRequested: true,
    });
    expect(human).not.toContain("запрещён владельцем");
  });
});

describe("owner-level automation lever: confirmation across the fleet", () => {
  const state = { version: 1 as const, disarmed: true, changedAt: "", changedBy: "owner" as const, blockedWorkKeys: [] };

  it("names the nodes that confirmed and the nodes that did not", async () => {
    const transport: FleetDisarmTransport = {
      async apply(nodeId) {
        if (nodeId === "server-44") throw new Error("direct_ssh_connect_timeout");
        if (nodeId === "roomhacker-server-88") return { ok: false, reason: "Нода отклонила состояние." };
        return { ok: true, state };
      },
    };
    const result = await setAutomationDisarm({
      disarmed: true,
      scope: "fleet",
      transport,
      peers: ["server-44", "roomhacker-server-88"],
      store: AutomationDisarmStore.forRuntime(),
    });

    // Every node of the fleet is named: a local success is never a fleet success.
    expect(result.nodes.map((node) => node.hostId)).toEqual([
      expect.any(String), "server-44", "roomhacker-server-88",
    ]);
    expect(result.nodes[0]!.status).toBe("confirmed");
    expect(result.nodes[1]!.status).toBe("unreachable");
    expect(result.nodes[1]!.reason).toContain("direct_ssh_connect_timeout");
    expect(result.nodes[2]!.status).toBe("declined");
    expect(result.complete).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("server-44");
    expect(result.reason).toContain("roomhacker-server-88");
  });

  it("reports success only when every node confirmed", async () => {
    const transport: FleetDisarmTransport = {
      async apply() { return { ok: true, state }; },
    };
    const result = await setAutomationDisarm({
      disarmed: true,
      scope: "fleet",
      transport,
      peers: ["server-44", "roomhacker-server-88"],
      store: AutomationDisarmStore.forRuntime(),
    });
    expect(result.nodes.every((node) => node.status === "confirmed")).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.nodes.length).toBe(3);
    // The local runtime really holds the state on disk.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("refuses an automatic attempt to move the lever and still names the nodes", async () => {
    const result = await setAutomationDisarm({
      disarmed: false,
      source: "automation",
      store: AutomationDisarmStore.forRuntime(),
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("только явное действие владельца");
    expect(result.nodes).toBeDefined();
  });
});
