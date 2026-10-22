import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session autostart settings HTTP", () => {
  it("saves four explicit quota modes, retains off after legacy migration, and clears mode inheritance", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-mode-http-"));
    directories.push(root);
    const store = new SessionAutostartStore(join(root,"settings.json"),{});
    const server = createWebServer({adapters:new Map(),converter:{async convert(){throw new Error("unused");}},sessionAutostartStore:store});
    servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address = server.address(); if(!address || typeof address === "string") throw new Error("no address");
    const origin = `http://127.0.0.1:${address.port}`;
    const harness = `${origin}/api/session-autostart/harnesses/zcode`;
    const session = `${origin}/api/session-autostart/sessions/zcode/owned?cwd=/owned`;
    const put = (url:string,body:unknown)=>fetch(url,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    await expect((await fetch(harness)).json()).resolves.toMatchObject({fallbackForQuota:false,waitForQuota:false});
    for(const [fallbackForQuota,waitForQuota] of [[false,false],[true,false],[false,true],[true,true]]) {
      const response = await put(harness,{fallbackForQuota,waitForQuota});
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({fallbackForQuota,waitForQuota,waitForQuotaSource:"harness"});
    }
    await put(session,{cwd:"/owned",waitForQuota:false});
    await expect((await fetch(session)).json()).resolves.toMatchObject({fallbackForQuota:true,waitForQuota:false,waitForQuotaSource:"session"});
    await put(session,{cwd:"/owned",fallbackForQuota:false,waitForQuota:true});
    await expect((await fetch(session)).json()).resolves.toMatchObject({fallbackForQuota:false,waitForQuota:true,waitForQuotaSource:"session"});
    await put(session,{cwd:"/owned",fallbackForQuota:null,waitForQuota:null});
    await expect((await fetch(session)).json()).resolves.toMatchObject({fallbackForQuota:true,waitForQuota:true,waitForQuotaSource:"harness"});
  });

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

  it("serves only the exact read-only OpenCode OmniRoute leaf proof from the process-owned adapter", async () => {
    const resolver = {
      async resolveModelProviderLeaves(nativeModelId: string) {
        return {
          nativeHarness: "opencode",
          nativeModelId,
          resolvedProviderLeaves: [
            { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
            { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
          ],
        };
      },
    };
    const server = createWebServer({
      adapters: new Map([["opencode", resolver as never]]),
      converter: { async convert() { throw new Error("unused"); } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/native-model-route-proof?modelId=${encodeURIComponent("omniroute/minimax-combo-m3.1")}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      nativeHarness: "opencode",
      nativeModelId: "omniroute/minimax-combo-m3.1",
      resolvedProviderLeaves: [
        { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
        { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
      ],
    });
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/native-model-route-proof?modelId=${encodeURIComponent("openai-codex/codex-mini")}`);
    expect(invalid.status).toBe(400);
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

  it("exposes a product enrollment route and read-only HumanStop state for exact sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-operator-cohort-http-"));
    directories.push(root);
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    const launchPolicy = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
    const configuredModel = "omniroute/minimax-combo-m3.1";
    await launchPolicy.replace({
      version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode", models: { opencode: configuredModel },
      fallbackModels: { opencode: [configuredModel] },
    });
    let current = {
      id: "operator-api-session", harness: "opencode" as const, cwd: "/workspace/quota", title: "Cohort task",
      model: "zai-coding-plan/glm-5.3-flash", status: "idle" as const, lastActivity: new Date().toISOString(), needsPermission: false,
      meta: { nativeLastTurn: {
        sessionId: "operator-api-session", turnId: "native-turn-api", assistantMessageId: "assistant-api",
        providerId: "zai-coding-plan", modelId: "glm-5.3-flash", status: "failed", completedAt: Date.now() - 30_000,
      } },
    };
    const messages: Array<{ model?: string; inputId?: string }> = [];
    const adapter = {
      type: "opencode",
      async init() {},
      async listSessions() { return [current]; },
      async getSession(id: string) { return id === current.id ? current : null; },
      async listModels() { return ["omniroute/minimax-combo-m3.1"]; },
      async changeModel(_id: string, model: string) { current = { ...current, model }; return { ok: true }; },
      async sendMessage(_id: string, options: { model?: string; inputId?: string }) {
        messages.push({ model: options.model, inputId: options.inputId });
        return { ok: true, admitted: true, inputId: options.inputId };
      },
    } as unknown as import("../src/types/index.js").HarnessAdapter;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["opencode", adapter]]), store: new UnfinishedSessionStore(join(root, "unfinished.json")), settingsStore: settings,
      fallbackModelsForHarness: async () => ["omniroute/minimax-combo-m3.1"],
      projectLaunchPolicyStore: launchPolicy,
    });
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { throw new Error("unused"); } }, undefined, { unfinishedSessions: launcher });
    const server = createWebServer({ adapters: new Map([["opencode", adapter]]), converter: { async convert() { throw new Error("unused"); } }, sessionAutostartStore: settings, automationLaunchPolicyStore: launchPolicy, supervisor });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/api/quota-recovery/operator-cohort/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationId: "operator-api-authorization-01", entries: [{
        sessionId: current.id, cwd: current.cwd, expected: {
          nativeTurnId: "native-turn-api", assistantMessageId: "assistant-api", providerId: "zai-coding-plan",
          modelId: "glm-5.3-flash", completedAt: current.meta.nativeLastTurn.completedAt,
        },
      }] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ selected: 1, enrolled: 1, results: [{ outcome: "enrolled", wait: { origin: "operator_cohort", state: "waiting" } }] });
    await expect((await fetch(`${origin}/api/session-autostart/sessions/opencode/${current.id}?cwd=${encodeURIComponent(current.cwd)}`)).json())
      .resolves.toMatchObject({ waitForQuota: true, waitForQuotaSource: "session", enabled: true });
    await expect((await fetch(`${origin}/api/human-stop/status?harness=opencode&sessionId=${current.id}`)).json())
      .resolves.toMatchObject({ harness: "opencode", sessionId: current.id, held: false });
    await launcher.recoverPending();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ model: "omniroute/minimax-combo-m3.1" });
  });
});
