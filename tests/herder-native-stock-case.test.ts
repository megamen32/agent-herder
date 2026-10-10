import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { NativeCodexClient } from "../src/mesh/native-codex.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { HerderEventBus } from "../src/herder-events.js";
import { registerBackgroundTools } from "../src/mcp/background-tools.js";
import { registerControlPlaneTools } from "../src/mcp/control-plane-tools.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function nativeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "herder-stock-case-"));
  const socketPath = join(dir, "native.sock"), http = createServer(), wss = new WebSocketServer({ server: http });
  const requests: any[] = [];
  let release!: () => void, dispatched!: () => void;
  const dispatch = new Promise<void>(resolve => { dispatched = resolve; });
  wss.on("connection", socket => socket.on("message", data => {
    const r = JSON.parse(data.toString());
    if (r.method === "command/exec") {
      requests.push(r);
      release = () => socket.send(JSON.stringify({ id: r.id, result: { exitCode: 0, stdout: "callback complete; helper cleanup finished", stderr: "" } }));
      dispatched();
    } else if (r.method === "thread/read" && r.params?.fixtureHold) return;
    else if (r.id) socket.send(JSON.stringify({ id: r.id, result: {} }));
  }));
  await new Promise<void>(resolve => http.listen(socketPath, resolve));
  cleanups.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => http.close(() => resolve()))); await rm(dir, { recursive: true, force: true }); });
  vi.stubEnv("CODEX_APP_SERVER_SOCKET", socketPath);
  const planPath = join(dir, "plan.json"), plan = JSON.stringify({ mode: "sequential-native-v1", purpose: "zero-application-proof" });
  await writeFile(planPath, plan);
  const binding = { ownerSessionId: "owner", command: ["/usr/bin/python3.10", "-I", "-S", "-B", "/home/roomhacker/ServersAdministartion/templates/server100-resource-guard/native_completion_handoff.py", "--run-native", "--plan", planPath, "--plan-sha256", createHash("sha256").update(plan).digest("hex")], cwd: "/home/roomhacker/ServersAdministartion", deadlineMs: 125000, bindingFingerprint: createHash("sha256").update(plan).digest("hex") };
  const casesPath = join(dir, "cases.json"); await writeFile(casesPath, JSON.stringify({ "zero-proof": binding }));
  vi.stubEnv("AGENT_HERDER_NATIVE_STOCK_CASES_PATH", casesPath);
  const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(dir, "jobs.json") });
  return { dir, socketPath, wss, requests, dispatch, release: () => release(), binding, jobs, casesPath };
}

async function mcp(jobs: HerderJobRegistry) {
  const server = new McpServer({ name: "owned-stock-case-fixture", version: "1" });
  registerBackgroundTools(server, { jobs, browserWakeService: {} as any, sessionConverter: {} as any });
  registerControlPlaneTools(server, { jobs, events: new HerderEventBus(), coordination: {} as any });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); const client = new Client({ name: "fixture-caller", version: "1" }); await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client, server };
}

