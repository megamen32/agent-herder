import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session autostart settings HTTP", () => {
  it("defaults on independently and exposes global plus per-session opt-out", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-session-autostart-http-"));
    const store = new SessionAutostartStore(join(root, "settings.json"), {});
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      sessionAutostartStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;

    await expect((await fetch(`${origin}/api/session-autostart`)).json()).resolves.toMatchObject({ version: 8, enabled: true, waitForQuota: false, waitForQuotaSource: "default", pinActiveSessions: true, rolloverExpiredCache: false, movePinnedOnRollover: false, inventoryWindowHours: 48, evidenceMessageCount: 200, recoverOnFailure: true, recoverOnDisconnect: true, watchdogEnabled: false, watchdogIntervalSeconds: 10, stalledTurnMinutes: 2, source: "default" });
    const runtimeBody = { enabled: false, pinActiveSessions: false, rolloverExpiredCache: false, movePinnedOnRollover: false, inventoryWindowHours: 72, evidenceMessageCount: 4, watchdogEnabled: false, watchdogIntervalSeconds: 30, stalledTurnMinutes: 5, judgeModel: "MiniMax-M3", autopilotJudgeModel: "gpt-test" };
    const runtimeSaved = await fetch(`${origin}/api/session-autostart`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runtimeBody),
    });
    await expect(runtimeSaved.json()).resolves.toMatchObject({ version: 8, enabled: false, pinActiveSessions: false, rolloverExpiredCache: false, movePinnedOnRollover: false, inventoryWindowHours: 72, evidenceMessageCount: 4, recoverOnFailure: true, recoverOnDisconnect: true, watchdogEnabled: false, watchdogIntervalSeconds: 30, stalledTurnMinutes: 5, judgeModel: "MiniMax-M3", autopilotJudgeModel: "gpt-test", source: "persisted" });
    await expect((await fetch(`${origin}/api/session-autostart`)).json()).resolves.toMatchObject({ enabled: false, rolloverExpiredCache: false, recoverOnFailure: true, recoverOnDisconnect: true, source: "persisted" });
    const recoverySaved = await fetch(`${origin}/api/session-autostart`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...runtimeBody, recoverOnFailure: false, recoverOnDisconnect: false }),
    });
    await expect(recoverySaved.json()).resolves.toMatchObject({ recoverOnFailure: false, recoverOnDisconnect: false, source: "persisted" });
    const invalidRecovery = await fetch(`${origin}/api/session-autostart`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...runtimeBody, recoverOnFailure: "yes" }),
    });
    expect(invalidRecovery.status).toBe(400);
    await expect(invalidRecovery.json()).resolves.toMatchObject({ error: "autocontinue recovery settings must be boolean" });
    const zcodeHarness = `${origin}/api/session-autostart/harnesses/zcode`;
    await expect((await fetch(zcodeHarness)).json()).resolves.toMatchObject({ harness: "zcode", enabled: false, source: "global" });
    await fetch(zcodeHarness, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    await expect((await fetch(zcodeHarness)).json()).resolves.toMatchObject({ harness: "zcode", enabled: false, source: "harness" });
    const zcode = `${origin}/api/session-autostart/sessions/zcode/session-1?cwd=${encodeURIComponent("/workspace/zcode")}`;
    await expect((await fetch(zcode)).json()).resolves.toMatchObject({ enabled: false, source: "harness" });

    await fetch(zcode, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, cwd: "/workspace/zcode" }),
    });
    await expect((await fetch(zcode)).json()).resolves.toMatchObject({ enabled: false, source: "session" });

    await fetch(`${origin}/api/session-autostart`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const codex = `${origin}/api/session-autostart/sessions/codex/codex-1?cwd=${encodeURIComponent("/workspace/codex")}`;
    await expect((await fetch(codex)).json()).resolves.toMatchObject({ enabled: false, source: "global" });
    await expect((await fetch(zcode, { method: "DELETE" })).json()).resolves.toMatchObject({ enabled: false, source: "harness" });
    await expect((await fetch(zcodeHarness, { method: "DELETE" })).json()).resolves.toMatchObject({ enabled: false, source: "global" });
  });

  it("exposes inherited waitForQuota settings independently and serves exact-session wait state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-quota-http-"));
    directories.push(root);
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { id: "quota-session", harness: "opencode" as const, cwd: "/workspace/quota", title: "Quota", model: "omniroute/openai/current", status: "error" as const, lastActivity: new Date().toISOString(), needsPermission: false };
    const evidence = { classification: "quota_exhausted" as const, nativeTurnId: "turn-1", inputId: "input-1", providerId: "omniroute", modelId: "openai/current" };
    await store.markQuotaRecoveryEligible(session, evidence, ["omniroute/anthropic/fallback"]);
    const launcher = new UnfinishedSessionLauncher({ adapters: new Map(), store, settingsStore: settings });
    const supervisor = new SessionSupervisor(new Map(), { async convert() { throw new Error("unused"); } }, undefined, { unfinishedSessions: launcher });
    const server = createWebServer({ adapters: new Map(), converter: { async convert() { throw new Error("unused"); } }, sessionAutostartStore: settings, supervisor });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/api/session-autostart/harnesses/opencode`;
    await expect((await fetch(url)).json()).resolves.toMatchObject({ enabled: true, waitForQuota: false, waitForQuotaSource: "default" });
    await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ waitForQuota: true }) });
    await expect((await fetch(url)).json()).resolves.toMatchObject({ enabled: true, waitForQuota: true, waitForQuotaSource: "harness", waitForQuotaOverride: true });
    const sessionSettings = `${origin}/api/session-autostart/sessions/opencode/quota-session?cwd=${encodeURIComponent(session.cwd)}`;
    const statusUrl = `${origin}/api/quota-recovery/waits?harness=opencode&sessionId=quota-session&cwd=${encodeURIComponent(session.cwd)}`;
    await expect((await fetch(statusUrl)).json()).resolves.toMatchObject({ wait: { state: "waiting", currentModel: "omniroute/openai/current" } });
    await fetch(sessionSettings, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ waitForQuota: false, cwd: session.cwd }) });
    await expect((await fetch(sessionSettings)).json()).resolves.toMatchObject({ enabled: true, waitForQuota: false, waitForQuotaSource: "session", waitForQuotaOverride: false });
    await expect((await fetch(statusUrl)).json()).resolves.toEqual({ wait: null });
  });
});
