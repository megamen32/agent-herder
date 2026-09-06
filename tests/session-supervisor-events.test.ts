import { describe, expect, it } from "vitest";
import { HerderEventBus, type HerderEvent } from "../src/herder-events.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";
import { HarnessEventHealthRegistry } from "../src/harness-event-health.js";

function session(): AgentSession {
  return {
    id: "external-1", harness: "claude", status: "idle", title: "external", cwd: "/tmp/project",
    lastActivity: "2026-09-06T00:00:00.000Z", needsPermission: false, messageCount: 1,
  };
}

describe("SessionSupervisor domain events", () => {
  it("detects adapter-owned lifecycle changes that did not originate in MCP", async () => {
    const current = session();
    const adapter: HarnessAdapter = {
      type: "claude", name: "fixture",
      async init() {}, async listSessions() { return [{ ...current }]; }, async getSession() { return { ...current }; },
      async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const bus = new HerderEventBus();
    const events: HerderEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const supervisor = new SessionSupervisor(new Map([["claude", adapter]]), { async convert() { return { success: true }; } } as any, undefined, { events: bus, sessionCacheTtlMs: 0 });

    await supervisor.refreshSessions();
    expect(events).toHaveLength(0);
    current.status = "running";
    current.messageCount = 2;
    current.lastActivity = "2026-09-06T00:01:00.000Z";
    await supervisor.refreshSessions();

    expect(events.map((event) => event.uri)).toEqual(expect.arrayContaining([
      "herder://sessions",
      "herder://sessions/claude/external-1",
      "herder://sessions/claude/external-1/messages",
    ]));
  });
  it("bridges native adapter events immediately and suppresses the next polling duplicate", async () => {
    const current = session();
    current.harness = "opencode";
    let listener: ((event: HarnessEvent) => void) | undefined;
    const adapter: HarnessAdapter = {
      type: "opencode", name: "native-fixture",
      subscribeEvents(handler) { listener = handler; return () => { listener = undefined; }; },
      async init() {}, async listSessions() { return [{ ...current }]; }, async getSession() { return { ...current }; },
      async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const bus = new HerderEventBus();
    const health = new HarnessEventHealthRegistry();
    const events: HerderEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { return { success: true }; } } as any, undefined, { events: bus, eventHealth: health, sessionCacheTtlMs: 0 });
    const stop = supervisor.startObservation(60_000);
    await supervisor.refreshSessions();
    events.length = 0;

    current.status = "running";
    current.messageCount = 2;
    listener?.({ kind: "message.updated", harness: "opencode", sessionId: "external-1", nativeType: "message.updated" });
    expect(events.map((event) => event.source)).toContain("native:opencode:message.updated");
    expect(health.get("opencode")).toMatchObject({ mode: "native", connected: true });
    const afterNative = events.length;
    await supervisor.refreshSessions();
    expect(events).toHaveLength(afterNative);
    stop();
  });
  it("cancels the native recovery turn when its job aborts", async () => {
    let nativeCancels = 0;
    const adapter: HarnessAdapter = {
      type: "opencode", name: "recover-fixture",
      async init() {}, async listSessions() { return []; }, async getSession() { return null; },
      async sendMessage() { return { ok: true }; }, async stopSession() { nativeCancels += 1; return { ok: true }; },
      async cancelTurn() { nativeCancels += 1; return { ok: true }; },
      async recover(_id, _message, signal) {
        return new Promise((_, reject) => signal?.addEventListener("abort", () => { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); }, { once: true }));
      },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const lineage = { async get() { return null; }, async recordRecovery() {}, async recordSpawn() {} } as any;
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { return { success: true }; } } as any, lineage);
    const controller = new AbortController();
    const pending = supervisor.recoverSession("opencode", "recover-me", "continue", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; attempt < 20 && nativeCancels === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(nativeCancels).toBeGreaterThan(0);
  });

});
