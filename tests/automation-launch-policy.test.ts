import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationLaunchPolicyStore, validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const policy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode"],
  preferredHarness: "codex",
  models: { codex: "gpt-5.6-sol", zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
} as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("automation launch policy", () => {
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

  it("atomically persists validated policy with private file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-"));
    const path = join(root, "nested", "automation-launch-policy.json");
    const store = new AutomationLaunchPolicyStore(path);
    await expect(store.load()).resolves.toEqual({ kind: "absent" });
    await expect(store.replace({ ...policy, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } }))
      .resolves.toEqual({ version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } });
    await expect(store.load()).resolves.toMatchObject({ kind: "valid", policy: { allowedHarnesses: ["codex"] } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-5.6-sol" } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when absent and validates HTTP writes before persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-launch-policy-http-"));
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
    await expect(missing.json()).resolves.toEqual({ error: "Launch policy is not configured" });
    const rejected = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...policy, allowedHarnesses: ["future"] }) });
    expect(rejected.status).toBe(400);
    await expect(store.load()).resolves.toEqual({ kind: "absent" });
    const saved = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(policy) });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(policy);
    const loaded = await fetch(url);
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual(policy);
  });
});
