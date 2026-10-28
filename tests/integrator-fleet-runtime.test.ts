import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { IntegratorFleetRuntime } from "../src/integrator-fleet-runtime.js";
import { IntegratorSessionBindingStore, type IntegratorLaunchReceipt } from "../src/integrator-session-binding.js";
import { CODEX_PROJECT_MODEL_ID } from "../src/project-runtime-policy.js";
import type { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "herder-integrator-fleet-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const secondProjectRoot = join(root, "second-project");
  const integratorRoot = join(root, "integrator-research");
  const nativeHome = join(root, "codex-home");
  await Promise.all([mkdir(projectRoot), mkdir(secondProjectRoot), mkdir(integratorRoot), mkdir(nativeHome)]);
  const policyStore = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
  await policyStore.replace({
    version: 1,
    allowedHarnesses: ["codex"],
    preferredHarness: "codex",
    models: { codex: CODEX_PROJECT_MODEL_ID },
    projectRoutes: {
      [projectRoot]: { harnesses: ["codex"], aliases: ["project-alpha"], models: { codex: CODEX_PROJECT_MODEL_ID } },
      [secondProjectRoot]: { harnesses: ["codex"], aliases: ["project-beta"], models: { codex: CODEX_PROJECT_MODEL_ID } },
      [integratorRoot]: { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: CODEX_PROJECT_MODEL_ID }, nativeWebSearch: "live" },
    },
  });
  const bindingStore = new IntegratorSessionBindingStore({ persistencePath: join(root, "h34.json") });
  const runtime = new IntegratorFleetRuntime({ policyStore, bindingStore, codexDataHome: nativeHome });
  return { root, projectRoot, secondProjectRoot, integratorRoot, nativeHome, policyStore, bindingStore, runtime };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function fakeScopedFactory(bindingStore: IntegratorSessionBindingStore, nativeHome: string) {
  const created: string[] = [];
  const restored: string[] = [];
  const factory = vi.fn(async (config: any) => {
    const policy = config.policy;
    const nativeIdentity = async (path: string) => {
      const canonical = resolve(path);
      const details = await stat(canonical);
      return { path: canonical, device: details.dev, inode: details.ino };
    };
    const address = { hostId: hostname(), harness: "codex", nativeSessionId: `native-${policy.binding.attemptId}` } as const;
    const adapter = {
      type: "codex",
      readProjectReadinessEvidence: vi.fn(async () => ({
        isolated: true,
        nativeWebSearch: policy.nativeWebSearchMode === "live"
          ? { complete: true, mode: "live", origin: "sessionFlags" }
          : { complete: true, mode: "not_requested", origin: "not_requested" },
        availableModels: [CODEX_PROJECT_MODEL_ID],
        harnessVersion: "codex-cli 0.162.1",
      })),
      createSession: vi.fn(async () => {
        created.push(policy.binding.attemptId);
        const ownerProof = await config.projectRuntimeOwner.resolve(policy.binding);
        expect(ownerProof?.kind).toBe("trusted");
        const canonicalRoot = await nativeIdentity(policy.rootPath);
        const nativeDataHome = await nativeIdentity(nativeHome);
        const reserved = await bindingStore.reserve({ operationId: policy.binding.attemptId, hostId: hostname(), harness: "codex",
          scope: { projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
            policyRevision: policy.binding.policyRevision, hostId: hostname(), harness: "codex", harnessVersion: "codex-cli 0.162.1",
            canonicalRoot, nativeDataHome } });
        const receipt: IntegratorLaunchReceipt = { state: "created", inputId: reserved.attempt.inputId,
          address, launchCwd: policy.rootPath, retryable: false };
        await bindingStore.record({ operationId: policy.binding.attemptId, attempt: reserved.attempt.attempt, receipt });
        return { id: address.nativeSessionId, harness: "codex", cwd: policy.rootPath };
      }),
      restoreMaterializedSession: vi.fn(async () => { restored.push(policy.binding.attemptId); return { ok: true, sessionId: address.nativeSessionId }; }),
      resolveCurrentProjectScope: vi.fn(async () => ({ binding: policy.binding,
        canonicalRoot: await nativeIdentity(policy.rootPath), harnessVersion: "codex-cli 0.162.1",
        appServerDataHome: await nativeIdentity(nativeHome), transcriptReaderDataHome: await nativeIdentity(nativeHome) })),
      sendMessage: vi.fn(async () => ({ ok: true, admitted: true })),
      getSession: vi.fn(async () => ({ id: address.nativeSessionId, harness: "codex", cwd: policy.rootPath })),
      dispose: vi.fn(async () => undefined),
    };
    return adapter as unknown as CodexAppServerAdapter;
  });
  return { factory, created, restored };
}

