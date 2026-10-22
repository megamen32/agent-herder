import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ABSENT_LAUNCH_POLICY_ETAG, AutomationLaunchPolicyStore, operatorCohortRecoveryAllowed, validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const directories: string[] = [];
const policy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode"],
  preferredHarness: "codex",
  models: { codex: "gpt-5.6-sol", zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
} as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("automation launch policy", () => {
  it("accepts native GLM fallback references and retains priority without case duplicates", () => {
    const model = "account:zai-individual-coding-plan/GLM-5.3-Flash$high";
    expect(validateAutomationLaunchPolicy({ ...policy, fallbackModels: { zcode: [model, model.toLowerCase(), "omniroute/minimax-combo-m3.1"] } }).fallbackModels?.zcode)
      .toEqual([model, "omniroute/minimax-combo-m3.1"]);
  });

  it("accepts live hosted search only for the exact Codex Luna integrator route", () => {
    const routed = validateAutomationLaunchPolicy({
      ...policy,
      projectRoutes: {
        "/existing/task/workspace": {
          harnesses: ["codex"], aliases: ["Олег и Никита"],
          models: { codex: "gpt-6-luna" }, nativeWebSearch: "live",
        },
      },
    });
    expect(routed.projectRoutes?.["/existing/task/workspace"]).toMatchObject({ nativeWebSearch: "live" });

    const invalidRoutes = [
      { harnesses: ["codex"], aliases: ["other"], models: { codex: "gpt-6-luna" }, nativeWebSearch: "live" },
      { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: "gpt-5.6-sol" }, nativeWebSearch: "live" },
      { harnesses: ["codex", "zcode"], aliases: ["Олег и Никита"], models: { codex: "gpt-6-luna", zcode: "z" }, nativeWebSearch: "live" },
      { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: "gpt-6-luna" }, nativeWebSearch: "cached" },
    ];
    for (const route of invalidRoutes) {
      expect(() => validateAutomationLaunchPolicy({
        version: 1, allowedHarnesses: ["codex", "zcode"], preferredHarness: "codex",
        models: { codex: "gpt-6-luna", zcode: "z" }, projectRoutes: { "/task": route },
      })).toThrow(/native web search|nativeWebSearch/);
    }

    const ordinary = validateAutomationLaunchPolicy({ ...policy,
      projectRoutes: { "/ordinary": { harnesses: ["codex"] } },
    });
    expect(ordinary.projectRoutes?.["/ordinary"]).not.toHaveProperty("nativeWebSearch");
  });

  it("fails closed for operator cohort recovery on the restricted TelegramAuto route only", () => {
    const configured = validateAutomationLaunchPolicy({
      version: 1,
      allowedHarnesses: ["opencode", "zcode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/minimax-combo-m3.1", zcode: "omniroute/minimax-combo-m3.1" },
      fallbackModels: { opencode: ["omniroute/minimax-combo-m3.1"] },
      projectRoutes: {
        "/home/roomhacker/PycharmProjects/TelegramAuto": {
          harnesses: ["opencode", "zcode"], aliases: ["tg-commentator", "autotelegramviews"],
        },
        "/home/roomhacker/PycharmProjects/video_watching": { harnesses: ["opencode"] },
        "/projects/ordinary": { harnesses: ["opencode"] },
        "/projects/explicit-deny": { harnesses: ["opencode"], operatorCohortRecovery: "deny" },
        "/projects/no-opencode": { harnesses: ["zcode"] },
      },
    });
    expect(operatorCohortRecoveryAllowed(configured, "/home/roomhacker/PycharmProjects/TelegramAuto")).toBe(false);
    expect(operatorCohortRecoveryAllowed(configured, "tg-commentator")).toBe(false);
    expect(operatorCohortRecoveryAllowed(configured, "/home/roomhacker/PycharmProjects/video_watching")).toBe(false);
    expect(operatorCohortRecoveryAllowed(configured, "/projects/ordinary")).toBe(true);
    expect(operatorCohortRecoveryAllowed(configured, "/projects/unconfigured")).toBe(true);
    expect(operatorCohortRecoveryAllowed(configured, "/projects/explicit-deny")).toBe(false);
    expect(operatorCohortRecoveryAllowed(configured, "/projects/no-opencode")).toBe(false);
  });

  it("validates the allowlist and supports an intentional empty disable policy", () => {
    expect(validateAutomationLaunchPolicy(policy)).toEqual(policy);
    expect(validateAutomationLaunchPolicy({ version: 1, allowedHarnesses: [], preferredHarness: "codex", models: {} }))
      .toEqual({ version: 1, allowedHarnesses: [], preferredHarness: "codex", models: {} });
    expect(() => validateAutomationLaunchPolicy({ ...policy, allowedHarnesses: ["codex", "codex"] }))
      .toThrow("Duplicate harness 'codex'");
    expect(() => validateAutomationLaunchPolicy({ ...policy, allowedHarnesses: ["future"] }))
      .toThrow("Unknown harness 'future'");
    expect(() => validateAutomationLaunchPolicy({ ...policy, allowedHarnesses: ["codex"], preferredHarness: "zcode" }))
      .toThrow("preferredHarness must be included");
    expect(() => validateAutomationLaunchPolicy({ ...policy, models: { codex: "   ", zcode: "z" } }))
      .toThrow("nonempty string");
    expect(() => validateAutomationLaunchPolicy({ ...policy, models: { codex: "c", zcode: "z".repeat(257) } }))
      .toThrow("at most 256 characters");
    expect(() => validateAutomationLaunchPolicy({ ...policy, models: { codex: "c" } }))
      .toThrow("model is required");
    expect(() => validateAutomationLaunchPolicy({ ...policy, models: { codex: "c", zcode: "z", other: "x" } }))
      .toThrow("Unknown model harness");
  });

  it("accepts the full model budget and rejects hidden control characters", () => {
    expect(validateAutomationLaunchPolicy({ ...policy, models: { ...policy.models, codex: "c".repeat(256) } }).models.codex).toHaveLength(256);
    for (const control of [String.fromCharCode(0), "\r", "\n"]) {
      expect(() => validateAutomationLaunchPolicy({ ...policy, models: { ...policy.models, codex: `gpt${control}-route` } })).toThrow("control characters");
    }
  });

  it("stable-deduplicates fallback models without rejecting the policy", () => {
    const validated = validateAutomationLaunchPolicy({
      ...policy,
      fallbackModels: {
        opencode: ["omniroute/openai/gpt-5.6", " OmniRoute/OpenAI/GPT-5.6 ", "omniroute/anthropic/claude", "omniroute/google/gemini", "omniroute/meta/llama", "omniroute/mistral/mistral-large", "omniroute/qwen/qwen3", "omniroute/deepseek/deepseek-v4", "omniroute/minimax-combo-m3.1", "omniroute/openai/gpt-5.6"],
      },
    });
    expect(validated.fallbackModels?.opencode).toEqual([
      "omniroute/openai/gpt-5.6", "omniroute/anthropic/claude", "omniroute/google/gemini", "omniroute/meta/llama",
      "omniroute/mistral/mistral-large", "omniroute/qwen/qwen3", "omniroute/deepseek/deepseek-v4",
      "omniroute/minimax-combo-m3.1",
    ]);
  });

  it("atomically persists validated policy with private file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-"));
    directories.push(root);
    const path = join(root, "nested", "automation-launch-policy.json");
    const store = new AutomationLaunchPolicyStore(path);
    await expect(store.load()).resolves.toEqual({ kind: "absent" });
    await expect(store.replace({ ...policy, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } }))
      .resolves.toMatchObject({ policy: { version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } } });
    await expect(store.load()).resolves.toMatchObject({ kind: "valid", policy: { allowedHarnesses: ["codex"] } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves fallback models when a legacy full-document update omits them, and allows explicit clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-legacy-"));
    directories.push(root);
    const store = new AutomationLaunchPolicyStore(join(root, "automation-launch-policy.json"));
    const initial = await store.replace({ ...policy, fallbackModels: { zcode: ["omniroute/openai/gpt-5.6"] } });
    const legacy = await store.replace({ ...policy, models: { ...policy.models, codex: "gpt-5.6" } }, { ifMatch: initial.etag });
    expect(legacy.policy.fallbackModels?.zcode).toEqual(["omniroute/openai/gpt-5.6"]);
    const cleared = await store.replace({ ...legacy.policy, fallbackModels: {} }, { ifMatch: legacy.etag });
    expect(cleared.policy.fallbackModels).toEqual({});
  });

  it("preserves operator cohort route guards when a legacy editor rewrites project routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "launch-route-guard-")); directories.push(root);
    const store = new AutomationLaunchPolicyStore(join(root, "policy.json"));
    const routePolicy = validateAutomationLaunchPolicy({
      version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode", models: { opencode: "omniroute/minimax-combo-m3.1" },
      projectRoutes: { "/projects/restricted": { harnesses: ["opencode"], operatorCohortRecovery: "deny" } },
    });
    const initial = await store.replace(routePolicy);
    const legacy = await store.replace({
      ...routePolicy,
      projectRoutes: { "/projects/restricted": { harnesses: ["opencode"] } },
    }, { ifMatch: initial.etag });
    expect(legacy.policy.projectRoutes?.["/projects/restricted"]?.operatorCohortRecovery).toBe("deny");
  });

  it("appends one audit line for a saved policy change", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-audit-"));
    directories.push(root);
    const store = new AutomationLaunchPolicyStore(join(root, "automation-launch-policy.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      automationLaunchPolicyStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/automation/launch-policy`;

    const saved = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ABSENT_LAUNCH_POLICY_ETAG }, body: JSON.stringify(policy) });
    expect(saved.status).toBe(200);
    const auditPath = join(root, "automation-launch-policy.audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { at: string; changed: string[]; models: string[] };
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect([...record.changed].sort()).toEqual(["allowedHarnesses", "models", "preferredHarness", "version"]);
    expect(record.models).toContain("gpt-5.6-sol");
    expect(record.models).toContain("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
    // The trail is appended, never rewritten.
    const second = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": saved.headers.get("etag")! }, body: JSON.stringify({ ...policy, models: { ...policy.models, codex: "gpt-6.1-sol" } }) });
    expect(second.status).toBe(200);
    const appended = (await readFile(auditPath, "utf8")).trim().split("\n");
    expect(appended).toHaveLength(2);
    expect(JSON.parse(appended[1]!).changed).toEqual(["models"]);
  });

  it("saves the policy even when the audit trail cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-audit-fail-"));
    directories.push(root);
    // A directory in the place of the trail makes the append fail.
    await mkdir(join(root, "automation-launch-policy.audit.jsonl"), { recursive: true });
    const store = new AutomationLaunchPolicyStore(join(root, "automation-launch-policy.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      automationLaunchPolicyStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/automation/launch-policy`;

    const saved = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ABSENT_LAUNCH_POLICY_ETAG }, body: JSON.stringify(policy) });
    expect(saved.status).toBe(200);
    await expect(store.load()).resolves.toMatchObject({ kind: "valid" });
  });

  it("keeps a hand-typed incident model through a save and a reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-incident-"));
    directories.push(root);
    const store = new AutomationLaunchPolicyStore(join(root, "automation-launch-policy.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      automationLaunchPolicyStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/automation/launch-policy`;

    const document = {
      version: 1,
      allowedHarnesses: ["opencode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/hand-typed-model" },
      incidentExecution: { runtime: "opencode", provider: "omniroute", model: "omniroute/hand-typed-model", reasoning: "default", topic: "health" },
    };
    const saved = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ABSENT_LAUNCH_POLICY_ETAG }, body: JSON.stringify(document) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ incidentExecution: { model: "omniroute/hand-typed-model" } });
    expect(await (await fetch(url)).json()).toMatchObject({ incidentExecution: { model: "omniroute/hand-typed-model" } });
    expect(JSON.parse(await readFile(join(root, "automation-launch-policy.json"), "utf8"))).toMatchObject({ incidentExecution: { model: "omniroute/hand-typed-model" } });
  });

  it("fails closed when absent and validates HTTP writes before persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-http-"));
    directories.push(root);
    const store = new AutomationLaunchPolicyStore(join(root, "automation-launch-policy.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      automationLaunchPolicyStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/automation/launch-policy`;

    const missing = await fetch(url);
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({ error: "Launch policy is not configured", state: "absent" });
    expect(missing.headers.get("etag")).toBe(ABSENT_LAUNCH_POLICY_ETAG);
    const rejected = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...policy, allowedHarnesses: ["future"] }) });
    expect(rejected.status).toBe(400);
    await expect(store.load()).resolves.toEqual({ kind: "absent" });
    // A full-document write without the version it was read from is refused.
    const unconditional = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(policy) });
    expect(unconditional.status).toBe(428);
    await expect(store.load()).resolves.toEqual({ kind: "absent" });
    const saved = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ABSENT_LAUNCH_POLICY_ETAG }, body: JSON.stringify(policy) });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(policy);
    const loaded = await fetch(url);
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual(policy);
    // The stored document keeps its identity, so a stale write is a conflict.
    const stale = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ABSENT_LAUNCH_POLICY_ETAG }, body: JSON.stringify(policy) });
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ state: "conflict" });
    await expect((await fetch(url)).json()).resolves.toEqual(policy);
  });
});
