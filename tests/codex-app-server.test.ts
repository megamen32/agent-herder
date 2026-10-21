import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { WebSocketServer } from "ws";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { createCodexProjectRuntimePolicy, restoreCodexProjectRuntimePolicy } from "../src/project-runtime-policy.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import { createNamedSession } from "../src/named-session.js";
import { IntegratorSessionBindingStore } from "../src/integrator-session-binding.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

type ScopedCollectionThread = { id: string; name?: string; cwd?: string; status?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stubScopedCollectionReads(adapter: CodexAppServerAdapter, options: {
  root: string;
  ready: boolean;
  listedThreads?: ScopedCollectionThread[];
  loadedIds?: string[];
  unmaterializedIds?: string[];
  namedThreads?: ScopedCollectionThread[];
}) {
  const calls = { ready: 0, rpc: [] as string[], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 };
  const internals = adapter as unknown as {
    projectThreadIds: Set<string>;
    threads: Map<string, ScopedCollectionThread>;
    isReady: () => boolean;
    ensureReady: () => Promise<void>;
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    rawTranscriptAdapter: {
      listSessions: () => Promise<unknown[]>;
      getNativeUnmaterializedThreadIds: (limit: number) => Promise<{ available: boolean; ids: string[]; limited: boolean }>;
      getNativeSessionMetadataForIds: (ids: string[]) => Promise<{ available: boolean; metadata: Map<string, unknown> }>;
      getNativeSessionMetadata: () => Promise<Map<string, unknown>>;
      findNativeNamedThreads: (name: string, cwd: string) => Promise<ScopedCollectionThread[] | null>;
    };
  };
  internals.isReady = () => options.ready;
  internals.ensureReady = async () => { calls.ready++; };
  internals.request = async (method, params) => {
    calls.rpc.push(method);
    if (method === "thread/list") return { data: options.listedThreads ?? [], nextCursor: null };
    if (method === "thread/loaded/list") return { data: options.loadedIds ?? [], nextCursor: null };
    if (method === "thread/read") {
      const id = String(params?.threadId ?? "missing");
      const thread = [...(options.listedThreads ?? []), ...(options.namedThreads ?? [])].find((candidate) => candidate.id === id);
      return { thread: thread ?? { id, cwd: options.root, name: `foreign-${id}`, status: "idle" } };
    }
    return {};
  };
  internals.rawTranscriptAdapter.listSessions = async () => {
    calls.rawList++;
    return (options.listedThreads ?? []).map((thread) => ({ ...thread, harness: "codex" }));
  };
  internals.rawTranscriptAdapter.getNativeUnmaterializedThreadIds = async () => {
    calls.rawIndex++;
    return { available: true, ids: options.unmaterializedIds ?? [], limited: false };
  };
  internals.rawTranscriptAdapter.getNativeSessionMetadataForIds = async () => {
    calls.rawMetadata++;
    return { available: true, metadata: new Map() };
  };
  internals.rawTranscriptAdapter.getNativeSessionMetadata = async () => {
    calls.rawMetadata++;
    return new Map();
  };
  internals.rawTranscriptAdapter.findNativeNamedThreads = async () => {
    calls.rawNamed++;
    return options.namedThreads ?? [];
  };
  return { calls, internals };
}

describe("Codex app-server adapter", () => {
  it("aborts a project factory during deferred discovery init and awaits every registered adapter disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-abort-factory-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "abort-factory", projectRoot: root });
    const controller = new AbortController();
    const initGate = deferred<void>();
    const owned = new Set<CodexAppServerAdapter>();
    const init = vi.spyOn(CodexAppServerAdapter.prototype as unknown as { initializeTransport: () => Promise<void> },
      "initializeTransport").mockImplementation(async () => initGate.promise);
    const inventory = vi.spyOn(CodexAppServerAdapter.prototype as unknown as { readProjectToolInventory: () => Promise<unknown> },
      "readProjectToolInventory").mockResolvedValue({ complete: true, denyList: { mcpServerIds: [], appIds: [], pluginIds: [] }, active: false, summary: "closed" });
    try {
      const factory = CodexAppServerAdapter.createProjectScoped({ policy, codexBin: process.execPath, cwd: root,
        signal: controller.signal, onOwnedAdapter: adapter => owned.add(adapter) });
      const factoryOutcome = expect(factory).rejects.toMatchObject({ name: "AbortError" });
      expect(owned.size).toBe(1);
      controller.abort();
      let disposalSettled = false;
      const disposal = Promise.all([...owned].map(adapter => adapter.dispose())).then(() => { disposalSettled = true; });
      await Promise.resolve();
      expect(disposalSettled).toBe(false);
      initGate.resolve();
      await disposal;
      await factoryOutcome;
      expect(inventory).not.toHaveBeenCalled();
      expect(owned.size).toBe(1);
    } finally {
      init.mockRestore();
      inventory.mockRestore();
      await Promise.all([...owned].map(adapter => adapter.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("awaits termination of its owned child while initialization is deferred", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-abort-child-"));
    const controller = new AbortController();
    const initGate = deferred<void>();
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, signal: controller.signal });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const internals = adapter as unknown as { child?: ChildProcessWithoutNullStreams; initializeTransport: () => Promise<void> };
    internals.child = child;
    internals.initializeTransport = () => initGate.promise;
    const initialization = adapter.init();
    const initializationOutcome = expect(initialization).rejects.toMatchObject({ name: "AbortError" });
    try {
      controller.abort();
      let disposalSettled = false;
      const disposal = adapter.dispose().then(() => { disposalSettled = true; });
      await Promise.resolve();
      expect(disposalSettled).toBe(false);
      initGate.resolve();
      await disposal;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await initializationOutcome;
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects disposal when the final SIGKILL wait cannot confirm owned-child exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-unconfirmed-child-"));
    const controller = new AbortController();
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, signal: controller.signal });
    const fakeChildEvents = new EventEmitter();
    const child = Object.assign(fakeChildEvents, {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    const events: Array<Record<string, unknown>> = [];
    const internals = adapter as unknown as {
      child?: ChildProcessWithoutNullStreams;
      emitEvent: (event: Record<string, unknown>) => void;
    };
    internals.child = child;
    vi.spyOn(internals, "emitEvent").mockImplementation(event => events.push(event));
    vi.useFakeTimers();
    try {
      controller.abort();
      const disposal = adapter.dispose();
      const disposalOutcome = expect(disposal).rejects.toMatchObject({ name: "OwnedChildTerminationUnconfirmedError" });
      await vi.advanceTimersByTimeAsync(2_000);
      await disposalOutcome;
      expect(events).toContainEqual(expect.objectContaining({ kind: "process.disconnected",
        data: expect.objectContaining({ reason: "owned-child-cleanup-unconfirmed", error: "OwnedChildTerminationUnconfirmedError" }) }));
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a late deferred H34 reservation UNKNOWN and never starts a thread after abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-abort-reserve-"));
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "integrator-bindings.json") });
    const policy = await createCodexProjectRuntimePolicy({ projectId: "abort-reserve", projectRoot: root, materialized: true });
    const controller = new AbortController();
    const reserveStarted = deferred<void>();
    const reserveGate = deferred<void>();
    const originalReserve = store.reserve.bind(store);
    vi.spyOn(store, "reserve").mockImplementation(async (input) => {
      reserveStarted.resolve();
      await reserveGate.promise;
      return originalReserve(input);
    });
    const owner = { resolve: async (binding: typeof policy.binding) => ({ kind: "trusted" as const,
      binding, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 10_000 }) };
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
      projectRuntimePolicy: policy, integratorSessionBindingStore: store, projectRuntimeOwner: owner,
      signal: controller.signal });
    const calls: string[] = [];
    const internals = adapter as unknown as { ensureReady: () => Promise<void>;
      assertEffectiveProjectToolIsolation: () => Promise<void>; request: (method: string) => Promise<unknown> };
    internals.ensureReady = async () => undefined;
    internals.assertEffectiveProjectToolIsolation = async () => undefined;
    internals.request = async method => { calls.push(method); return {}; };
    try {
      const create = adapter.createSession({ name: "abort-reserve", cwd: root, model: "gpt-6-luna" });
      await reserveStarted.promise;
      controller.abort();
      reserveGate.resolve();
      await expect(create).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toEqual([]);
      expect(await store.get(policy.binding.attemptId)).toMatchObject({ state: "unknown",
        attempts: [{ state: "unknown", receipt: { state: "unknown", reason: "operation_aborted_after_durable_reservation" } }] });
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume after a deferred readiness await resolves past abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-abort-resume-"));
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "abort-resume", projectRoot: root, materialized: true });
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "integrator-bindings.json") });
    const owner = { resolve: async (binding: typeof policy.binding) => ({ kind: "trusted" as const,
      binding, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 10_000 }) };
    const controller = new AbortController();
    const readiness = deferred<void>();
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
      projectRuntimePolicy: policy, integratorSessionBindingStore: store, projectRuntimeOwner: owner,
      signal: controller.signal });
    const calls: string[] = [];
    const internals = adapter as unknown as { projectThreadIds: Set<string>; ensureReady: () => Promise<void>;
      request: (method: string) => Promise<unknown> };
    internals.projectThreadIds.add("owned-thread-before-resume");
    internals.ensureReady = () => readiness.promise;
    internals.request = async method => { calls.push(method); return {}; };
    try {
      const resume = adapter.resumeSession("owned-thread-before-resume");
      controller.abort();
      readiness.resolve();
      await expect(resume).resolves.toMatchObject({ ok: false, error: "Codex adapter operation aborted" });
      expect(calls).toEqual([]);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures a late native turn ID after abort and sends no follow-up RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-abort-turn-"));
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "abort-turn", projectRoot: root, materialized: true });
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "integrator-bindings.json") });
    const controller = new AbortController();
    const turnStarted = deferred<void>();
    const turnGate = deferred<unknown>();
    const progress: Array<Record<string, unknown>> = [];
    const owner = { resolve: async (binding: typeof policy.binding) => ({ kind: "trusted" as const,
      binding, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 10_000 }) };
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
      projectRuntimePolicy: policy, integratorSessionBindingStore: store, projectRuntimeOwner: owner,
      signal: controller.signal, onMaterializationProgress: event => progress.push({ ...event }) });
    const calls: string[] = [];
    const internals = adapter as unknown as { projectThreadIds: Set<string>; ensureReady: () => Promise<void>;
      assertEffectiveProjectToolIsolation: () => Promise<void>; getSession: () => Promise<unknown>;
      request: (method: string) => Promise<unknown> };
    internals.projectThreadIds.add("owned-materialized-thread");
    internals.ensureReady = async () => undefined;
    internals.assertEffectiveProjectToolIsolation = async () => undefined;
    internals.getSession = async () => ({ id: "owned-materialized-thread", harness: "codex", status: "idle", cwd: root,
      title: "test", lastActivity: new Date().toISOString(), model: "gpt-6-luna", meta: {} });
    internals.request = async method => {
      calls.push(method);
      if (method === "turn/start") { turnStarted.resolve(); return turnGate.promise; }
      return {};
    };
    try {
      const send = adapter.sendMessage("owned-materialized-thread", { message: "one bounded turn", origin: "human", model: "gpt-6-luna" });
      await turnStarted.promise;
      controller.abort();
      turnGate.resolve({ turn: { id: "late-turn-id", status: "inProgress" } });
      const result = await send;
      expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      expect(calls).toEqual(["turn/start"]);
      expect(progress).toContainEqual(expect.objectContaining({ phase: "turn_admitted", turnId: "late-turn-id" }));
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes once into the H34 journal and restores the accepted same ID with fresh scope proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-materialized-"));
    const journal = join(root, "integrator-bindings.json");
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const store = new IntegratorSessionBindingStore({ persistencePath: journal });
    const policy = await createCodexProjectRuntimePolicy({ projectId: "materialized-test", projectRoot: root, materialized: true });
    const progress: Array<Record<string, unknown>> = [];
    const runtimeOwner = { resolve: async (binding: typeof policy.binding) => ({
      kind: "trusted" as const, binding, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 10_000,
    }) };
    const first = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
      projectRuntimePolicy: policy, projectToolDenyList: { mcpServerIds: [], appIds: [], pluginIds: [] },
      integratorSessionBindingStore: store, projectRuntimeOwner: runtimeOwner,
      onMaterializationProgress: event => progress.push({ ...event }) });
    const firstCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const firstInternals = first as unknown as {
      ensureReady: () => Promise<void>;
      assertEffectiveProjectToolIsolation: (id?: string) => Promise<void>;
      listModels: () => Promise<string[]>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
    firstInternals.ensureReady = async () => undefined;
    firstInternals.assertEffectiveProjectToolIsolation = async () => undefined;
    firstInternals.listModels = async () => ["gpt-6-luna"];
    firstInternals.request = async (method, params) => {
      firstCalls.push({ method, params });
      return {
        activePermissionProfile: { id: policy.permissionProfileId },
        runtimeWorkspaceRoots: [root],
        thread: { id: "h34-materialized-native-id", cwd: root, ephemeral: false, model: "gpt-6-luna", status: "idle" },
      };
    };
    try {
      const created = await first.createSession({ name: "materialized", cwd: root, model: "gpt-6-luna" });
      expect(created.id).toBe("h34-materialized-native-id");
      expect(firstCalls.map(call => call.method)).toEqual(["thread/start"]);
      expect(firstCalls[0]?.params).toMatchObject({ ephemeral: false, model: "gpt-6-luna", runtimeWorkspaceRoots: [root] });
      expect(progress.map(event => event.phase)).toEqual(["reserved", "native_created", "accepted"]);
      const accepted = await store.get(policy.binding.attemptId);
      expect(accepted).toMatchObject({ state: "accepted", operationId: policy.binding.attemptId,
        attempts: [{ state: "accepted", address: { nativeSessionId: created.id }, receipt: { state: "created" } }] });
      expect(progress).toContainEqual(expect.objectContaining({ phase: "native_created", operationId: policy.binding.attemptId,
        inputId: accepted?.attempts.at(-1)?.inputId, threadId: created.id }));
      await expect(first.createSession({ name: "must-not-duplicate", cwd: root, model: "gpt-6-luna" }))
        .rejects.toThrow("already reserved or terminal; no create replay permitted");
      expect(firstCalls.map(call => call.method)).toEqual(["thread/start"]);
      await first.dispose();

      const restoredPolicy = await restoreCodexProjectRuntimePolicy({ projectId: "materialized-test", projectRoot: root,
        operationId: policy.binding.attemptId, store, nativeDataHome: nativeHome });
      expect(restoredPolicy.binding.attemptId).toBe(policy.binding.attemptId);
      expect(restoredPolicy.binding.runtimeInstanceId).not.toBe(policy.binding.runtimeInstanceId);
      const second = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
        projectRuntimePolicy: restoredPolicy, projectToolDenyList: { mcpServerIds: [], appIds: [], pluginIds: [] },
        integratorSessionBindingStore: store, projectRuntimeOwner: runtimeOwner });
      const secondCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
      const secondInternals = second as unknown as {
        ensureReady: () => Promise<void>;
        assertEffectiveProjectToolIsolation: (id?: string) => Promise<void>;
        request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      };
      secondInternals.ensureReady = async () => undefined;
      secondInternals.assertEffectiveProjectToolIsolation = async () => undefined;
      secondInternals.request = async (method, params) => {
        secondCalls.push({ method, params });
        return {
          activePermissionProfile: { id: restoredPolicy.permissionProfileId },
          runtimeWorkspaceRoots: [root],
          thread: { id: "h34-materialized-native-id", cwd: root, ephemeral: false, model: "gpt-6-luna", status: "idle" },
        };
      };
      await expect(second.restoreMaterializedSession()).resolves.toEqual({ ok: true, sessionId: created.id });
      expect(secondCalls.map(call => call.method)).toEqual(["thread/read", "thread/resume"]);
      expect(secondCalls.every(call => call.params?.threadId === created.id)).toBe(true);
      expect(await store.get(policy.binding.attemptId)).toMatchObject({ state: "accepted", attempts: [{ address: { nativeSessionId: created.id } }] });
      await second.dispose();
    } finally {
      await first.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses materialized UNKNOWN operation reuse before any native create", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-materialized-unknown-"));
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "integrator-bindings.json") });
    const policy = await createCodexProjectRuntimePolicy({ projectId: "unknown-test", projectRoot: root, materialized: true });
    const rootStat = await stat(root);
    const homeStat = await stat(nativeHome);
    const reservation = await store.reserve({ operationId: policy.binding.attemptId, hostId: policy.binding.hostId, harness: "codex",
      scope: { projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
        policyRevision: policy.binding.policyRevision, hostId: policy.binding.hostId, harness: "codex",
        harnessVersion: "test-version", canonicalRoot: { path: root, device: rootStat.dev, inode: rootStat.ino },
        nativeDataHome: { path: nativeHome, device: homeStat.dev, inode: homeStat.ino } } });
    await store.record({ operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
      receipt: { state: "unknown", inputId: reservation.attempt.inputId, retryable: false, reason: "test-unknown" } });
    const owner = { resolve: async (binding: typeof policy.binding) => ({ kind: "trusted" as const,
      binding, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 10_000 }) };
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, cwd: root, codexDir: nativeHome,
      projectRuntimePolicy: policy, integratorSessionBindingStore: store, projectRuntimeOwner: owner });
    const calls: string[] = [];
    const internals = adapter as unknown as { ensureReady: () => Promise<void>; assertEffectiveProjectToolIsolation: () => Promise<void>;
      request: (method: string) => Promise<unknown> };
    internals.ensureReady = async () => undefined;
    internals.assertEffectiveProjectToolIsolation = async () => undefined;
    internals.request = async method => { calls.push(method); return {}; };
    try {
      await expect(adapter.createSession({ name: "must-not-replay", cwd: root, model: "gpt-6-luna" }))
        .rejects.toThrow("already reserved or terminal; no create replay permitted");
      expect(calls).toEqual([]);
      expect((await store.get(policy.binding.attemptId))?.state).toBe("unknown");
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps project policy constructor-only and refuses shared or caller-overridden transports", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-policy-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "test-project", projectRoot: root });
    try {
      expect(() => new CodexAppServerAdapter({ codexBin: "/unused", projectRuntimePolicy: policy, socketPath: join(root, "shared.sock") }))
        .toThrow("requires its own app-server process");
      expect(() => new CodexAppServerAdapter({ codexBin: "/unused", projectRuntimePolicy: policy, args: ["app-server", "--config", "anything=1"] }))
        .toThrow("requires its own app-server process");
      expect(() => new CodexAppServerAdapter({ codexBin: "/unused", projectToolDenyList: { mcpServerIds: [], appIds: [], pluginIds: [] } }))
        .toThrow("require a trusted project runtime policy");
      const scoped = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
      expect((scoped as unknown as { processArgs: string[] }).processArgs).toContain("apps._default.enabled=false");
      expect((scoped as unknown as { processArgs: string[] }).processArgs).not.toContain("mcp_servers={}");
      const denied = new CodexAppServerAdapter({
        codexBin: "codex", projectRuntimePolicy: policy, cwd: root,
        projectToolDenyList: { mcpServerIds: ["mcp-one"], appIds: ["app-one"], pluginIds: ["plugin@market"] },
      });
      const args = (denied as unknown as { processArgs: string[] }).processArgs.join(" ");
      expect(args).toContain("mcp_servers.mcp-one.enabled=false");
      expect(args).toContain("apps.app-one.enabled=false");
      expect(args).toContain("plugins.plugin@market.enabled=false");
      await scoped.dispose();
      await denied.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ephemeral project thread naming in adapter memory without metadata RPCs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-ephemeral-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "ephemeral-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const calls: string[] = [];
    const internals = adapter as unknown as {
      ensureReady: () => Promise<void>;
      assertEffectiveProjectToolIsolation: (threadId?: string) => Promise<void>;
      listModels: () => Promise<string[]>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
    internals.ensureReady = async () => undefined;
    internals.assertEffectiveProjectToolIsolation = async () => undefined;
    internals.listModels = async () => ["gpt-6-luna"];
    internals.request = async (method) => {
      calls.push(method);
      if (method !== "thread/start") throw new Error(`unexpected RPC ${method}`);
      return {
        activePermissionProfile: { id: policy.permissionProfileId },
        runtimeWorkspaceRoots: [root],
        thread: { id: "ephemeral-thread", cwd: root, model: "gpt-6-luna", status: "idle" },
      };
    };
    try {
      const session = await adapter.createSession({ name: "project-local label", cwd: root, model: "gpt-6-luna" });
      expect(session.title).toBe("project-local label");
      expect(calls).toEqual(["thread/start"]);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects foreign project resume and recover before native RPC and preserves owned provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-resume-admission-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "resume-admission-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let readyCalls = 0;
    const internals = adapter as unknown as {
      projectThreadIds: Set<string>;
      ensureReady: () => Promise<void>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
    internals.ensureReady = async () => { readyCalls++; };
    internals.request = async (method, params) => {
      calls.push({ method, params });
      return {
        thread: { id: params?.threadId as string, cwd: root },
        activePermissionProfile: { id: policy.permissionProfileId },
        runtimeWorkspaceRoots: [root],
      };
    };
    try {
      await expect(adapter.resumeSession("foreign-thread")).resolves.toMatchObject({ ok: false, nonRetryable: true });
      await expect(adapter.recover("foreign-thread", "must not fork")).resolves.toMatchObject({ ok: false, nonRetryable: true });
      expect(readyCalls).toBe(0);
      expect(calls).toEqual([]);

      internals.projectThreadIds.add("owned-project-thread");
      await expect(adapter.resumeSession("owned-project-thread")).resolves.toEqual({ ok: true });
      expect(calls).toEqual([{
        method: "thread/resume",
        params: {
          threadId: "owned-project-thread",
          permissions: policy.permissionProfileId,
          runtimeWorkspaceRoots: [root],
        },
      }]);
      expect(readyCalls).toBe(1);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale project root before initializing or resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-stale-resume-root-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "stale-resume-root-test", projectRoot: root });
    const stalePolicy = Object.freeze({ ...policy, rootInode: policy.rootInode + 1 });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: stalePolicy, cwd: root });
    const calls: string[] = [];
    let readyCalls = 0;
    const internals = adapter as unknown as {
      projectThreadIds: Set<string>;
      ensureReady: () => Promise<void>;
      request: (method: string) => Promise<unknown>;
    };
    internals.projectThreadIds.add("owned-project-thread");
    internals.ensureReady = async () => { readyCalls++; };
    internals.request = async (method) => { calls.push(method); return {}; };
    try {
      await expect(adapter.resumeSession("owned-project-thread")).resolves.toMatchObject({ ok: false, nonRetryable: true });
      await expect(adapter.recover("owned-project-thread")).resolves.toMatchObject({ ok: false, nonRetryable: true });
      expect(readyCalls).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses foreign project history reads before transcript access, initialization, or RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-foreign-history-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "foreign-history-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const calls = { transcript: 0, observation: 0, session: 0, messages: 0, firstUser: 0, ready: 0, rpc: [] as string[] };
    type TranscriptReads = {
      getRawTranscript: (id: string) => Promise<unknown>;
      getSessionObservation: (id: string) => Promise<unknown>;
      getSession: (id: string) => Promise<unknown>;
      getSessionMessages: (id: string, limit?: number) => Promise<unknown>;
      getFirstUserMessage: (id: string) => Promise<unknown>;
    };
    const internals = adapter as unknown as {
      isReady: () => boolean;
      ensureReady: () => Promise<void>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      rawTranscriptAdapter: TranscriptReads;
    };
    internals.isReady = () => true;
    internals.ensureReady = async () => { calls.ready++; };
    internals.request = async (method) => { calls.rpc.push(method); return {}; };
    internals.rawTranscriptAdapter.getRawTranscript = async () => { calls.transcript++; return null; };
    internals.rawTranscriptAdapter.getSessionObservation = async () => { calls.observation++; return null; };
    internals.rawTranscriptAdapter.getSession = async () => { calls.session++; return null; };
    internals.rawTranscriptAdapter.getSessionMessages = async () => { calls.messages++; return null; };
    internals.rawTranscriptAdapter.getFirstUserMessage = async () => { calls.firstUser++; return null; };
    try {
      await expect(adapter.getRawTranscript("foreign-thread")).resolves.toBeNull();
      await expect(adapter.getSessionMessages("foreign-thread")).resolves.toBeNull();
      await expect(adapter.getFirstUserMessage("foreign-thread")).resolves.toBeNull();
      await expect(adapter.getSession("foreign-thread")).resolves.toBeNull();
      await expect(adapter.getSession("foreign-thread", { includeMetrics: true })).resolves.toBeNull();
      await expect(adapter.readTrackedTurnCompletion("foreign-thread", "foreign-turn", root)).resolves.toBeNull();
      expect(calls).toEqual({ transcript: 0, observation: 0, session: 0, messages: 0, firstUser: 0, ready: 0, rpc: [] });
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses owned project history reads after the bound root becomes stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-stale-history-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "stale-history-test", projectRoot: root });
    const stalePolicy = Object.freeze({ ...policy, rootInode: policy.rootInode + 1 });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: stalePolicy, cwd: root });
    const calls = { transcript: 0, observation: 0, session: 0, messages: 0, firstUser: 0, ready: 0, rpc: [] as string[] };
    type TranscriptReads = {
      getRawTranscript: (id: string) => Promise<unknown>;
      getSessionObservation: (id: string) => Promise<unknown>;
      getSession: (id: string) => Promise<unknown>;
      getSessionMessages: (id: string, limit?: number) => Promise<unknown>;
      getFirstUserMessage: (id: string) => Promise<unknown>;
    };
    const internals = adapter as unknown as {
      projectThreadIds: Set<string>;
      isReady: () => boolean;
      ensureReady: () => Promise<void>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      rawTranscriptAdapter: TranscriptReads;
    };
    internals.projectThreadIds.add("owned-thread");
    internals.isReady = () => true;
    internals.ensureReady = async () => { calls.ready++; };
    internals.request = async (method) => { calls.rpc.push(method); return {}; };
    internals.rawTranscriptAdapter.getRawTranscript = async () => { calls.transcript++; return null; };
    internals.rawTranscriptAdapter.getSessionObservation = async () => { calls.observation++; return null; };
    internals.rawTranscriptAdapter.getSession = async () => { calls.session++; return null; };
    internals.rawTranscriptAdapter.getSessionMessages = async () => { calls.messages++; return null; };
    internals.rawTranscriptAdapter.getFirstUserMessage = async () => { calls.firstUser++; return null; };
    try {
      await expect(adapter.getRawTranscript("owned-thread")).resolves.toBeNull();
      await expect(adapter.getSessionMessages("owned-thread")).resolves.toBeNull();
      await expect(adapter.getFirstUserMessage("owned-thread")).resolves.toBeNull();
      await expect(adapter.getSession("owned-thread")).resolves.toBeNull();
      await expect(adapter.getSession("owned-thread", { includeMetrics: true })).resolves.toBeNull();
      await expect(adapter.readTrackedTurnCompletion("owned-thread", "turn-1", root)).resolves.toBeNull();
      expect(calls).toEqual({ transcript: 0, observation: 0, session: 0, messages: 0, firstUser: 0, ready: 0, rpc: [] });
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits owned project history reads while the bound root remains current", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-owned-history-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "owned-history-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const calls = { transcript: 0, observation: 0, session: 0, messages: 0, firstUser: 0, rpc: [] as string[] };
    type TranscriptReads = {
      getRawTranscript: (id: string) => Promise<unknown>;
      getSessionObservation: (id: string) => Promise<unknown>;
      getSession: (id: string) => Promise<unknown>;
      getSessionMessages: (id: string, limit?: number) => Promise<unknown>;
      getFirstUserMessage: (id: string) => Promise<unknown>;
    };
    const internals = adapter as unknown as {
      projectThreadIds: Set<string>;
      isReady: () => boolean;
      ensureReady: () => Promise<void>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      rawTranscriptAdapter: TranscriptReads;
    };
    internals.projectThreadIds.add("owned-thread");
    internals.isReady = () => true;
    internals.ensureReady = async () => undefined;
    internals.request = async (method, params) => {
      calls.rpc.push(method);
      if (method === "thread/read") return { thread: { id: params?.threadId, cwd: root, status: "idle" } };
      if (method === "thread/turns/list") return { data: [] };
      return {};
    };
    internals.rawTranscriptAdapter.getRawTranscript = async () => { calls.transcript++; return null; };
    internals.rawTranscriptAdapter.getSessionObservation = async () => { calls.observation++; return null; };
    internals.rawTranscriptAdapter.getSession = async () => { calls.session++; return null; };
    internals.rawTranscriptAdapter.getSessionMessages = async () => { calls.messages++; return []; };
    internals.rawTranscriptAdapter.getFirstUserMessage = async () => { calls.firstUser++; return null; };
    try {
      await expect(adapter.getRawTranscript("owned-thread")).resolves.toBeNull();
      await expect(adapter.getSessionMessages("owned-thread")).resolves.toEqual([]);
      await expect(adapter.getFirstUserMessage("owned-thread")).resolves.toBeNull();
      await expect(adapter.getSession("owned-thread", { includeMetrics: true })).resolves.toMatchObject({ id: "owned-thread", cwd: root });
      await expect(adapter.readTrackedTurnCompletion("owned-thread", "turn-1", root)).resolves.toBeNull();
      expect(calls).toEqual({ transcript: 1, observation: 1, session: 1, messages: 1, firstUser: 1, rpc: ["thread/read", "thread/turns/list", "thread/read"] });
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scoped cold session listing never delegates to the global transcript index", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "cold-scoped-list-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const { calls } = stubScopedCollectionReads(adapter, {
      root,
      ready: false,
      listedThreads: [{ id: "foreign-archive", name: "foreign", cwd: root, status: "idle" }],
    });
    try {
      await expect(adapter.listSessions()).resolves.toEqual([]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("scoped ready session listing returns only in-memory owned IDs", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "ready-scoped-list-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const { calls, internals } = stubScopedCollectionReads(adapter, {
      root,
      ready: true,
      listedThreads: [{ id: "foreign-native", name: "foreign", cwd: root, status: "idle" }],
      loadedIds: ["foreign-loaded"],
      unmaterializedIds: ["foreign-indexed"],
    });
    internals.projectThreadIds.add("owned-thread");
    internals.threads.set("owned-thread", { id: "owned-thread", name: "owned", cwd: root, status: "idle" });
    internals.threads.set("foreign-cached", { id: "foreign-cached", name: "foreign cached", cwd: root, status: "idle" });
    try {
      await expect(adapter.listSessions()).resolves.toMatchObject([{ id: "owned-thread", title: "owned", cwd: root }]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("stale project root empties scoped session listing before readiness or reads", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "stale-scoped-list-test", projectRoot: root });
    const stalePolicy = Object.freeze({ ...policy, rootInode: policy.rootInode + 1 });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: stalePolicy, cwd: root });
    const { calls, internals } = stubScopedCollectionReads(adapter, {
      root,
      ready: false,
      listedThreads: [{ id: "foreign-archive", name: "foreign", cwd: root, status: "idle" }],
    });
    internals.projectThreadIds.add("owned-thread");
    internals.threads.set("owned-thread", { id: "owned-thread", name: "owned", cwd: root, status: "idle" });
    try {
      await expect(adapter.listSessions()).resolves.toEqual([]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("scoped named lookup ignores foreign index candidates before native reads", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "foreign-scoped-name-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const { calls } = stubScopedCollectionReads(adapter, {
      root,
      ready: true,
      namedThreads: [{ id: "foreign-named", name: "repair", cwd: root, status: "idle" }],
    });
    try {
      await expect(adapter.findNamedSessions("repair", root)).resolves.toEqual([]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("stale project root empties scoped named lookup before readiness or reads", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "stale-scoped-name-test", projectRoot: root });
    const stalePolicy = Object.freeze({ ...policy, rootInode: policy.rootInode + 1 });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: stalePolicy, cwd: root });
    const { calls, internals } = stubScopedCollectionReads(adapter, {
      root,
      ready: true,
      namedThreads: [{ id: "owned-thread", name: "repair", cwd: root, status: "idle" }],
    });
    internals.projectThreadIds.add("owned-thread");
    internals.threads.set("owned-thread", { id: "owned-thread", name: "repair", cwd: root, status: "idle" });
    try {
      await expect(adapter.findNamedSessions("repair", root)).resolves.toEqual([]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("scoped collection reads preserve positive access to locally owned threads", async () => {
    const root = process.cwd();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "owned-scoped-collection-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const { calls, internals } = stubScopedCollectionReads(adapter, {
      root,
      ready: false,
      listedThreads: [{ id: "foreign-native", name: "repair", cwd: root, status: "idle" }],
      namedThreads: [{ id: "foreign-named", name: "repair", cwd: root, status: "idle" }],
    });
    internals.projectThreadIds.add("owned-thread");
    internals.threads.set("owned-thread", { id: "owned-thread", name: "repair", cwd: root, status: "idle" });
    try {
      await expect(adapter.listSessions()).resolves.toMatchObject([{ id: "owned-thread", title: "repair", cwd: root }]);
      await expect(adapter.findNamedSessions("repair", root)).resolves.toMatchObject([{ id: "owned-thread", title: "repair", cwd: root }]);
      expect(calls).toEqual({ ready: 0, rpc: [], rawList: 0, rawIndex: 0, rawMetadata: 0, rawNamed: 0 });
    } finally {
      await adapter.dispose();
    }
  });

  it("resolves only server-owned current project scope, homes, root identity, and native version", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-scope-root-"));
    const appHome = await mkdtemp(join(tmpdir(), "agent-herder-codex-app-home-"));
    const readerHome = await mkdtemp(join(tmpdir(), "agent-herder-codex-reader-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexDataDir = process.env.CODEX_DATA_DIR;
    process.env.CODEX_HOME = appHome;
    process.env.CODEX_DATA_DIR = readerHome;
    const restoreEnvironment = () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexDataDir === undefined) delete process.env.CODEX_DATA_DIR;
      else process.env.CODEX_DATA_DIR = previousCodexDataDir;
    };
    let adapter: CodexAppServerAdapter | undefined;
    try {
      const policy = await createCodexProjectRuntimePolicy({ projectId: "current-scope-evidence-test", projectRoot: root });
      adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
      const calls = { version: 0, rpc: [] as string[] };
      const internals = adapter as unknown as {
        verifiedNativeHarnessVersion: () => Promise<string | null>;
        projectChildEnvironment: () => NodeJS.ProcessEnv | undefined;
        transcriptReaderDataHome: string;
        rawTranscriptAdapter: { codexDir: string };
        request: (method: string) => Promise<unknown>;
      };
      internals.verifiedNativeHarnessVersion = async () => { calls.version++; return "codex-cli 0.162.1-test"; };
      internals.request = async (method) => { calls.rpc.push(method); return {}; };
      const input = {
        projectId: policy.binding.projectId,
        rootIdentity: policy.binding.rootIdentity,
        policyRevision: policy.binding.policyRevision,
        hostId: policy.binding.hostId,
        harness: "codex" as const,
      };

      await expect(adapter.resolveCurrentProjectScope({ ...input, rootIdentity: "caller-asserted-wrong-root" })).resolves.toBeNull();
      expect(calls).toEqual({ version: 0, rpc: [] });

      const evidence = await adapter.resolveCurrentProjectScope(input);
      expect(evidence).not.toBeNull();
      expect(evidence).toMatchObject({
        binding: policy.binding,
        canonicalRoot: { path: policy.rootPath, device: policy.rootDevice, inode: policy.rootInode },
        harnessVersion: "codex-cli 0.162.1-test",
        appServerDataHome: { path: appHome },
        transcriptReaderDataHome: { path: readerHome },
      });
      expect(internals.transcriptReaderDataHome).toBe(readerHome);
      expect(internals.rawTranscriptAdapter.codexDir).toBe(readerHome);
      expect(internals.projectChildEnvironment()?.CODEX_HOME).toBe(appHome);
      expect((await stat(appHome)).dev).toBe(evidence?.appServerDataHome.device);
      expect((await stat(appHome)).ino).toBe(evidence?.appServerDataHome.inode);
      expect((await stat(readerHome)).dev).toBe(evidence?.transcriptReaderDataHome.device);
      expect((await stat(readerHome)).ino).toBe(evidence?.transcriptReaderDataHome.inode);
      expect(calls).toEqual({ version: 1, rpc: [] });

      const stalePolicy = Object.freeze({ ...policy, rootInode: policy.rootInode + 1 });
      const staleAdapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: stalePolicy, cwd: root });
      const staleInternals = staleAdapter as unknown as {
        verifiedNativeHarnessVersion: () => Promise<string | null>;
        request: (method: string) => Promise<unknown>;
      };
      staleInternals.verifiedNativeHarnessVersion = async () => { calls.version++; return "codex-cli 0.162.1-test"; };
      staleInternals.request = async (method) => { calls.rpc.push(method); return {}; };
      try {
        await expect(staleAdapter.resolveCurrentProjectScope(input)).resolves.toBeNull();
        expect(calls).toEqual({ version: 1, rpc: [] });
      } finally {
        await staleAdapter.dispose();
      }
    } finally {
      await adapter?.dispose();
      restoreEnvironment();
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(appHome, { recursive: true, force: true }),
        rm(readerHome, { recursive: true, force: true }),
      ]);
    }
  });

  it("uses fresh native state for an owned ephemeral thread before its first rollout exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-ephemeral-state-"));
    const policy = await createCodexProjectRuntimePolicy({ projectId: "ephemeral-state-test", projectRoot: root });
    const adapter = new CodexAppServerAdapter({ codexBin: "codex", projectRuntimePolicy: policy, cwd: root });
    const threadId = "ephemeral-before-first-turn";
    const internals = adapter as unknown as {
      ensureReady: () => Promise<void>;
      request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      initialized: boolean;
      child: { killed: boolean; kill: () => void };
      projectThreadIds: Set<string>;
      projectLiveMessages: Map<string, import("../src/types/index.js").SessionMessageView[]>;
      assertEffectiveProjectToolIsolation: (threadId?: string) => Promise<void>;
      consumeMessage: (message: { method: string; params: Record<string, unknown> }) => void;
      rawTranscriptAdapter: {
        getSessionObservation: (id: string) => Promise<never>;
        getSessionMessages: (id: string, limit: number) => Promise<never>;
      };
    };
    internals.ensureReady = async () => undefined;
    internals.initialized = true;
    internals.child = { killed: false, kill: () => undefined };
    internals.projectThreadIds.add(threadId);
    internals.projectLiveMessages.set(threadId, []);
    internals.assertEffectiveProjectToolIsolation = async () => undefined;
    const calls: string[] = [];
    internals.request = async (method, params) => {
      calls.push(method);
      if (method === "thread/read") return { thread: {
        id: threadId, cwd: root, model: "gpt-6-luna", status: "idle", ephemeral: true,
        ...(params?.includeTurns ? { turns: [{ id: "turn-ephemeral", status: "completed", items: [
          { id: "user-item", type: "userMessage", content: [{ type: "text", text: "harmless fixture" }] },
          { id: "assistant-item", type: "agentMessage", phase: "final_answer", text: "done" },
        ] }] } : {}),
      } };
      if (method === "thread/turns/list") return { data: [] };
      if (method === "turn/start") {
        internals.consumeMessage({ method: "item/commandExecution/outputDelta", params: {
          threadId, turnId: "turn-ephemeral", itemId: "command-item", delta: "{\"inside_read\":false}",
        } });
        internals.consumeMessage({ method: "item/completed", params: {
          threadId, turnId: "turn-ephemeral", item: { id: "command-item", type: "commandExecution", aggregatedOutput: "" },
        } });
        internals.consumeMessage({ method: "item/completed", params: {
          threadId, turnId: "turn-ephemeral", item: { id: "assistant-item", type: "agentMessage", phase: "final_answer", text: "done" },
        } });
        return { turn: { id: "turn-ephemeral", status: "completed" } };
      }
      throw new Error(`unexpected RPC ${method}`);
    };
    internals.rawTranscriptAdapter.getSessionObservation = async () => {
      throw new Error(`no rollout found for thread id ${threadId}`);
    };
    internals.rawTranscriptAdapter.getSessionMessages = async () => {
      throw new Error(`no rollout found for thread id ${threadId}`);
    };
    try {
      await expect(adapter.getSession(threadId)).resolves.toMatchObject({
        id: threadId,
        model: "gpt-6-luna",
        cwd: root,
        status: "idle",
      });
      const sent = await adapter.sendMessage(threadId, {
        model: "gpt-6-luna", message: "harmless fixture", origin: "human", queue: true,
      });
      expect(sent).toMatchObject({ ok: true, turnId: "turn-ephemeral" });
      expect(calls).toContain("turn/start");
      expect(calls).not.toContain("thread/resume");
      await expect(adapter.getSessionMessages(threadId)).resolves.toEqual([
        { id: "turn-ephemeral:user", role: "user", turnId: "turn-ephemeral", text: "harmless fixture", parts: [{ type: "text", text: "harmless fixture" }] },
        { id: "command-item", role: "tool", turnId: "turn-ephemeral", text: "{\"inside_read\":false}", parts: [{ type: "tool_result", output: "{\"inside_read\":false}" }] },
        { id: "assistant-item", role: "assistant", turnId: "turn-ephemeral", phase: "final_answer", text: "done", parts: [{ type: "text", text: "done" }] },
      ]);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a Unix socket that accepts but never upgrades the WebSocket", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-unix-timeout-"));
    const socketPath = join(tempDir, "app-server.sock");
    const server = createNetServer((socket) => socket.on("data", () => {}));
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const adapter = new CodexAppServerAdapter({
      codexBin: "/definitely/not-started",
      socketPath,
      requestTimeoutMs: 100,
    });
    try {
      await listening;
      await expect(adapter.init()).rejects.toThrow(/timed out/i);
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shares an existing app-server Unix socket for thread control", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-unix-socket-"));
    const socketPath = join(tempDir, "app-server.sock");
    const codexDir = join(tempDir, "codex");
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(tempDir, "human-stops.json");
    const sessionDir = join(codexDir, "sessions", "2026", "10", "05");
    const rolloutPath = join(sessionDir, "rollout-thread-unix.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rolloutPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-unix", session_id: "thread-unix", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text, is_pinned integer)");
    db.exec("create table thread_spawn_edges (child_thread_id text, parent_thread_id text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "thread-unix", rolloutPath, "/workspace", null, "", Date.now(), null, null, 0,
    );
    db.close();
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    const methods: string[] = [];
    const interruptTurnIds: string[] = [];
    const events: Array<{ kind: string; data?: { automationStop?: unknown } }> = [];
    let activeTurnId: string | undefined;
    let turnSequence = 0;
    let disconnectAfterTurnStart = false;
    let threadReadStatus: { type: string; activeFlags?: string[] } = { type: "idle" };
    const thread = {
      id: "thread-unix",
      cwd: "/workspace",
      name: "Unix socket fixture",
      model: null,
      status: "idle",
    };
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          id?: number;
          method?: string;
          params?: { threadId?: string; turnId?: string; expectedTurnId?: string; input?: Array<{ text?: string }> };
        };
        if (!request.method) return;
        methods.push(request.method);
        const reply = (result: unknown) => {
          if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result }));
        };
        if (request.method === "initialize") return reply({ userAgent: "fixture" });
        if (request.method === "thread/list") return reply({ data: [thread], nextCursor: null });
        if (request.method === "thread/read") return reply({ thread: { ...thread, status: threadReadStatus } });
        if (request.method === "thread/resume") return reply({ thread });
        if (request.method === "thread/turns/list") return reply({
          data: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [],
          nextCursor: null,
          backwardsCursor: null,
        });
        if (request.method === "turn/steer") {
          expect(request.params?.expectedTurnId).toBe(activeTurnId);
          return reply({ turnId: activeTurnId });
        }
        if (request.method === "turn/start") {
          activeTurnId = `turn-unix-${++turnSequence}`;
          socket.send(JSON.stringify({
            method: "turn/started",
            params: { threadId: request.params?.threadId, turn: { id: activeTurnId, status: "inProgress" } },
          }));
          reply({ turn: { id: activeTurnId, status: "inProgress" } });
          if (disconnectAfterTurnStart) {
            disconnectAfterTurnStart = false;
            setTimeout(() => socket.terminate(), 0);
          }
          return;
        }
        if (request.method === "turn/interrupt") {
          interruptTurnIds.push(request.params?.turnId || "");
          activeTurnId = undefined;
          socket.send(JSON.stringify({
            method: "turn/completed",
            params: { threadId: request.params?.threadId, turn: { id: request.params?.turnId, status: "interrupted" } },
          }));
          return reply({});
        }
        reply({});
      });
    });

    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let adapter: CodexAppServerAdapter | undefined;
    const restoreProcessProbes: Array<() => void> = [];
    try {
      await listening;
      adapter = new CodexAppServerAdapter({
        codexBin: "/definitely/not-started", socketPath, codexDir, requestTimeoutMs: 1_000,
      });
      // This fixture has no native Codex process: its real socket server and
      // SQLite/rollout belong to this test. Host-wide pgrep/proc enumeration
      // is unrelated to the protocol assertions and scales with live tenants.
      const transcript = (adapter as unknown as {
        rawTranscriptAdapter: {
          getRunningCodexPids(): Promise<Map<string, number>>;
          getOpenCodexRolloutPaths(): Promise<Set<string> | null>;
        };
      }).rawTranscriptAdapter;
      const runningPids = vi.spyOn(transcript, "getRunningCodexPids").mockResolvedValue(new Map());
      const rolloutWriters = vi.spyOn(transcript, "getOpenCodexRolloutPaths").mockResolvedValue(new Set());
      restoreProcessProbes.push(() => runningPids.mockRestore(), () => rolloutWriters.mockRestore());
      const unsubscribe = adapter.subscribeEvents((event) => events.push({ kind: event.kind, data: event.data }));
      await adapter.init();
      expect(adapter.isReady()).toBe(true);
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-unix", title: "Unix socket fixture", status: "idle" }]);
      expect(sessions[0]).not.toHaveProperty("model");
      expect(sessions[0].meta).not.toHaveProperty("status");
      const liveSession = await adapter.getSession("thread-unix");
      expect(liveSession).toMatchObject({ id: "thread-unix", status: "idle", needsPermission: false });
      expect(liveSession).not.toHaveProperty("model");
      expect(liveSession?.meta).not.toHaveProperty("status");
      threadReadStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "needs_input", needsPermission: true,
      });
      threadReadStatus = { type: "idle" };
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "idle", needsPermission: false,
      });
      await expect(adapter.sendMessage("thread-unix", { message: "hold", queue: true })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", meta: { activeTurnId: "turn-unix-1" },
      });
      const beforeSteer = methods.length;
      await expect(adapter.sendMessage("thread-unix", { message: "automated coordination", origin: "automation" })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      expect(methods.slice(beforeSteer)).toContain("turn/steer");
      expect(methods.slice(beforeSteer)).not.toContain("turn/start");
      expect(methods.slice(beforeSteer)).not.toContain("thread/resume");
      expect(activeTurnId).toBe("turn-unix-1");
      const beforeExplicitSteer = methods.length;
      await expect(adapter.sendMessage("thread-unix", { message: "explicit steer", steer: true, origin: "human" })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      expect(methods.slice(beforeExplicitSteer)).toContain("turn/steer");
      threadReadStatus = { type: "active", activeFlags: ["waitingOnUserInput"] };
      const beforeNeedsInput = methods.length;
      await expect(adapter.sendMessage("thread-unix", { message: "do not answer", origin: "automation" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
      expect(methods.slice(beforeNeedsInput)).not.toContain("turn/steer");
      expect(methods.slice(beforeNeedsInput)).not.toContain("turn/start");
      threadReadStatus = { type: "idle" };
      activeTurnId = undefined;
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "idle", meta: { activeTurnId: undefined },
      });
      disconnectAfterTurnStart = true;
      await expect(adapter.sendMessage("thread-unix", { message: "hold after fresh status", queue: true })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      for (let attempt = 0; attempt < 100 && adapter.isReady(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(adapter.isReady()).toBe(false);
      expect(events.some((event) => event.kind === "turn.failed")).toBe(false);
      expect(events.some((event) => event.kind === "process.disconnected")).toBe(true);
      await expect(adapter.cancelTurn("thread-unix")).resolves.toEqual({ ok: true });
      expect(adapter.isReady()).toBe(true);
      expect(interruptTurnIds).toEqual(["turn-unix-2"]);
      expect(events.filter((event) => event.kind === "turn.completed").every((event) => !event.data?.automationStop)).toBe(true);
      expect(JSON.parse(await readFile(join(tempDir, "human-stops.json"), "utf8"))).toMatchObject({
        sessions: [expect.objectContaining({ ignoredStopIds: ["turn-unix-2"] })],
      });
      await writeFile(rolloutPath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-06T12:34:56.000Z",
        payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn-unix-2" },
      })}\n`, { flag: "a" });
      const restartedNativeMetadata = await new CodexAdapter({ codexDir }).getNativeAutomationMetadata("thread-unix");
      expect(restartedNativeMetadata.automationStop).toMatchObject({
        id: "turn-unix-2", turnId: "turn-unix-2", reason: "interrupted",
      });
      await expect(getHumanStopStore().observe({
        id: "thread-unix", harness: "codex", status: "idle", title: "Unix socket fixture", cwd: "/workspace",
        lastActivity: new Date().toISOString(), needsPermission: false, meta: restartedNativeMetadata,
      })).resolves.toBe(false);

      const publishTerminalTurn = (id: string, status: "interrupted" | "completed" | "failed") => {
        for (const client of webSocketServer.clients) {
          client.send(JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-unix", turn: { id, status, completedAt: "2026-10-06T12:34:56.000Z" } },
          }));
        }
      };
      const terminalEventsStart = events.length;
      publishTerminalTurn("turn-external-interrupted", "interrupted");
      for (let attempt = 0; attempt < 100 && events.length === terminalEventsStart; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      publishTerminalTurn("turn-normal-completed", "completed");
      for (let attempt = 0; attempt < 100 && events.length < terminalEventsStart + 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      publishTerminalTurn("turn-normal-failed", "failed");
      for (let attempt = 0; attempt < 100 && events.length < terminalEventsStart + 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(events.slice(terminalEventsStart)).toEqual([
        expect.objectContaining({
          kind: "turn.completed",
          data: { turnId: "turn-external-interrupted", automationStop: {
            id: "turn-external-interrupted",
            at: "2026-10-06T12:34:56.000Z",
            reason: "interrupted",
            turnId: "turn-external-interrupted",
          } },
        }),
        expect.objectContaining({ kind: "turn.completed", data: { turnId: "turn-normal-completed" } }),
        expect.objectContaining({ kind: "turn.failed", data: { turnId: "turn-normal-failed" } }),
      ]);
      expect(methods).toEqual(expect.arrayContaining([
        "initialize",
        "initialized",
        "thread/list",
        "thread/read",
        "thread/resume",
        "turn/start",
        "thread/turns/list",
        "turn/interrupt",
      ]));
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
      unsubscribe();
    } finally {
      await adapter?.dispose();
      for (const restore of restoreProcessProbes) restore();
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("persists native pinned state without starting a second app-server", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pin-"));
    const dbPath = join(codexDir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("create table threads (id text primary key, is_pinned integer not null default 0)");
    db.prepare("insert into threads (id, is_pinned) values (?, 0)").run("thread-pin");
    db.close();
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      await expect(adapter.setSessionPinned?.("thread-pin", true)).resolves.toMatchObject({ ok: true, sessionId: "thread-pin" });
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      expect(reader.prepare("select is_pinned from threads where id = ?").get("thread-pin")).toMatchObject({ is_pinned: 1 });
      reader.close();
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps sparse Codex messages found within the bounded transcript tail", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-sparse-tail-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(codexDir, "human-stops.json");
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-sparse.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "noise", text: "x".repeat(1_024) } })}\n`.repeat(5_000);
    const message = (role: "user" | "assistant", text: string) => JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-sparse", cwd: "/workspace" } }),
      filler,
      message("user", "finish the interrupted work"),
      message("assistant", "working"),
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-sparse", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const messages = await adapter.getSessionMessages?.("thread-sparse", 50);
      expect(messages?.map((item) => [item.role, item.text])).toEqual([
        ["user", "finish the interrupted work"],
        ["assistant", "working"],
      ]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("reads the original user request independently of a 200-message transcript tail", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-first-user-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-long.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const message = (role: "user" | "assistant", text: string, offset: number) => JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 3, 12, 0, offset)).toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    const later = Array.from({ length: 210 }, (_, index) => message(index % 2 ? "assistant" : "user", `later-${index}`, index + 1));
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-long", cwd: "/workspace" } }),
      message("user", "original goal that must survive tail truncation", 0),
      ...later,
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-long", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const tail = await adapter.getSessionMessages?.("thread-long", 200);
      expect(tail).toHaveLength(50);
      expect(tail?.some((item) => item.text === "original goal that must survive tail truncation")).toBe(false);
      await expect(adapter.getFirstUserMessage?.("thread-long")).resolves.toMatchObject({
        role: "user",
        text: "original goal that must survive tail truncation",
      });
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("normalizes numeric native timestamps into AgentSession ISO strings", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-numeric-timestamp-"));
    const previous = process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS;
    process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS = "1";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const [session] = await adapter.listSessions();
      expect(session.lastActivity).toBe("2026-07-19T00:00:01.000Z");
      expect(typeof session.lastActivity).toBe("string");
    } finally {
      await adapter.dispose();
      if (previous === undefined) delete process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS;
      else process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS = previous;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("enumerates every native thread page and proves the snapshot exhaustive", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pagination-"));
    const logPath = join(codexDir, "app-server.log");
    const previousCount = process.env.CODEX_APP_SERVER_THREAD_COUNT;
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_THREAD_COUNT = "325";
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(325);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(325);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({
        exhaustive: true,
        source: "codex-app-server",
      });
      const listRequests = (await readFile(logPath, "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string; params?: { cursor?: string } })
        .filter((entry) => entry.kind === "request" && entry.method === "thread/list");
      expect(listRequests.map((entry) => entry.params?.cursor)).toEqual([undefined, "200"]);
    } finally {
      await adapter.dispose();
      if (previousCount === undefined) delete process.env.CODEX_APP_SERVER_THREAD_COUNT;
      else process.env.CODEX_APP_SERVER_THREAD_COUNT = previousCount;
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("marks a multi-page snapshot incomplete when a later native page fails", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pagination-failure-"));
    const previousCount = process.env.CODEX_APP_SERVER_THREAD_COUNT;
    const previousFailure = process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR;
    process.env.CODEX_APP_SERVER_THREAD_COUNT = "325";
    process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR = "200";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.listSessions()).rejects.toThrow(/forced thread\/list failure at 200/);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({
        exhaustive: false,
        source: "codex-app-server",
      });
    } finally {
      await adapter.dispose();
      if (previousCount === undefined) delete process.env.CODEX_APP_SERVER_THREAD_COUNT;
      else process.env.CODEX_APP_SERVER_THREAD_COUNT = previousCount;
      if (previousFailure === undefined) delete process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR;
      else process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR = previousFailure;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("archives an idle Codex thread from the active list while retaining exact-ID transcript history", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-archive-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "06");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const message = (role: "user" | "assistant", text: string) => JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd: "/tmp/codex-fixture" } }),
      message("user", "preserve this exact session history"),
      message("assistant", "the completed result"),
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.listSessions()).resolves.toMatchObject([{ id: "thread-1", status: "idle" }]);
      await expect(adapter.archiveSession("thread-1")).resolves.toMatchObject({ ok: true, sessionId: "thread-1" });
      await expect(adapter.listSessions()).resolves.toEqual([]);
      await expect(adapter.getSessionMessages("thread-1", 10)).resolves.toMatchObject([
        { role: "user", text: "preserve this exact session history" },
        { role: "assistant", text: "the completed result" },
      ]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["running", false],
    ["error", false],
    ["unrecognized", false],
    ["active", true],
  ] as const)("refuses native Codex archive for status %s (permission pending: %s)", async (status, permissionPending) => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-archive-guard-"));
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    const previousStatus = process.env.CODEX_APP_SERVER_THREAD_STATUS;
    const previousPermissionWait = process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
    const logPath = join(codexDir, "app-server.log");
    process.env.CODEX_APP_SERVER_LOG = logPath;
    process.env.CODEX_APP_SERVER_THREAD_STATUS = status;
    if (permissionPending) process.env.CODEX_APP_SERVER_PERMISSION_WAIT = "1";
    else delete process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.archiveSession("thread-1")).resolves.toMatchObject({ ok: false });
      const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string });
      expect(requests.some((entry) => entry.kind === "request" && entry.method === "thread/archive")).toBe(false);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      if (previousStatus === undefined) delete process.env.CODEX_APP_SERVER_THREAD_STATUS;
      else process.env.CODEX_APP_SERVER_THREAD_STATUS = previousStatus;
      if (previousPermissionWait === undefined) delete process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
      else process.env.CODEX_APP_SERVER_PERMISSION_WAIT = previousPermissionWait;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("uses the native state database instead of scanning every archived rollout", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-state-db-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-db.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-db", cwd: "/workspace-db" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-db", thread_name: "Indexed", updated_at: new Date().toISOString() }) + "\n");
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text)");
    db.exec("create table thread_spawn_edges (child_thread_id text, parent_thread_id text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)").run("thread-db", rollout, "/workspace-db", "gpt-test", "working", Date.now(), "subagent", "worker");
    db.prepare("insert into thread_spawn_edges values (?, ?)").run("thread-db", "parent-db");
    db.close();
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      await expect(adapter.listSessions()).resolves.toMatchObject([{
        id: "thread-db", status: "idle", cwd: "/workspace-db", model: "gpt-test",
        meta: { parentThreadId: "parent-db", threadSource: "subagent", agentRole: "worker" },
      }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("discovers persisted sessions without spawning the app-server", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-lazy-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), [
      JSON.stringify({ id: "thread-lazy", thread_name: "Older", updated_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "thread-lazy", thread_name: "Existing", updated_at: new Date().toISOString() }),
    ].join("\n") + "\n");
    await writeFile(join(sessionDir, "rollout-thread-lazy.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-lazy", id: "thread-lazy", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-lazy", title: "Existing", cwd: "/workspace", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
      expect(sessions).toHaveLength(1);
      expect(adapter.isReady()).toBe(false);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({ exhaustive: true, source: "codex-state-index" });
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("reports a turn running in another app-server instance from native thread status", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-external-running-"));
    const previous = process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD;
    process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD = "thread-1";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const session = (await adapter.listSessions()).find((item) => item.id === "thread-1");
      expect(session?.status).toBe("running");
    } finally {
      await adapter.dispose();
      if (previous === undefined) delete process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD;
      else process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD = previous;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["task_started", "idle"],
    ["task_complete", "idle"],
    ["turn_aborted", "idle"],
  ] as const)("overlays persisted Desktop lifecycle %s onto an idle app-server thread", async (marker, expected) => {
    const codexDir = await mkdtemp(join(tmpdir(), `agent-herder-codex-rollout-${marker}-`));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({
      id: "thread-1", thread_name: "Desktop task", updated_at: new Date().toISOString(),
    }) + "\n");
    await writeFile(join(sessionDir, "rollout-thread-1.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: marker } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const session = (await adapter.listSessions()).find((item) => item.id === "thread-1");
      expect(session?.status).toBe(expected);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("replays an interrupted native stop across adapter restart without claiming prompt origin", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-stop-replay-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "06");
    const rollout = join(sessionDir, "rollout-thread-stopped.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({
      id: "thread-stopped", thread_name: "Stopped task", updated_at: "2026-10-06T12:34:57.000Z",
    }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-stopped", session_id: "thread-stopped", cwd: "/workspace" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-06T12:00:00.000Z", id: "user-prompt-1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect the fixture." }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T12:00:01.000Z", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-06T12:34:56.000Z", id: "aborted-user-item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T12:34:56.000Z", payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn-stopped-1" } }),
      "",
    ].join("\n"));

    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    const restartedAdapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      for (const current of [adapter, restartedAdapter]) {
        const session = (await current.listSessions()).find((item) => item.id === "thread-stopped");
        expect(session?.meta).toMatchObject({
          automationStop: {
            id: "turn-stopped-1",
            at: "2026-10-06T12:34:56.000Z",
            reason: "interrupted",
            turnId: "turn-stopped-1",
          },
        });
        expect(session?.meta).not.toHaveProperty("latestUserPrompt");
      }
    } finally {
      await adapter.dispose();
      await restartedAdapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not treat an old persisted task_started marker as a live Codex turn", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-stale-running-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Old task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(rollout, old, old);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not keep a recent task_started marker running after its Codex writer died", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-dead-writer-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps a recent task_started marker running while a Codex process owns the rollout", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-live-writer-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Active task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const holder = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'a');process.stdout.write('ready');setInterval(()=>{},1000)",
      rollout,
    ], { argv0: "codex-rollout-holder", stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
      });
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("running");
    } finally {
      holder.kill();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not count a Codex process with a read-only rollout descriptor as its writer", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-readonly-holder-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const holder = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'r');process.stdout.write('ready');setInterval(()=>{},1000)",
      rollout,
    ], { argv0: "codex-rollout-reader", stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
      });
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      holder.kill();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("ignores unrelated Codex candidate churn when no rollout ownership was observed", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-proc-race-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-race.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-race", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-race", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAdapter({ codexDir });
    const internals = adapter as unknown as { getCodexCandidatePids: () => Promise<string[] | null> };
    internals.getCodexCandidatePids = async () => ["999999999"];
    try {
      expect((await adapter.listSessions()).find((item) => item.id === "thread-race")?.status).toBe("idle");
    } finally {
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("fails closed when access mode is unreadable for an observed rollout descriptor", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-relevant-proc-race-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-race.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-race", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-race", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAdapter({ codexDir });
    const internals = adapter as unknown as {
      getCodexCandidatePids: () => Promise<string[] | null>;
      inspectCodexProcessRollouts: (pid: string) => Promise<Set<string> | null>;
    };
    internals.getCodexCandidatePids = async () => ["relevant-candidate"];
    internals.inspectCodexProcessRollouts = async () => null;
    try {
      expect((await adapter.listSessions()).find((item) => item.id === "thread-race")?.status).toBe("running");
    } finally {
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps a native thread, interrupts turns, resumes, and forks", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-app-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    const rawPath = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rawPath, [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-1", id: "thread-1", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
      '{"type":"response_item"}',
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      modelIds: ["gpt-test", "gpt-test-2"],
      codexDir,
    });
    const nativeEvents: Array<{ kind: string; sessionId?: string }> = [];
    const unsubscribeEvents = adapter.subscribeEvents((event) => nativeEvents.push(event));
    try {
      await adapter.init();
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("thread-1");
      expect(sessions[0].harness).toBe("codex");
      expect(sessions[0].meta).toMatchObject({ parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" });

      const created = await adapter.createSession({ name: "repair_100", cwd: "/tmp/codex-repair" });
      expect(created).toMatchObject({
        id: "thread-created-1",
        harness: "codex",
        title: "repair_100",
        cwd: "/tmp/codex-repair",
      });

      const raw = await adapter.getRawTranscript?.("thread-1");
      expect(raw).toMatchObject({ complete: true, source: { kind: "native-file", location: rawPath, format: "jsonl" } });
      expect(raw?.bytes.toString("utf8")).toContain('"session_id":"thread-1"');

      const queued = await adapter.sendMessage("thread-1", { message: "hold", queue: true });
      expect(queued).toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      for (let i = 0; i < 20 && !nativeEvents.some((event) => event.kind === "turn.started"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(nativeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "process.connected" }),
        expect.objectContaining({ kind: "turn.started", sessionId: "thread-1", data: { turnId: "turn-1" } }),
      ]));
      expect(await adapter.cancelTurn("thread-1")).toEqual({ ok: true });
      expect(await adapter.resumeSession("thread-1")).toEqual({ ok: true });
      expect(await adapter.changeModel("thread-1", "gpt-test-2")).toEqual({ ok: true });

      const forked = await adapter.forkSession("thread-1", "continue in a child");
      expect(forked.ok).toBe(true);
      expect(forked.sessionId).toBe("thread-fork-1");
      expect(await adapter.listModels()).toEqual(["gpt-test", "gpt-test-2"]);
    } finally {
      unsubscribeEvents();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("admits a cold same-thread continue only through initialize, resume, and turn/start", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-same-thread-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      codexDir,
    });
    try {
      const result = await adapter.sendMessage("thread-1", { message: "continue" });
      expect(result).toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      const log = await readFile(logPath, "utf8").catch(() => "");
      expect(log).toContain('"method":"initialize"');
      expect(log).toContain('"method":"thread/resume"');
      expect(log).toContain('"threadId":"thread-1"');
      expect(log).toContain('"method":"turn/start"');
      expect(log).not.toContain('"method":"thread/start"');
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("registers automated Codex input before start and prevents a late hook from clearing a stop", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-generated-prompt-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(codexDir, "human-stops.json");
    const store = getHumanStopStore();
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const message = "generated continuation text";
    try {
      await store.hold({ harness: "codex", id: "thread-1" }, {
        id: "explicit-stop:test", at: new Date(Date.now() - 60_000).toISOString(), reason: "interrupted", turnId: "prior-turn",
      });
      await expect(adapter.sendMessage("thread-1", { message, queue: true, origin: "automation" })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });

      const nativePrompt = {
        id: "codex-turn-1", at: new Date(Date.now() + 1_000).toISOString(), origin: "human", kind: "user_prompt",
        turnId: "turn-1", text: message,
      };
      await expect(store.isGeneratedPrompt("codex", "thread-1", nativePrompt)).resolves.toBe(true);
      await expect(store.release("codex", "thread-1", nativePrompt)).resolves.toBe(false);
      await expect(store.isHeld("codex", "thread-1")).resolves.toBe(true);

      const laterHumanPrompt = { ...nativePrompt, id: "codex-turn-2", turnId: "turn-2" };
      await expect(store.isGeneratedPrompt("codex", "thread-1", laterHumanPrompt)).resolves.toBe(false);
      await expect(store.release("codex", "thread-1", laterHumanPrompt)).resolves.toBe(true);
      await expect(store.isHeld("codex", "thread-1")).resolves.toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("delivers two sequential turns to the same native thread without creating a replacement", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-sequential-turns-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await expect(adapter.sendMessage("thread-1", { message: "first continuation" })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      await expect(adapter.sendMessage("thread-1", { message: "second continuation" })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });

      const requests = (await readFile(logPath, "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string; params?: { threadId?: string } })
        .filter((entry) => entry.kind === "request");
      expect(requests.filter((entry) => entry.method === "initialize")).toHaveLength(1);
      expect(requests.filter((entry) => entry.method === "thread/resume").map((entry) => entry.params?.threadId)).toEqual(["thread-1", "thread-1"]);
      expect(requests.filter((entry) => entry.method === "turn/start").map((entry) => entry.params?.threadId)).toEqual(["thread-1", "thread-1"]);
      expect(requests.some((entry) => entry.method === "thread/start")).toBe(false);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("drops cached running state and fails the same turn when the native writer process dies", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-writer-death-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "05");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted native turn", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const events: Array<{ kind: string; sessionId?: string }> = [];
    const unsubscribe = adapter.subscribeEvents((event) => events.push(event));
    try {
      await adapter.init();
      await expect(adapter.sendMessage("thread-1", { message: "hold", queue: true })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      for (let attempt = 0; attempt < 50 && !events.some((event) => event.kind === "turn.started"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });

      const child = (adapter as unknown as { child?: ChildProcessWithoutNullStreams }).child;
      expect(child?.pid).toEqual(expect.any(Number));
      const lateStdout = child?.stdout.listeners("data")[0] as ((chunk: string) => void) | undefined;
      expect(lateStdout).toEqual(expect.any(Function));
      child?.kill("SIGTERM");
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.kind === "process.disconnected"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({ id: "thread-1", status: "idle" });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "process.disconnected", sessionId: "thread-1", data: expect.objectContaining({ turnId: "turn-1" }) }),
        expect.objectContaining({ kind: "process.disconnected" }),
      ]));

      events.length = 0;
      await expect(adapter.sendMessage("thread-1", { message: "hold", queue: true })).resolves.toMatchObject({ ok: true, admitted: true, turnId: expect.any(String) });
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.kind === "turn.started"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });

      lateStdout?.('{"method":"turn/com');
      lateStdout?.('pleted","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}\n');
      await new Promise((resolve) => setImmediate(resolve));

      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });
      expect(events.some((event) => event.kind === "turn.completed")).toBe(false);
    } finally {
      unsubscribe();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("shares one cold app-server initialization between observer and control callers", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-single-control-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      const [initialized, observed, resumed] = await Promise.all([
        adapter.init().then(() => true),
        adapter.listSessions(),
        adapter.resumeSession("thread-1"),
      ]);
      expect(initialized).toBe(true);
      expect(observed).toEqual(expect.any(Array));
      expect(resumed).toEqual({ ok: true });

      const log = await readFile(logPath, "utf8");
      expect(log.match(/"method":"initialize"/g)).toHaveLength(1);
      expect(log.match(/"method":"thread\/resume"/g)).toHaveLength(1);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("fails closed when turn/started is for the wrong turn id", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-same-thread-mismatch-"));
    const previousStarted = process.env.CODEX_APP_SERVER_TURN_STARTED_ID;
    const previousCompleted = process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID;
    process.env.CODEX_APP_SERVER_TURN_STARTED_ID = "turn-other";
    process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID = "turn-1";
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      codexDir,
    });
    try {
      const result = await adapter.sendMessage("thread-1", { message: "continue" });
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/admission mismatch/i) });
    } finally {
      await adapter.dispose();
      if (previousStarted === undefined) delete process.env.CODEX_APP_SERVER_TURN_STARTED_ID;
      else process.env.CODEX_APP_SERVER_TURN_STARTED_ID = previousStarted;
      if (previousCompleted === undefined) delete process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID;
      else process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID = previousCompleted;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("uses session_meta.id as the child identity when session_id names the parent", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-subagent-meta-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-child", thread_name: "Child", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(join(sessionDir, "rollout-thread-child.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: { session_id: "thread-parent", id: "thread-child", parent_thread_id: "thread-parent", thread_source: "subagent", agent_nickname: "worker", cwd: "/workspace" },
    }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-child", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });
  it("finds an exact named thread without reading the persisted transcript archive", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-named-"));
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const created = await adapter.createSession({ name: "Fixture", cwd: "/tmp/codex-fixture" });
      const matches = await adapter.findNamedSessions("Fixture", "/tmp/codex-fixture");
      expect(matches).toMatchObject([{ id: created.id, title: "Fixture", cwd: "/tmp/codex-fixture" }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("finds and reuses a named zero-turn thread omitted from thread/list", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-named-empty-"));
    const cwd = join(codexDir, "workspace");
    const socketPath = join(codexDir, "app-server.sock");
    const name = "Previously created native thread";
    await mkdir(cwd, { recursive: true });
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, name text, cwd text, archived integer, archived_at text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?)").run("thread-zero-turn", name, cwd, 0, null);
    db.prepare("insert into threads values (?, ?, ?, ?, ?)").run("thread-archived", name, cwd, 1, "2026-10-05T00:00:00Z");
    db.close();

    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    const methods: string[] = [];
    let createdThreads = 0;
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id?: number; method?: string; params?: { threadId?: string } };
        if (!request.method) return;
        methods.push(request.method);
        const reply = (result: unknown) => {
          if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result }));
        };
        if (request.method === "initialize") return reply({ userAgent: "fixture" });
        if (request.method === "thread/list") return reply({ data: [], nextCursor: null });
        if (request.method === "thread/read" && request.params?.threadId === "thread-zero-turn") {
          return reply({ thread: { id: "thread-zero-turn", model: null, status: "idle" } });
        }
        if (request.method === "thread/start") {
          createdThreads += 1;
          return reply({ thread: { id: `thread-created-${createdThreads}`, name, cwd, status: "idle" } });
        }
        return reply({});
      });
    });
    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", socketPath, codexDir });
    try {
      await listening;
      await adapter.init();
      const matches = await adapter.findNamedSessions(name, cwd);
      expect(matches).toMatchObject([{ id: "thread-zero-turn", title: name, cwd }]);
      expect(matches).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "thread-archived" })]));
      const duplicate = await createNamedSession(new Map([["codex", adapter]]), { harness: "codex", name, cwd });
      expect(duplicate).toMatchObject({ ok: false, created: false });
      expect(duplicate.error).toMatch(/already exists/i);
      expect(methods.filter((method) => method === "thread/read")).toHaveLength(2);
      expect(createdThreads).toBe(0);
      expect(methods).not.toContain("thread/start");
    } finally {
      await adapter.dispose();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("creates and resumes full-access threads with native approval and sandbox settings", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-full-access-"));
    const logPath = join(codexDir, "app-server.jsonl");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    const previousPersistedThread = process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    let adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const created = await adapter.createSession({ name: "unattended task", cwd: "/tmp/codex-fixture", fullAccess: true });
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });
      await adapter.dispose();

      process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD = created.id;
      adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
      await adapter.init();
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });

      const requests = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; method?: string; params?: Record<string, unknown> })
        .filter((entry) => entry.kind === "request");
      expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(requests.find((entry) => entry.method === "thread/resume")?.params).toMatchObject({
        threadId: created.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(requests.filter((entry) => entry.method === "thread/resume").at(-1)?.params).toMatchObject({
        threadId: created.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      if (previousPersistedThread === undefined) delete process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD;
      else process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD = previousPersistedThread;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

});

// Focused integration expected1s/max5s: native image input shape is preserved in RPC.
it("sends a local image through Codex native turn/start", async () => {
 const codexDir=await mkdtemp(join(tmpdir(),"herder-codex-image-")), logPath=join(codexDir,"rpc.log");
 const previous=process.env.CODEX_APP_SERVER_LOG; process.env.CODEX_APP_SERVER_LOG=logPath;
 const adapter=new CodexAppServerAdapter({codexBin:process.execPath,args:[fixture],codexDir});
 try {
  await expect(adapter.sendMessage("thread-1",{message:"describe",images:[{id:"a".repeat(64),path:"/protected/image.png",fileName:"figure.png",mimeType:"image/png",bytes:90}]})).resolves.toMatchObject({ok:true,admitted:true});
  const requests=(await readFile(logPath,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  expect(requests.find(row=>row.kind==="request"&&row.method==="turn/start").params.input).toEqual([{type:"text",text:"describe"},{type:"localImage",path:"/protected/image.png"}]);
 }finally {await adapter.dispose();if(previous===undefined)delete process.env.CODEX_APP_SERVER_LOG;else process.env.CODEX_APP_SERVER_LOG=previous;await rm(codexDir,{recursive:true,force:true});}
});