describe("integrator Fleet runtime", () => {
  async function readyRequest(runtime: IntegratorFleetRuntime, project: string, inputId: string, name = "task", cwd?: string) {
    const readiness = await runtime.readiness(project);
    return { project, inputId, name, ...(cwd ? { cwd } : {}), projectReadinessContract: "integrator-host-readiness-v1" as const,
      projectReadiness: readiness, cwd: cwd ?? readiness.cwd, model: CODEX_PROJECT_MODEL_ID };
  }

  it("preflights actual scoped readiness and rejects stale CWD/policy before create", async () => {
    const f = await setup();
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory });
    const missing = await runtime.readiness("unconfigured-project");
    expect(missing).toMatchObject({ state: "not_ready", reason: "project_route_unconfigured" });
    expect(fake.factory).not.toHaveBeenCalled();
    const readiness = await runtime.readiness("Олег и Никита");
    expect(readiness).toMatchObject({ state: "ready", projectId: "Олег и Никита", projectRoot: f.integratorRoot,
      requiredTools: ["web_search"], availableTools: ["web_search"], availableModels: [CODEX_PROJECT_MODEL_ID],
      cwd: f.integratorRoot, pathResolution: { contained: true, identityMatches: true } });
    const base = { project: "Олег и Никита", inputId: "9".repeat(64), name: "research",
      projectReadinessContract: "integrator-host-readiness-v1" as const, projectReadiness: readiness };
    expect(await runtime.validateReadiness({ ...base, cwd: "/tmp/foreign" })).toBe(false);
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: CODEX_PROJECT_MODEL_ID },
      projectRoutes: { [f.integratorRoot]: { harnesses: ["codex"], aliases: ["Олег и Никита"],
        models: { codex: CODEX_PROJECT_MODEL_ID }, nativeWebSearch: "live" } },
    });
    expect(await runtime.validateReadiness({ ...base, cwd: f.integratorRoot })).toBe(false);
    expect(fake.created).toEqual([]);
    await runtime.dispose();
  });

  it("rejects stale, malformed, and future readiness before durable Fleet intent", async () => {
    const f = await setup();
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: vi.fn() as any });
    const document = await f.policyStore.readDocument();
    expect(document.kind).toBe("valid");
    if (document.kind !== "valid") throw new Error("test policy unavailable");
    const rootStat = await stat(f.integratorRoot);
    const base = {
      state: "ready" as const, projectId: "Олег и Никита", projectRoot: f.integratorRoot,
      rootIdentity: JSON.stringify([f.integratorRoot, rootStat.dev, rootStat.ino]), policyRevision: document.etag,
      hostId: hostname(), harness: "codex" as const, harnessVersion: "codex-cli test", model: CODEX_PROJECT_MODEL_ID,
      requiredTools: ["web_search"], availableTools: ["web_search"], availableModels: [CODEX_PROJECT_MODEL_ID],
      resourceReady: true, runtimeInstanceId: "test-runtime", cwd: f.integratorRoot,
      pathResolution: { requestedCwd: f.integratorRoot, canonicalCwd: f.integratorRoot, rootPath: f.integratorRoot,
        contained: true, identityMatches: true }, observedAtMs: Date.now(),
    };
    const ownerJournal = { once: vi.fn(async () => ({ state: "not_attempted" as const, inputId: "unexpected", retryable: false })) };
    const server = new McpServer({ name: "local-herder", version: "test" });
    registerFleetNodeTools(server, { adapters: new Map(), integratorRuntime: runtime, ownerJournal: ownerJournal as any });
    const client = new Client({ name: "fleet-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const stale = { ...base, observedAtMs: Date.now() - 24 * 60 * 60 * 1000 };
      const tooFarFuture = { ...base, observedAtMs: Date.now() + 60_000 };
      expect(await runtime.validateReadiness({ project: "Олег и Никита", inputId: "4".repeat(64), name: "research",
        cwd: f.integratorRoot, projectReadinessContract: "integrator-host-readiness-v1", projectReadiness: stale })).toBe(false);
      for (const [index, projectReadiness] of [stale, tooFarFuture].entries()) {
        const result = await client.callTool({ name: "fleet_create_session", arguments: {
          inputId: String(index + 1).repeat(64), harness: "codex", name: "research", cwd: f.integratorRoot,
          model: CODEX_PROJECT_MODEL_ID, project: "Олег и Никита", projectReadinessContract: "integrator-host-readiness-v1",
          projectReadiness,
        } });
        expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ state: "not_attempted", reason: "project_readiness_not_validated" });
      }
      expect(await runtime.validateReadiness({ project: "Олег и Никита", inputId: "3".repeat(64), name: "research",
        cwd: f.integratorRoot, projectReadinessContract: "integrator-host-readiness-v1", projectReadiness: { ...base, observedAtMs: Number.NaN } })).toBe(false);
      expect(ownerJournal.once).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await runtime.dispose();
    }
  });

  it("uses only the configured root despite caller cwd and requires the exact Luna model", async () => {
    const f = await setup();
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory });
    const callerCwd = await runtime.create(await readyRequest(runtime, "project-alpha", "a".repeat(64), "task", f.projectRoot));
    const wrongModel = await runtime.create({ project: "project-alpha", inputId: "b".repeat(64), name: "task", model: "gpt-6-luna-other" });
    const unconfigured = await runtime.create({ project: "not-configured", inputId: "c".repeat(64), name: "task" });
    expect(callerCwd).toMatchObject({ state: "created", launchCwd: f.projectRoot });
    expect(wrongModel).toMatchObject({ state: "not_attempted", reason: "project_route_conflict" });
    expect(unconfigured).toMatchObject({ state: "not_attempted", reason: "project_route_unconfigured" });
    expect(fake.factory).toHaveBeenCalledTimes(2);

    const created = await runtime.create(await readyRequest(runtime, "project-alpha", "d".repeat(64), "task", f.projectRoot));
    // The codex receipt keeps its own contract and its own execution.
    expect(created).toMatchObject({ state: "created", inputId: "d".repeat(64), launchCwd: f.projectRoot,
      projectReadinessContract: "integrator-host-readiness-v1",
      projectExecution: { projectId: "project-alpha", projectRoot: f.projectRoot, harness: "codex",
        model: CODEX_PROJECT_MODEL_ID, launchCwd: f.projectRoot,
        address: { hostId: hostname(), harness: "codex", nativeSessionId: `native-${"d".repeat(64)}` } },
      address: { hostId: hostname(), harness: "codex", nativeSessionId: `native-${"d".repeat(64)}` } });
    expect(fake.factory).toHaveBeenCalledTimes(4);
    expect(fake.factory.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: f.projectRoot, policy: { rootPath: f.projectRoot, modelId: CODEX_PROJECT_MODEL_ID, materialized: true } });
    await runtime.dispose();
  });

  it("deduplicates the exact operation, routes through its scoped adapter, and restores from exact H34 address after process recreation", async () => {
    const f = await setup();
    const firstFactory = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const first = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: firstFactory.factory });
    const request = await readyRequest(first, "project-alpha", "e".repeat(64), "task");
    const created = await first.create(request);
    expect(created.state).toBe("created");
    const repeated = await first.create(request);
    expect(repeated).toEqual(created);
    expect(firstFactory.created).toEqual([request.inputId]);

    const address = created.address!;
    expect(await first.adapterForSession(address)).toMatchObject({ kind: "scoped" });
    await first.dispose();

    const secondFactory = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const second = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: secondFactory.factory });
    const selected = await second.adapterForSession(address);
    expect(selected.kind).toBe("scoped");
    expect(secondFactory.created).toEqual([]);
    expect(secondFactory.restored).toEqual([request.inputId]);
    await second.dispose();
  });

  it("binds live native search only to the exact named route and refuses that H34 restore after route downgrade", async () => {
    const f = await setup();
    const factory = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: factory.factory });
    const ordinary = await runtime.create(await readyRequest(runtime, "project-alpha", "1".repeat(64), "ordinary"));
    const target = await runtime.create(await readyRequest(runtime, "Олег и Никита", "2".repeat(64), "research"));
    expect(ordinary.state).toBe("created");
    expect(factory.factory.mock.calls.find(call => call[0].policy.binding.projectId === f.projectRoot)?.[0].policy).not.toHaveProperty("nativeWebSearchMode");
    expect(target.state).toBe("created");
    expect(factory.factory.mock.calls.find(call => call[0].policy.binding.projectId === f.integratorRoot)?.[0].policy).toMatchObject({ nativeWebSearchMode: "live",
      binding: { policyRevision: "codex-native-project-v2-web-search-live" } });
    const address = target.address!;
    await f.policyStore.replace({ version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID }, projectRoutes: {
        [f.integratorRoot]: { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: CODEX_PROJECT_MODEL_ID } },
      } });
    expect(await runtime.adapterForSession(address)).toMatchObject({ kind: "deny", reason: "project_session_current_route_mismatch" });
    await runtime.dispose();
  });

  it("does not replay a live accepted address as created for a different project or a changed route", async () => {
    const f = await setup();
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory });
    const original = await runtime.create(await readyRequest(runtime, "project-alpha", "f".repeat(64), "task"));
    expect(original.state).toBe("created");
    const otherProject = await runtime.create({ project: "project-beta", inputId: "f".repeat(64), name: "task" });
    expect(otherProject).toMatchObject({ state: "not_attempted", reason: "project_operation_conflict" });
    expect(otherProject).not.toHaveProperty("address");
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: CODEX_PROJECT_MODEL_ID },
      projectRoutes: { [f.secondProjectRoot]: { harnesses: ["codex"], aliases: ["project-alpha"], models: { codex: CODEX_PROJECT_MODEL_ID } } },
    });
    const changedRoute = await runtime.create({ project: "project-alpha", inputId: "f".repeat(64), name: "task" });
    expect(changedRoute).toMatchObject({ state: "not_attempted", reason: "project_operation_conflict" });
    expect(changedRoute).not.toHaveProperty("launchCwd");
    expect(fake.created).toEqual(["f".repeat(64)]);
    await runtime.dispose();
  });

  it("validates the readiness of the harness the project route designates", async () => {
    const f = await setup();
    const model = "anthropic/claude-sonnet-4-5";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: vi.fn() as any });
    const document = await f.policyStore.readDocument();
    if (document.kind !== "valid") throw new Error("test policy unavailable");
    const rootStat = await stat(f.projectRoot);
    const snapshot = {
      state: "ready" as const, projectId: "project-alpha", projectRoot: f.projectRoot,
      rootIdentity: JSON.stringify([f.projectRoot, rootStat.dev, rootStat.ino]), policyRevision: document.etag,
      hostId: hostname(), harness: "opencode" as const, harnessVersion: "opencode 1.0.0", model,
      requiredTools: [], availableTools: [], availableModels: [model],
      resourceReady: true, runtimeInstanceId: "test-runtime", cwd: f.projectRoot,
      pathResolution: { requestedCwd: f.projectRoot, canonicalCwd: f.projectRoot, rootPath: f.projectRoot,
        contained: true, identityMatches: true }, observedAtMs: Date.now(),
    };
    const base = { project: "project-alpha", inputId: "8".repeat(64), name: "research", cwd: f.projectRoot,
      harness: "opencode" as const, projectReadinessContract: "integrator-host-readiness-v1" as const };
    expect(await runtime.validateReadiness({ ...base, projectReadiness: snapshot })).toBe(true);
    // A snapshot of another harness does not validate this route.
    expect(await runtime.validateReadiness({ ...base, projectReadiness: { ...snapshot, harness: "codex", model: CODEX_PROJECT_MODEL_ID } })).toBe(false);
    await runtime.dispose();
  });

  it("names the project route harness and model that a consumer must request", async () => {
    const f = await setup();
    const model = "anthropic/claude-sonnet-4-5";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: {
        [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } },
        [f.integratorRoot]: { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: CODEX_PROJECT_MODEL_ID } },
      },
    });
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory, createHarnessAdapter: vi.fn() as any });
    const server = new McpServer({ name: "local-herder", version: "test" });
    registerFleetNodeTools(server, { adapters: new Map(), integratorRuntime: runtime, ownerJournal: { once: vi.fn() } as any });
    const client = new Client({ name: "fleet-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // The opencode route is named by the route itself, not by a codex constant.
      const opencode = await client.callTool({ name: "fleet_node_info", arguments: { project: "project-alpha" } });
      expect(opencode.structuredContent, JSON.stringify(opencode)).toMatchObject({ projectRoute: { state: "available", harness: "opencode", model } });
      // A project without a route is named with the reason of the resolver.
      const missing = await client.callTool({ name: "fleet_node_info", arguments: { project: "project-unknown" } });
      expect(missing.structuredContent, JSON.stringify(missing)).toMatchObject({ projectRoute: { state: "unavailable", reason: "project_route_unconfigured" } });
      // The codex route keeps its own harness and model, and the readiness answer is unchanged.
      const codex = await client.callTool({ name: "fleet_node_info", arguments: { project: "Олег и Никита" } });
      expect(codex.structuredContent, JSON.stringify(codex)).toMatchObject({ projectReadinessContract: "integrator-host-readiness-v1",
        projectRoute: { state: "available", harness: "codex", model: CODEX_PROJECT_MODEL_ID } });
      expect((codex.structuredContent as any).projectReadiness, JSON.stringify(codex)).toMatchObject({ state: "ready", harness: "codex", model: CODEX_PROJECT_MODEL_ID });
      // A node without a project scope never names a route.
      const ordinary = await client.callTool({ name: "fleet_node_info", arguments: {} });
      expect(ordinary.structuredContent).not.toHaveProperty("projectRoute");
    } finally {
      await client.close();
      await server.close();
      await runtime.dispose();
    }
  });

  it("carries the harness and the model of the selected route in the readiness snapshot", async () => {
    const f = await setup();
    const model = "anthropic/claude-sonnet-4-5";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: {
        [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } },
        [f.integratorRoot]: { harnesses: ["codex"], aliases: ["Олег и Никита"], models: { codex: CODEX_PROJECT_MODEL_ID }, nativeWebSearch: "live" },
      },
    });
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory, createHarnessAdapter: vi.fn() as any });
    // The opencode route reports its own harness and its own model: no codex constant.
    const opencode = await runtime.readiness("project-alpha");
    expect(opencode).toMatchObject({ state: "ready", harness: "opencode", model, projectRoot: f.projectRoot,
      requiredTools: [], availableTools: [], resourceReady: true });
    // The codex route keeps the codex snapshot: the same harness, the same model, the same probe.
    const codex = await runtime.readiness("Олег и Никита");
    expect(codex).toMatchObject({ state: "ready", harness: "codex", model: CODEX_PROJECT_MODEL_ID,
      requiredTools: ["web_search"], availableTools: ["web_search"], availableModels: [CODEX_PROJECT_MODEL_ID] });
    // A project without a route is named with the reason of the resolver.
    const missing = await runtime.readiness("project-unknown");
    expect(missing).toMatchObject({ state: "not_ready", reason: "project_route_unconfigured" });
    // The node info answer carries the readiness of that same route.
    const server = new McpServer({ name: "local-herder", version: "test" });
    registerFleetNodeTools(server, { adapters: new Map(), integratorRuntime: runtime, ownerJournal: { once: vi.fn() } as any });
    const client = new Client({ name: "fleet-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const info = await client.callTool({ name: "fleet_node_info", arguments: { project: "project-alpha" } });
      expect(info.structuredContent, JSON.stringify(info)).toMatchObject({ projectReadinessContract: "integrator-host-readiness-v1",
        projectRoute: { state: "available", harness: "opencode", model }, projectReadiness: { harness: "opencode", model } });
    } finally {
      await client.close();
      await server.close();
    }
    await runtime.dispose();
  });

  // РЕШЕНО 24.10.2026 слиянием (лист L19): его WIP добавил тест «creates for the selected harness: the reservation carries the harness and the adapter writes the created receipt» — он сохранён (автослияние, строка 381). Спорные хунки — только наши добавленные тесты маршрута (L68/L69/L70); его тест не тронут.
  it("creates for the selected harness: the reservation carries the harness and the adapter writes the created receipt", async () => {
    const f = await setup();
    const model = "anthropic/claude-sonnet-4-5";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const inputId = "7".repeat(64);
    const factory = vi.fn(async ({ harness, reservation, bindingStore }: any) => {
      expect(harness).toBe("opencode");
      expect(reservation.harness).toBe("opencode");
      expect(reservation.operationId).toBe(inputId);
      await bindingStore.recordCreated({ operationId: reservation.operationId, attempt: reservation.attempt,
        harness, nativeSessionId: "native-opencode-1", launchCwd: f.projectRoot });
      return { createSession: vi.fn(async () => ({ id: "native-opencode-1", harness: "opencode", cwd: f.projectRoot })) };
    });
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: factory as any });
    const receipt = await runtime.create({ project: "project-alpha", inputId, name: "task", cwd: f.projectRoot, harness: "opencode" });
    expect(receipt).toMatchObject({ state: "created", inputId, launchCwd: f.projectRoot,
      address: { hostId: hostname(), harness: "opencode", nativeSessionId: "native-opencode-1" } });
    expect(factory).toHaveBeenCalledTimes(1);
    const binding = await f.bindingStore.get(inputId);
    expect(binding?.harness).toBe("opencode");
    expect(binding?.state).toBe("accepted");
    expect(binding?.attempts.at(-1)?.receipt?.state).toBe("created");
    // A repeated create must not open a second native session.
    const repeated = await runtime.create({ project: "project-alpha", inputId, name: "task", cwd: f.projectRoot, harness: "opencode" });
    expect(repeated).toEqual(receipt);
    expect(factory).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("returns the project execution of the selected harness with the route model", async () => {
    const f = await setup();
    const model = "anthropic/claude-sonnet-4-5";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const inputId = "e".repeat(64);
    const factory = vi.fn(async ({ harness, reservation, bindingStore }: any) => {
      await bindingStore.recordCreated({ operationId: reservation.operationId, attempt: reservation.attempt,
        harness, nativeSessionId: "native-opencode-2", launchCwd: f.projectRoot });
      return { createSession: vi.fn(async () => ({ id: "native-opencode-2", harness: "opencode", cwd: f.projectRoot })) };
    });
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: factory as any });
    const server = new McpServer({ name: "local-herder", version: "test" });
    registerFleetNodeTools(server, { adapters: new Map(), integratorRuntime: runtime,
      ownerJournal: { once: async (_request: any, run: any) => run() } as any });
    const client = new Client({ name: "fleet-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const document = await f.policyStore.readDocument();
      if (document.kind !== "valid") throw new Error("test policy unavailable");
      const canonicalRoot = await realpath(f.projectRoot);
      const rootStat = await stat(canonicalRoot);
      const created = await client.callTool({ name: "fleet_create_session", arguments: {
        inputId, harness: "opencode", name: "research", cwd: f.projectRoot, project: "project-alpha" } });
      // The create answer of the selected harness carries the contract and the execution of its own route.
      expect(created.structuredContent, JSON.stringify(created)).toMatchObject({
        ok: true, created: true, harness: "opencode", inputId,
        projectReadinessContract: "integrator-host-readiness-v1",
        projectExecution: {
          projectId: "project-alpha", projectRoot: f.projectRoot,
          rootIdentity: JSON.stringify([canonicalRoot, rootStat.dev, rootStat.ino]),
          policyRevision: document.etag, hostId: hostname(),
          harness: "opencode", model, requiredTools: [], launchCwd: f.projectRoot,
          address: { hostId: hostname(), harness: "opencode", nativeSessionId: "native-opencode-2" },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await runtime.dispose();
    }
  });

  // ORCHESTRATOR-CONFLICT: tests/integrator-fleet-runtime.test.ts:265 — его WIP добавил тот же тест «creates for the selected harness: the reservation carries the harness and the adapter writes the created receipt», что и наш (обе копии побайтно совпадают, sha256 5b8ac9c1aff7a2a5): оставлена одна копия (наша, строка 382), его дубль удалён; наши тесты маршрута (L68/L69/L70) сохранены.

  it("resolves a scoped OpenCode adapter for an accepted binding on the exact project route", async () => {
    const f = await setup();
    const model = "anthropic/claude-opus-4-6";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const inputId = "b".repeat(64);
    const factory = vi.fn(async ({ harness, reservation, bindingStore }: any) => {
      expect(harness).toBe("opencode");
      await bindingStore.recordCreated({ operationId: reservation.operationId, attempt: reservation.attempt,
        harness, nativeSessionId: "native-opencode-join", launchCwd: f.projectRoot });
      return { type: "opencode", createSession: vi.fn(async () => ({ id: "native-opencode-join", harness: "opencode", cwd: f.projectRoot })) };
    });
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: factory as any });
    const receipt = await runtime.create({ project: "project-alpha", inputId, name: "qa readback", cwd: f.projectRoot, harness: "opencode" });
    expect(receipt.state).toBe("created");
    factory.mockClear();

    // Matching tuple: same host, opencode harness, live route still designates this root.
    const matched = await runtime.adapterForSession({ hostId: hostname(), harness: "opencode", nativeSessionId: "native-opencode-join" });
    expect(matched, JSON.stringify(matched)).toMatchObject({ kind: "scoped" });
    expect((matched as any).adapter.type).toBe("opencode");
    expect(factory).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("denies the OpenCode scope after the route stops designating the launch root", async () => {
    const f = await setup();
    const model = "anthropic/claude-opus-4-6";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const inputId = "c".repeat(64);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: vi.fn(async ({ reservation, bindingStore }: any) => {
        await bindingStore.recordCreated({ operationId: reservation.operationId, attempt: reservation.attempt,
          harness: "opencode", nativeSessionId: "native-opencode-join", launchCwd: f.projectRoot });
        return { type: "opencode" };
      }) as any });
    await runtime.create({ project: "project-alpha", inputId, name: "qa", cwd: f.projectRoot, harness: "opencode" });
    // The current route downgrades: the launch root no longer resolves as opencode.
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["codex"], aliases: ["project-alpha"], models: { codex: CODEX_PROJECT_MODEL_ID } } },
    });
    const denied = await runtime.adapterForSession({ hostId: hostname(), harness: "opencode", nativeSessionId: "native-opencode-join" });
    expect(denied).toMatchObject({ kind: "deny", reason: "project_session_current_route_mismatch" });
    await runtime.dispose();
  });

  it("never hands a scoped OpenCode adapter to a wrong host or harness address", async () => {
    const f = await setup();
    const model = "anthropic/claude-opus-4-6";
    await f.policyStore.replace({
      version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
      models: { codex: CODEX_PROJECT_MODEL_ID, opencode: model },
      projectRoutes: { [f.projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: model } } },
    });
    const inputId = "d".repeat(64);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createHarnessAdapter: vi.fn(async () => ({ type: "opencode" })) as any });
    await runtime.create({ project: "project-alpha", inputId, name: "qa", cwd: f.projectRoot, harness: "opencode" });
    // A wrong host never resolves the durable address: the scoped route is refused.
    const wrongHost = await runtime.adapterForSession({ hostId: "other-host", harness: "opencode", nativeSessionId: "native-opencode-join" });
    expect(wrongHost.kind).toBe("ordinary");
    // A wrong harness never resolves the durable address either.
    const wrongHarness = await runtime.adapterForSession({ hostId: hostname(), harness: "codex", nativeSessionId: "native-opencode-join" });
    expect(wrongHarness.kind).toBe("ordinary");
    await runtime.dispose();
  });
  it("never creates for an existing unknown operation and never falls through an unresolved scoped address", async () => {
    const f = await setup();
    const reserved = await f.bindingStore.reserve({ operationId: "f".repeat(64), hostId: hostname(), harness: "codex" });
    const unknownAddress = { hostId: hostname(), harness: "codex", nativeSessionId: "unknown-session" };
    await f.bindingStore.record({ operationId: "f".repeat(64), attempt: 1,
      receipt: { state: "unknown", inputId: reserved.attempt.inputId, address: unknownAddress, retryable: false } });
    const fake = fakeScopedFactory(f.bindingStore, f.nativeHome);
    const runtime = new IntegratorFleetRuntime({ policyStore: f.policyStore, bindingStore: f.bindingStore,
      codexDataHome: f.nativeHome, createScopedAdapter: fake.factory });
    expect(await runtime.create({ project: "project-alpha", inputId: "f".repeat(64), name: "task" }))
      .toMatchObject({ state: "unknown", retryable: false });
    expect(fake.factory).not.toHaveBeenCalled();
    expect(await runtime.adapterForSession({ hostId: hostname(), harness: "codex", nativeSessionId: "unknown-session" }))
      .toMatchObject({ kind: "deny", reason: "binding_not_accepted" });
    await runtime.dispose();
  });
});