describe("named native stock operation (focused integration; expected 3s, maximum 30s)", () => {
  it("keeps only command/exec beyond the unchanged metadata deadline", async () => {
    const f = await nativeFixture(), client = new NativeCodexClient(f.socketPath);
    cleanups.push(async () => client.close()); await client.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = (client.request as any)("command/exec", { command: f.binding.command }, { timeoutMs: 125000 }).then((r: any) => { settled = true; return r; }, (error: Error) => { settled = true; return error; });
    await f.dispatch; await vi.advanceTimersByTimeAsync(10001);
    expect(settled).toBe(false); expect(f.wss.clients.size).toBe(1);
    f.release(); expect(await result).toMatchObject({ exitCode: 0 });
  });

  it("persists once before native dispatch and survives returned admission/MCP reconnect", async () => {
    const f = await nativeFixture(), first = await mcp(f.jobs);
    const r = await first.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    expect(r.isError).not.toBe(true);
    const job = (r.structuredContent as any)?.job; expect(job?.id).toMatch(/^job_/);
    await f.dispatch;
    const disk = JSON.parse(await readFile(join(f.dir, "jobs.json"), "utf8"));
    expect(disk.jobs.find((x: any) => x.id === job.id)).toMatchObject({ ownerSessionId: "owner", durableOnce: true });
    expect(f.requests[0].params).toEqual({ command: f.binding.command, cwd: f.binding.cwd, timeoutMs: 125000, outputBytesCap: 65536 });
    await first.client.close(); await first.server.close(); await tick();
    expect(f.wss.clients.size).toBe(1); expect(f.jobs.get(job.id)?.state).toBe("running");
    f.release(); for (let i = 0; i < 100 && f.jobs.get(job.id)?.state !== "completed"; i++) await tick();
    const second = await mcp(f.jobs), result = await second.client.callTool({ name: "job_get", arguments: { jobId: job.id } });
    expect((result.structuredContent as any)?.job).toMatchObject({ state: "completed", result: { caseId: "zero-proof", native: { exitCode: 0, stdout: "callback complete; helper cleanup finished" } } });
    const again = await second.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    expect((again.structuredContent as any)?.job.id).toBe(job.id); expect(f.requests).toHaveLength(1);
  });

  it("cannot evict a durable once receipt and dispatch again after restart", async () => {
    const f = await nativeFixture();
    const registry = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "retained.json"), maxRetained: 10 });
    let calls = 0;
    const first = registry.start({ kind: "native-stock-case", idempotencyKey: "once", requestFingerprint: "pin", durableOnce: true, run: async () => ++calls } as any);
    await tick();
    for (let i = 0; i < 12; i++) { registry.start({ kind: "ordinary", run: async () => i }); await tick(); }
    const restored = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "retained.json"), maxRetained: 10 });
    const same = restored.start({ kind: "native-stock-case", idempotencyKey: "once", requestFingerprint: "pin", durableOnce: true, run: async () => ++calls } as any);
    expect(same.id).toBe(first.id); expect(same.state).toBe("completed"); await tick(); expect(calls).toBe(1);
  });

  it("keeps the normal 10s metadata deadline and rejects a non-command override", async () => {
    const f = await nativeFixture(), client = new NativeCodexClient(f.socketPath); cleanups.push(async () => client.close()); await client.connect();
    await expect(client.request("thread/read", {}, { timeoutMs: 125000 })).rejects.toThrow("native_operation_deadline_invalid");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = client.request("thread/read", { fixtureHold: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10001); expect(await pending).toMatchObject({ message: "native_rpc_deadline" });
  });

  it("retains transport loss as UNKNOWN and never dispatches that named case again", async () => {
    const f = await nativeFixture(), first = await mcp(f.jobs);
    const r = await first.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    const job = (r.structuredContent as any).job; await f.dispatch;
    for (const socket of f.wss.clients) socket.close();
    for (let i = 0; i < 100 && f.jobs.get(job.id)?.state !== "failed"; i++) await tick();
    expect(f.jobs.get(job.id)).toMatchObject({ state: "failed", result: { nativeOutcome: "unknown", replay: "forbidden" } });
    const restored = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "jobs.json") });
    const second = await mcp(restored);
    const same = await second.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    expect((same.structuredContent as any).job).toMatchObject({ id: job.id, state: "failed" }); expect(f.requests).toHaveLength(1);
  });

  it("holds its native client through cooperative cancellation until actual output is available", async () => {
    const f = await nativeFixture(), api = await mcp(f.jobs);
    const r = await api.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    const job = (r.structuredContent as any).job; await f.dispatch;
    expect(f.jobs.cancel(job.id)?.state).toBe("cancelling"); await tick(); expect(f.wss.clients.size).toBe(1);
    f.release(); for (let i = 0; i < 100 && f.jobs.get(job.id)?.state !== "cancelled"; i++) await tick();
    expect(f.jobs.get(job.id)).toMatchObject({ state: "cancelled", result: { nativeOutcome: "known", native: { exitCode: 0 } } });
  });

  it("fails before dispatch when persistence, owner, fixed tuple or plan identity are invalid", async () => {
    const f = await nativeFixture();
    const noDisk = new HerderJobRegistry(new HerderEventBus());
    expect(() => noDisk.startNativeStockCase({ caseId: "zero-proof", ownerSessionId: "owner" })).toThrow("durable_registry_required");
    expect(() => f.jobs.startNativeStockCase({ caseId: "zero-proof", ownerSessionId: "foreign" })).toThrow("owner_mismatch");
    expect(() => f.jobs.startNativeStockCase({ caseId: "unregistered", ownerSessionId: "owner" })).toThrow("not_registered");
    await writeFile(f.casesPath, JSON.stringify({ "zero-proof": { ...f.binding, command: ["/bin/sh", "-c", "echo forbidden"] } }));
    expect(() => f.jobs.startNativeStockCase({ caseId: "zero-proof", ownerSessionId: "owner" })).toThrow("binding_invalid");
    await writeFile(f.casesPath, JSON.stringify({ "zero-proof": f.binding })); await writeFile(f.binding.command[7]!, "changed");
    expect(() => f.jobs.startNativeStockCase({ caseId: "zero-proof", ownerSessionId: "owner" })).toThrow("plan_drift_hold");
    expect(f.requests).toHaveLength(0); expect(f.jobs.list()).toHaveLength(0);
  });

  it("never exposes caller argv or deadline through the registered input schema", async () => {
    const f = await nativeFixture(), api = await mcp(f.jobs);
    const r = await api.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner", command: ["bad"], deadlineMs: 999999 } });
    expect(r.isError).toBe(true); expect(f.requests).toHaveLength(0); expect(f.jobs.list()).toHaveLength(0);
  });

  it("does not erase a damaged once history or replay its native command after restart", async () => {
    const f = await nativeFixture(), api = await mcp(f.jobs);
    const r = await api.client.callTool({ name: "native_stock_case_async", arguments: { caseId: "zero-proof", ownerSessionId: "owner" } });
    const job = (r.structuredContent as any).job; await f.dispatch; f.release();
    for (let i = 0; i < 100 && f.jobs.get(job.id)?.state !== "completed"; i++) await tick();
    expect(f.jobs.get(job.id)?.state).toBe("completed");
    const path = join(f.dir, "jobs.json"), saved = JSON.parse(await readFile(path, "utf8"));
    const invalidRecord = { ...saved.jobs[0], id: "corrupted-once-identity" };
    const validHexCorruption = { ...saved.jobs[0], id: saved.jobs[0].id.slice(0, -1) + (saved.jobs[0].id.endsWith("0") ? "1" : "0") };
    for (const damaged of ["damaged once history", JSON.stringify({ version: 2, jobs: [] }), JSON.stringify({ version: 1, jobs: [invalidRecord] }), JSON.stringify({ version: 1, jobs: [validHexCorruption] })]) {
      await writeFile(path, damaged);
      const restored = new HerderJobRegistry(new HerderEventBus(), { persistencePath: path });
      expect(() => restored.startNativeStockCase({ caseId: "zero-proof", ownerSessionId: "owner" })).toThrow("history_unreadable_hold");
      restored.start({ kind: "ordinary", run: async () => "no overwrite" }); await tick();
      expect(await readFile(path, "utf8")).toBe(damaged); expect(f.requests).toHaveLength(1);
    }
  });
});
