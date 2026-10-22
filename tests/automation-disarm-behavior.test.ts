import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import { AUTOMATION_FORBIDDEN_CODE, sessionWorkKey } from "../src/automation-disarm/index.js";
import { newOrResumeNamedSession } from "../src/named-session.js";
import { handleNewOrResume } from "../src/mcp-tools/handlers.js";
import { createWebServer } from "../src/web/server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { HUMAN_STOP_MESSAGE } from "../src/human-stop-actions.js";
import type { Server } from "node:http";
import type { AgentSession, CreateSessionOptions, HarnessAdapter } from "../src/types/index.js";

const cleanups: string[] = [];
const servers: Server[] = [];
let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-behavior-"));
  cleanups.push(stateDir);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

/** A real project directory, so the scope and the request agree. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-behavior-"));
  cleanups.push(dir);
  return realpath(dir);
}

/** The source of one file of this repository. */
async function source(relative: string): Promise<string> {
  return readFile(new URL(`../${relative}`, import.meta.url), "utf8");
}

describe("the owner lever: what a prohibition does", () => {
  it("refuses a new launch in the forbidden area with the stable code", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter, creates } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    const automatic = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "auto-card", cwd: area, message: "работа", inputId: "operation-1",
    });
    expect(automatic.ok).toBe(false);
    expect(automatic.delivery).toBe("not_attempted");
    // The refusal carries the stable code next to the human text.
    expect(automatic.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(automatic.failureCode).toBe("automation_disabled");
    // The area travels in its own field, beside the code.
    expect(automatic.routingReasonDetail).toBe(area);
    expect(automatic.error).toContain("запрещён владельцем");
    expect(automatic.error).not.toBe(HUMAN_STOP_MESSAGE);
    // A retry of a forbidden launch is pointless, so it is not retryable.
    expect(automatic.nonRetryable).toBe(true);
    expect(creates()).toBe(0);
  });

  it("creates no session for a repeat of the same request", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter, creates } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    const first = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "auto-card", cwd: area, message: "работа", inputId: "operation-1",
    });
    const repeat = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "auto-card", cwd: area, message: "работа", inputId: "operation-2",
    });
    expect(first.ok).toBe(false);
    expect(repeat.ok).toBe(false);
    expect(repeat.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
    // Neither attempt created an executor.
    expect(creates()).toBe(0);
  });

  it("keeps the prohibition through an automatic resume after a restart", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const existing: AgentSession = {
      id: "opencode-existing",
      harness: "opencode",
      status: "idle",
      title: "watched-work",
      cwd: area,
      lastActivity: new Date().toISOString(),
      needsPermission: false,
    };
    const { adapter } = fakeAdapter("opencode", [existing]);
    const stops = { observe: async () => false, isHeld: async () => false, release: async () => true };
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), {} as never, undefined, {
      humanStopStore: stops as never, autoResumeFailedSessions: false,
    });

    const automatic = await supervisor.resumeSession("opencode", existing.id, "работа");
    expect(automatic.ok).toBe(false);
    expect(automatic.error).toContain("запрещён владельцем");
    // The prohibition is still exactly where the owner put it.
    const state = await AutomationDisarmStore.forRuntime().read();
    expect(state.records.find((record) => record.scope === area)?.forbidden).toBe(true);
  });

  it("keeps the prohibition in the launcher of unfinished sessions", async () => {
    // The launcher starts new work on its own, so it asks the lever before it
    // creates anything: the check stands in front of the creation.
    const launcher = await source("src/autopilot/unfinished-session-launcher.ts");
    const guard = launcher.indexOf("automationDisarmDecision(");
    const creation = launcher.indexOf("primary.adapter.createSession(");
    expect(guard).toBeGreaterThan(-1);
    expect(creation).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(creation);
  });

  it("is lifted only by an explicit owner action", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    // The automatic run is refused and does not touch the owner state.
    const automatic = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "auto-card", cwd: area, message: "работа",
    });
    expect(automatic.ok).toBe(false);
    const afterRun = await AutomationDisarmStore.forRuntime().read();
    expect(afterRun.records.find((record) => record.scope === area)?.forbidden).toBe(true);

    // An automatic attempt to change the state is refused as well.
    const attempt = await AutomationDisarmStore.forRuntime().applyRecord({
      source: "automation", scope: area, forbidden: false,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe("automation_cannot_change_disarm");
    const afterAttempt = await AutomationDisarmStore.forRuntime().read();
    expect(afterAttempt.records.find((record) => record.scope === area)?.forbidden).toBe(true);
  });

  it("keeps a human-started run working", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter, creates } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    const human = await newOrResumeNamedSession(adapters, {
      harness: "opencode", name: "manual-card", cwd: area, message: "продолжай", humanRequested: true,
    });
    expect(human.ok).toBe(true);
    expect(creates()).toBe(1);
  });
});

describe("the owner lever: the code in the answer of a launch", () => {
  it("carries the code in the body of the MCP launch call", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter } = fakeAdapter();
    const adapters = new Map([["opencode", adapter]]);

    const raw = await handleNewOrResume(adapters, {
      harness: "opencode", name: "auto-card", cwd: area, message: "работа",
    });
    const body = JSON.parse(raw) as {
      ok: boolean; failureCode?: string; routingReasonDetail?: string; error?: string; nonRetryable?: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(body.failureCode).toBe("automation_disabled");
    // The area travels in its own field, beside the code.
    expect(body.routingReasonDetail).toBe(area);
    expect(body.routingReasonDetail).toBeTruthy();
    // The wording is not the carrier of the area.
    expect(body.error).not.toContain(area);
    expect(body.error).toContain("запрещён владельцем");
    expect(body.nonRetryable).toBe(true);
  });

  it("carries the code in the body of the HTTP launch call", async () => {
    const area = await workspace();
    await AutomationDisarmStore.forRuntime().applyRecord({ source: "owner", scope: area, forbidden: true });
    const { adapter } = fakeAdapter();
    const server = createWebServer({
      adapters: new Map([["opencode", adapter]]),
      converter: { async convert() { throw new Error("unused"); } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/new-or-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "opencode", name: "auto-card", cwd: area, message: "работа" }),
    });
    expect(response.status).not.toBe(200);
    const body = await response.json() as {
      ok: boolean; failureCode?: string; routingReasonDetail?: string; error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(body.failureCode).toBe("automation_disabled");
    // The area travels in its own field, beside the code.
    expect(body.routingReasonDetail).toBe(area);
    expect(body.routingReasonDetail).toBeTruthy();
    // The wording is not the carrier of the area.
    expect(body.error).not.toContain(area);
    expect(body.error).toContain("запрещён владельцем");
  });
});

describe("the owner lever: what it does not touch", () => {
  it("does not touch the events, the incidents and the notifications", async () => {
    // The lever stands in the admission of a session and nowhere else. The
    // event bus, the incident binding and the delivery of notifications live
    // on the mesh and the centre side, so they never read the owner state.
    for (const relative of [
      "src/herder-events.ts",
      "src/autopilot/notice-incident.ts",
      "src/user-message-delivery.ts",
    ]) {
      const text = await source(relative);
      expect(text, relative).not.toContain("automation-disarm");
      expect(text, relative).not.toContain("AutomationDisarmStore");
    }
  });

  it("keeps the lever out of the admission of a human run", async () => {
    // The admission path of a human run never asks the lever: a person is
    // not automation, and the lever would only slow a person down.
    const named = await source("src/named-session.ts");
    const human = named.indexOf('request.humanRequested === true ? "human" : "automation"');
    expect(human).toBeGreaterThan(-1);
  });
});
