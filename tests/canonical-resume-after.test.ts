import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalHerderError, createCanonicalAutomationClient, requireCanonicalMigrationReady, unwrapCanonicalResult } from "../src/canonical-herder.js";
import { CanonicalResumeAfterService, canonicalResumeRequest, createCanonicalResumeAfterRuntime } from "../src/resume-after-canonical.js";
import { createConfiguredResumeAfterRuntime, createResumeAfterRuntime } from "../src/resume-after-runtime.js";
import { readRetainedResumeAfter } from "../src/canonical-migration.js";
import { createProcessWaitGate } from "../src/process-wait-gate.js";
import { FleetGptAdminTransport } from "../src/mesh/fleet-gptadmin-transport.js";
import { scheduleDeliver } from "../src/mcp-tools/handlers.js";
import type { ResumeAfterRequest, ResumeAfterWait } from "../src/resume-after.js";
import { canonicalFixture, CanonicalCoreFixture } from "./helpers/canonical-herder-fixture.js";

const owner = { harness: "codex", sessionId: "parent" };
const request: ResumeAfterRequest = { owner, requestId: "build-notice", message: "Continue after the build", trigger: { kind: "delay", delayMs: 60000 } };
const fixtures: Array<Awaited<ReturnType<typeof canonicalFixture>>> = [];
async function setup(waits: ResumeAfterWait[] = [], epoch?: string, core = new CanonicalCoreFixture()) {
  const fixture = await canonicalFixture(waits, epoch); fixtures.push(fixture);
  const client = (await createCanonicalAutomationClient({ env: fixture.env, transportFactory: async () => core.transport }))!;
  return { fixture, core, client, service: new CanonicalResumeAfterService(client) };
}
function oldWait(state: ResumeAfterWait["state"], input = request): ResumeAfterWait {
  const normalized = canonicalResumeRequest(input);
  return { id: normalized.legacyId, owner, dependencies: normalized.dependencies, message: normalized.message,
    trigger: input.trigger, scheduledAt: "2026-12-31T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
    state, completed: {}, ...(state === "resumed" ? { delivery: { status: "accepted" as const } } : {}),
  };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe("canonical transport envelopes", () => {
  it("preserves typed domain result and typed non-submission errors", () => {
    const payload = { version: 1, complete: true, found: true, target: "session:parent", state: "handed_off", result: { native: "accepted" } };
    const wire = { content: [], structuredContent: { status: "completed", calls: 1,
      result: { isError: false, structuredContent: payload } } };
    expect(unwrapCanonicalResult(wire)).toEqual(payload);
    expect(unwrapCanonicalResult({ result: { domain: "ordinary data" } })).toEqual({ result: { domain: "ordinary data" } });
    try { unwrapCanonicalResult({ isError: true, structuredContent: { code: "rule_not_found", effect: "none", message: "Missing rule" } }); }
    catch (error) {
      expect(error).toBeInstanceOf(CanonicalHerderError);
      expect(error).toMatchObject({ code: "rule_not_found", effect: "none" });
      return;
    }
    throw new Error("typed error was swallowed");
  });

  it("uses the strict parser inside the actual Fleet transport before legacy unwrapping can lose fields", async () => {
    const payload = { version: 1, complete: true, found: true, state: "unknown", result: { token: "fixture-value" } };
    const requests: Array<Record<string, any>> = [];
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      const body = JSON.parse(String(options?.body)); requests.push(body);
      if (body.method === "notifications/initialized") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? {}
        : { content: [], structuredContent: { status: "completed", calls: 1, result: { structuredContent: payload, content: [] } } } }),
      { status: 200, headers: { "content-type": "application/json" } });
    });
    const transport = new FleetGptAdminTransport({ endpoint: "https://test.gptadmin.bezrabotnyi.com/mcp", headersProvider: () => ({}),
      fetch: fetcher as typeof fetch, unwrapResponse: unwrapCanonicalResult,
      nativeHerderAuthority: "mcp:shell:roomhacker-server-100:AgentHerder" });
    expect(await transport.call("mcp:shell:roomhacker-server-100:AgentHerder", "deliver", { action: "receipt", session_ref: "session:parent", request_key: "test" })).toEqual(payload);
    const execute = requests.find(row => row.method === "tools/call")!;
    expect(execute.params.name).toBe("exec");
    expect(execute.params.arguments.code).toContain("mcp:shell:roomhacker-server-100:AgentHerder");
    expect(execute.params.arguments.code).not.toContain("HerderFleet");
    expect(requests.filter(row => row.method === "tools/call")).toHaveLength(1);
    expect(execute.params.arguments.code).not.toContain("model_quotas");
  });

  it("uses only the exact native delivery protocol while legacy Fleet delivery retains recipient quota checks", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "canonical-route-quota-"));
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", directory);
    const calls: string[] = [];
    const authority = "mcp:shell:roomhacker-server-100:AgentHerder";
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      const request = JSON.parse(String(options?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 });
      let result: unknown = {};
      if (request.method === "tools/call") {
        const code = String(request.params.arguments.code); calls.push(code);
        result = { structuredContent: code.includes('"model_quotas"')
          ? { providers: [{ provider: "codex", state: "reported", details: { primary_used: 95 } }] }
          : { version: 1, complete: true, admitted: true } };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    const options = { endpoint: "https://test.gptadmin.bezrabotnyi.com/mcp", headersProvider: () => ({}), fetch: fetcher as typeof fetch };
    try {
      const native = new FleetGptAdminTransport({ ...options, unwrapResponse: unwrapCanonicalResult, nativeHerderAuthority: authority });
      const send = { action: "session", session_ref: "session:parent", request_key: "compat-resume:fixture", message: "Continue", mode: "start" };
      await expect(native.call(authority, "deliver", send)).resolves.toMatchObject({ admitted: true });
      expect(calls).toHaveLength(1); expect(calls[0]).not.toContain("model_quotas");
      await expect(native.call("mcp:shell:other:AgentHerder", "deliver", send)).rejects.toThrow("native_herder_authority_mismatch");
      await expect(native.call(authority, "deliver", { ...send, action: "receipt" })).rejects.toThrow("native_herder_call_not_allowed");
      await expect(native.call(authority, "send_message", { harness: "codex", message: "Continue" })).rejects.toThrow("native_herder_call_not_allowed");
      expect(calls).toHaveLength(1);
      const legacy = new FleetGptAdminTransport(options);
      await expect(legacy.call(authority, "deliver", { harness: "codex", message: "Continue", sessionId: "parent" })).rejects.toThrow("codex_quota_guard");
      expect(calls).toHaveLength(2); expect(calls[1]).toContain("model_quotas");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

const describeLinux = process.platform === "linux" ? describe : describe.skip;
describeLinux("canonical resume-after facade", () => {
  it("computes due only in the authority and keeps one request across lost ACK, restart and epoch rotation", async () => {
    const first = await setup();
    first.core.loseNextCreate = true;
    await expect(first.service.register(request)).rejects.toThrow("lost_ack_after_durable_admission");
    const saved = [...first.core.rows.values()][0]!;
    first.core.now += 120000;
    const second = await setup([], "migration-test-2", first.core);
    const retried = await second.service.register(request);
    expect(first.core.admissions).toBe(1);
    expect(retried.id).toBe(saved.rule_ref);
    expect(retried.scheduledAt).toBe(saved.due_at);
    const creates = first.core.calls.filter(call => call.args.action === "create");
    expect(creates[0]!.args).toEqual(creates[1]!.args);
    expect(creates[0]!.args.rule.trigger).toEqual({ kind: "delay", delay_ms: 60000 });
    expect(creates[0]!.args.request_key).not.toContain("migration");
    await expect(second.service.register({ ...request, message: "Different request" })).rejects.toThrow("request_key_conflict");
  });

  it("keeps an absolute timer stable after its due time passes", async () => {
    const { service, core } = await setup();
    const at = new Date(core.now + 10000).toISOString();
    const input = { ...request, requestId: "absolute", trigger: { kind: "at" as const, at } };
    const first = await service.register(input);
    core.now += 60000;
    expect((await new CanonicalResumeAfterService((await setup([], "second", core)).client).register(input)).scheduledAt).toBe(first.scheduledAt);
    expect(core.admissions).toBe(1);
  });

  it("maps exact native dependencies without a local adapter and preserves captured native turn IDs", async () => {
    const { service, core } = await setup();
    const wait = await service.register({ owner, requestId: "join", dependencies: [
      { harness: "zcode", sessionId: "child-a" }, { harness: "codex", sessionId: "child-b" }, { harness: "zcode", sessionId: "child-a" },
    ] });
    expect(wait.dependencies).toHaveLength(2);
    expect(Object.values(wait.dependencyTurns!)).toEqual(expect.arrayContaining(["native-turn:session:zcode:child-a", "native-turn:session:codex:child-b"]));
    expect(wait.completed).toEqual({});
    const create = core.calls.find(call => call.args.action === "create")!;
    expect(create.args.rule).toMatchObject({ kind: "session_completion", dependencies: ["session:codex:child-b", "session:zcode:child-a"] });
    expect(core.calls.every(call => call.target === "mcp:shell:roomhacker-server-100:AgentHerder")).toBe(true);
  });

  it("refuses an unregistered dependency and never guesses completion from an idle projection", async () => {
    const { service, core } = await setup();
    await expect(service.register({ owner, dependencies: [{ harness: "codex", sessionId: "missing" }] })).rejects.toThrow("native_session_not_registered");
    expect(core.admissions).toBe(0);
    core.invalidTurnProof = true;
    await expect(service.register({ owner, requestId: "missing-proof", dependencies: [{ harness: "codex", sessionId: "child-b" }] })).rejects.toThrow("canonical_wait_dependency_invalid");
    expect(core.calls.filter(call => call.args.action === "create")).toHaveLength(1);
  });

  it("keeps receipt recovery and cancellation read-scoped, with exact CAS and retained tombstone", async () => {
    const { service, core } = await setup();
    const wait = await service.register(request);
    core.phase(wait.id, "delivery_unknown");
    expect((await service.get(wait.id))?.state).toBe("delivery_unknown");
    expect(core.admissions).toBe(1);
    const cancelled = await service.cancel(wait.id, owner);
    expect(cancelled?.state).toBe("cancelled");
    const remove = core.calls.find(call => call.args.action === "delete")!;
    expect(remove.args.revision).toBe(1);
    expect((await service.register(request)).state).toBe("cancelled");
    expect(core.admissions).toBe(1);
    await expect(service.cancel(wait.id, { harness: "codex", sessionId: "other" })).rejects.toThrow("Only the waiting session");
    expect(await service.get("wait-rule:" + "a".repeat(64))).toBeNull();
  });

  it("lists native wait projections without importing existing ChildCompletion rules or accepting partial reads", async () => {
    const { service, core } = await setup();
    const wait = await service.register(request);
    core.phase(wait.id, "confirmed");
    core.rows.set("child-rule:fixture", { rule_ref: "child-rule:fixture", kind: "child_completion", request_key: "existing-child-wake" });
    expect((await service.list()).map(row => [row.id, row.state])).toEqual([[wait.id, "resumed"]]);
    core.completeList = false;
    await expect(service.list()).rejects.toThrow("canonical_wait_list_incomplete");
    expect(core.admissions).toBe(1);
  });

  it("retains UNKNOWN bytes and blocks new waits, delivery readiness and judges before any authority write", async () => {
    const old = oldWait("delivery_unknown");
    const { fixture, service, core, client } = await setup([old]);
    const filename = path.join(fixture.directory, old.id + ".json");
    const before = await fs.readFile(filename);
    const retry = await service.register(request);
    expect(retry.state).toBe("delivery_unknown");
    expect(retry.migration).toMatchObject({ retained: true, dispatchBlocked: true, epoch: client.epoch });
    await expect(service.register({ ...request, requestId: "new-wait" })).rejects.toThrow("canonical_legacy_waits_unresolved");
    await expect(requireCanonicalMigrationReady(client)).rejects.toThrow("canonical_legacy_waits_unresolved");
    await expect(service.cancel(old.id, owner)).rejects.toThrow("canonical_retained_wait_requires_reconciliation");
    const query = vi.fn(async () => ({ blocked: false, reason: "idle" }));
    expect(await createProcessWaitGate({ env: fixture.env, query }).blocks("codex", "parent")).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(core.calls).toEqual([]);
    expect(await fs.readFile(filename)).toEqual(before);
  });

  it("does not mistake legacy cancelled for non-submission proof", async () => {
    const { client } = await setup([oldWait("cancelled")]);
    await expect(requireCanonicalMigrationReady(client)).rejects.toThrow("canonical_legacy_waits_unresolved");
    const retained = await readRetainedResumeAfter(client);
    expect(retained.waits[0]!.state).toBe("cancelled");
    expect(retained.ready).toBe(false);
  });

  it("allows only settled retained records and detects inventory, permissions and live-writer drift", async () => {
    const { fixture, client } = await setup([oldWait("resumed")]);
    await expect(requireCanonicalMigrationReady(client)).resolves.toBeUndefined();
    const live = (await fs.readFile("/proc/self/stat", "utf8"));
    fixture.drain.writers[0]!.pid = process.pid;
    fixture.drain.writers[0]!.start_ticks = live.slice(live.lastIndexOf(")") + 2).split(" ")[19]!;
    await fixture.writeDrain();
    const reread = (await createCanonicalAutomationClient({ env: fixture.env, transportFactory: async () => undefined }))!;
    await expect(requireCanonicalMigrationReady(reread)).rejects.toThrow("canonical_legacy_writer_still_alive");
    await fs.chmod(fixture.directory, 0o700);
    await expect(readRetainedResumeAfter(reread)).rejects.toThrow("canonical_retained_directory_unsealed");
  });

  it("does not start the legacy clock, subscriptions or writable wait store in canonical mode", async () => {
    const { fixture } = await setup();
    for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value!);
    const tick = vi.spyOn(globalThis, "setInterval");
    const subscribe = vi.fn(() => { throw new Error("legacy subscription must not run"); });
    const adapter = { subscribeEvents: subscribe, getSession: vi.fn(), sendMessage: vi.fn() } as never;
    const supervisor = { sendMessage: vi.fn(), isAutomationHeld: vi.fn() };
    expect(() => createResumeAfterRuntime(new Map(), supervisor, async () => false)).toThrow("canonical_resume_after_requires_configured_runtime");
    const runtime = await createConfiguredResumeAfterRuntime(new Map([["codex", adapter]]), supervisor, async () => false);
    const stop = await runtime.start(); stop();
    expect(runtime.service.authority).toBe("canonical");
    expect(tick).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
    expect(await fs.readdir(fixture.directory)).toEqual([]);
  });

  it("keeps explicit canonical configuration failures closed and never retries on another authority", async () => {
    await expect(createCanonicalAutomationClient({ env: {} })).resolves.toBeUndefined();
    await expect(createCanonicalAutomationClient({ env: { AGENT_HERDER_CANONICAL_MODE: "canonical" } })).rejects.toThrow("canonical_config_required");
    const { fixture, client, core } = await setup();
    await fs.writeFile(fixture.configPath, "{}\n");
    await expect(client.resolveNative("codex", "parent")).rejects.toThrow("canonical_digest_mismatch");
    expect(core.calls).toEqual([]);
    expect(await createProcessWaitGate({ env: fixture.env, query: async () => ({ blocked: false, reason: "unused" }) }).blocks("codex", "parent")).toBe(true);
  });

  it("uses canonical scheduled delivery without local discovery and refuses HumanRequest fallback", async () => {
    const { service, core } = await setup();
    const result = JSON.parse(await scheduleDeliver(new Map(), service, {
      sessionId: "parent", harness: "codex", message: "Scheduled result", inputId: "scheduled-1", deliverIn: 60,
    }));
    expect(result).toMatchObject({ ok: true, scheduled: true, owner });
    const before = core.calls.length;
    await expect(service.register({ ...request, humanRequestId: "question", expiresAt: "2026-12-31T00:00:00Z" })).rejects.toThrow("canonical_human_request_wait_unsupported");
    await expect(service.invalidateByHumanRequest("question", "answered")).rejects.toThrow("canonical_human_request_wait_unsupported");
    await expect(scheduleDeliver(new Map(), service, { sessionId: "parent", harness: "codex", message: "Expired request", deliverIn: 60 }, Date.now() - 1)).rejects.toThrow("scheduled_register_timeout");
    expect(core.calls).toHaveLength(before);
  });

  it("keeps migration readiness separate from starting the read-only compatibility surface", async () => {
    const { service, client, core } = await setup([oldWait("waiting")]);
    const runtime = createCanonicalResumeAfterRuntime(client);
    await expect(runtime.start()).resolves.toBeTypeOf("function");
    expect((await service.get(canonicalResumeRequest(request).legacyId))?.migration?.dispatchBlocked).toBe(true);
    await expect(service.register({ ...request, requestId: "different" })).rejects.toThrow("canonical_legacy_waits_unresolved");
    expect(core.calls).toEqual([]);
  });

  it("reads all canonical wait kinds from the sealed authority instead of an unrelated local empty store", async () => {
    const { fixture } = await setup();
    let blocked = true;
    let configured = true;
    const transport = { call: vi.fn(async () => ({ version: 1, configured, complete: true, blocked,
      mapped: true, sessionRefs: ["session:codex:parent"], ruleRefs: blocked ? ["wait-rule:" + "b".repeat(64)] : [],
      observedAt: new Date().toISOString(), reason: blocked ? "timer_wait" : "complete",
    })) };
    const local = vi.fn(async () => ({ blocked: false, reason: "unrelated_empty_store" }));
    const gate = createProcessWaitGate({ env: fixture.env, query: local, transportFactory: async () => transport });
    expect(await gate.blocks("codex", "parent")).toBe(true);
    blocked = false;
    expect(await gate.blocks("codex", "parent")).toBe(false);
    configured = false;
    expect(await gate.blocks("codex", "parent")).toBe(true);
    expect(local).not.toHaveBeenCalled();
    expect(transport.call).toHaveBeenCalledTimes(3);
    expect(transport.call.mock.calls[0]).toEqual([fixture.config.authority, "automation", {
      action: "wait_status", harness: "codex", native_session_id: "parent",
    }]);
    const wrongAuthority = createProcessWaitGate({ env: fixture.env, authority: "mcp:shell:other:AgentHerder",
      transportFactory: async () => transport });
    expect(await wrongAuthority.blocks("codex", "parent")).toBe(true);
    expect(transport.call).toHaveBeenCalledTimes(3);
  });
});
