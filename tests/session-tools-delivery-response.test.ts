import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((close) => close()));
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("MCP send response join", () => {
  it("requires an existing persistent job registry for the no-replay observer path", async () => {
    const events = new HerderEventBus();
    expect(new HerderJobRegistry(events).supportsDurableOnce()).toBe(false);
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-capability-"));
    expect(new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") }).supportsDurableOnce()).toBe(true);
  });

  it.each([false, true])("sends once and observes the native response (empty=%s)", async (empty) => {
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-"));
    const target: AgentSession = {
      id: "target-response", harness: "codex", hostId: "host-a", status: "running",
      title: "response fixture", cwd: "/tmp", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const messages: SessionMessageView[] = [{ id: "old-user", role: "user", text: "old prompt", parts: [{ type: "text", text: "old prompt" }] }];
    let sends = 0;
    const adapter: HarnessAdapter = {
      type: "codex", name: "response fixture", async init() {},
      async listSessions() { return [target]; },
      async getSession(id) { return id === target.id ? target : null; },
      async getSessionMessages(id) { return id === target.id ? messages.map((item) => ({ ...item })) : null; },
      async sendActiveMessage(id) {
        expect(id).toBe(target.id);
        sends++;
        const text = empty ? "" : "new visible answer";
        messages.push({ id: "new-assistant", role: "assistant", text, parts: [{ type: "text", text }] });
        if (empty) {
          target.status = "idle";
          target.meta = { nativeLastTurn: { turnId: "turn-1", status: "completed" } };
        }
        return { ok: true, admitted: true, inputId: "sync-response-1", turnId: "turn-1" };
      },
      async sendMessage(id, options) { return this.sendActiveMessage!(id, options); },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "response-join-test", version: "1" });
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    registerSessionTools(server, { adapters: new Map([["codex", adapter]]), jobs, events, routingPeers: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-join-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const call = () => client.callTool({ name: "send_message", arguments: {
      harness: "codex", sessionId: target.id, message: "Please answer.", inputId: "sync-response-1", humanRequested: true,
    } });
    const first = await call();
    const payload = JSON.parse(first.content[0]?.text ?? "{}");
    expect(sends).toBe(1);
    expect(payload.response).toMatchObject({
      status: empty ? "completed" : "partial", text: empty ? "" : "new visible answer", jobRef: expect.stringMatching(/^herder:\/\/jobs\/job_/),
      responseFetchUri: expect.stringMatching(/^herder:\/\/delivery-responses\/host-a\/codex\/target-response\/job_/),
    });
    if (empty) expect(payload.response.reason).toBe("no_visible_response");

    const second = await call();
    expect(second.content[0]?.text).toContain("Message sent to");
    expect(sends).toBe(1);
  });

  it("keeps response results bound to each concurrent target", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-concurrent-"));
    const sessions = ["target-a", "target-b"].map((id): AgentSession => ({
      id, harness: "codex", hostId: "host-a", status: "running", title: id, cwd: "/tmp",
      lastActivity: new Date().toISOString(), needsPermission: false,
    }));
    const messages = new Map(sessions.map((session) => [session.id, [{ id: `old-${session.id}`, role: "user" as const, text: "old", parts: [{ type: "text" as const, text: "old" }] }]]));
    const sends = new Map<string, number>();
    const adapter: HarnessAdapter = {
      type: "codex", name: "concurrent response fixture", async init() {},
      async listSessions() { return sessions; },
      async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
      async getSessionMessages(id) { return messages.get(id)?.map((item) => ({ ...item })) ?? null; },
      async sendMessage(id, options) {
        sends.set(id, (sends.get(id) ?? 0) + 1);
        messages.get(id)!.push({ id: `answer-${id}`, role: "assistant", text: `answer ${id}`, parts: [{ type: "text", text: `answer ${id}` }] });
        return { ok: true, admitted: true, inputId: options.inputId, turnId: `turn-${id}` };
      },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "response-concurrent-test", version: "1" });
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    registerSessionTools(server, { adapters: new Map([["codex", adapter]]), jobs, events, routingPeers: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-concurrent-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const call = (sessionId: string) => client.callTool({ name: "send_message", arguments: {
      harness: "codex", sessionId, message: `question ${sessionId}`, inputId: `input-${sessionId}`, humanRequested: true,
    } });
    const [a, b] = await Promise.all([call("target-a"), call("target-b")]);
    const payloadA = JSON.parse(a.content[0]?.text ?? "{}");
    const payloadB = JSON.parse(b.content[0]?.text ?? "{}");
    expect(payloadA.response).toMatchObject({ target: { sessionId: "target-a" }, text: "answer target-a" });
    expect(payloadB.response).toMatchObject({ target: { sessionId: "target-b" }, text: "answer target-b" });
    expect(sends).toEqual(new Map([["target-a", 1], ["target-b", 1]]));
  });

  it("reuses the canonical UMD baseline when duplicate submissions race before baseline persistence", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-baseline-race-"));
    const target: AgentSession = {
      id: "target-race", harness: "codex", hostId: "host-a", status: "running",
      title: "baseline race fixture", cwd: "/tmp", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const messages: SessionMessageView[] = [{ id: "old-user", role: "user", text: "old prompt", parts: [{ type: "text", text: "old prompt" }] }];
    let sends = 0;
    let preSendHistoryReads = 0;
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => { releaseBaseline = resolve; });
    const adapter: HarnessAdapter = {
      type: "codex", name: "baseline race fixture", async init() {},
      async listSessions() { return [target]; },
      async getSession(id) { return id === target.id ? target : null; },
      async getSessionMessages(id) {
        if (id !== target.id) return null;
        if (sends === 0) {
          preSendHistoryReads++;
          if (preSendHistoryReads === 1) await baselineGate;
          return [{ ...messages[0]! }];
        }
        return messages.map((item) => ({ ...item }));
      },
      async sendMessage(id, options) {
        expect(id).toBe(target.id);
        sends++;
        messages.push({ id: "race-answer", role: "assistant", text: "one answer", parts: [{ type: "text", text: "one answer" }] });
        return { ok: true, admitted: true, inputId: options.inputId, turnId: "turn-race" };
      },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "response-baseline-race-test", version: "1" });
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    registerSessionTools(server, { adapters: new Map([["codex", adapter]]), jobs, events, routingPeers: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-baseline-race-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const call = () => client.callTool({ name: "send_message", arguments: {
      harness: "codex", sessionId: target.id, message: "same request", inputId: "same-race-input", humanRequested: true, mode: "sync",
    } });
    const first = call();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(jobs.list()).toHaveLength(1);
    expect(preSendHistoryReads).toBe(1);
    const second = call();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseBaseline();
    const [a, b] = await Promise.all([first, second]);
    const payloadA = JSON.parse(a.content[0]?.text ?? "{}");
    const payloadB = JSON.parse(b.content[0]?.text ?? "{}");
    expect(preSendHistoryReads).toBe(1);
    expect(sends).toBe(1);
    expect(payloadA.response).toMatchObject({ jobId: payloadB.response.jobId, text: "one answer" });
    expect(payloadB.response).toMatchObject({ jobId: payloadA.response.jobId, text: "one answer" });
  });

  it("reports a durable runner failure before native write as not attempted", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-before-write-"));
    const target: AgentSession = {
      id: "target-before-write", harness: "codex", hostId: "host-a", status: "running",
      title: "pre-write failure fixture", cwd: "/tmp", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    let nativeWrites = 0;
    const adapter: HarnessAdapter = {
      type: "codex", name: "pre-write failure fixture", async init() {},
      async listSessions() { return [target]; },
      async getSession(id) { return id === target.id ? target : null; },
      async getSessionMessages(id) { return id === target.id ? [{ id: "old", role: "user", text: "old", parts: [{ type: "text", text: "old" }] }] : null; },
      async sendMessage() { nativeWrites++; return { ok: true, admitted: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "response-before-write-test", version: "1" });
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    jobs.recordDeliveryResponseBaseline = () => { throw new Error("baseline persistence failed before sender"); };
    registerSessionTools(server, { adapters: new Map([["codex", adapter]]), jobs, events, routingPeers: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-before-write-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const response = await client.callTool({ name: "send_message", arguments: {
      harness: "codex", sessionId: target.id, message: "must not send", inputId: "before-write-failure", humanRequested: true, mode: "sync",
    } });
    const payload = JSON.parse(response.content[0]?.text ?? "{}");
    const delivery = JSON.parse(payload.delivery);
    expect(nativeWrites).toBe(0);
    expect(delivery).toMatchObject({ delivery: "not_attempted", notSubmitted: true });
    expect(delivery.delivery).not.toBe("accepted");
    expect(delivery.delivery).not.toBe("durable_pending");
  });

  it("bounds a never-resolving target metadata read by the 30 second observer deadline", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-mcp-response-metadata-deadline-"));
    vi.useFakeTimers();
    const target: AgentSession = {
      id: "target-metadata-deadline", harness: "codex", hostId: "host-a", status: "running",
      title: "metadata deadline fixture", cwd: "/tmp", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    let nativeWrites = 0;
    let hangMetadata = false;
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    const adapter: HarnessAdapter = {
      type: "codex", name: "metadata deadline fixture", async init() {},
      async listSessions() { return [target]; },
      async getSession(id) {
        if (hangMetadata) return new Promise<null>(() => {});
        return id === target.id ? target : null;
      },
      async getSessionMessages(id) { return id === target.id ? [{ id: "old", role: "user", text: "old", parts: [{ type: "text", text: "old" }] }] : null; },
      async sendMessage() {
        nativeWrites++;
        hangMetadata = true;
        markSent();
        return { ok: true, admitted: true, inputId: "metadata-deadline-input", turnId: "turn-metadata" };
      },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "response-metadata-deadline-test", version: "1" });
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    registerSessionTools(server, { adapters: new Map([["codex", adapter]]), jobs, events, routingPeers: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-metadata-deadline-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const pending = client.callTool({ name: "send_message", arguments: {
      harness: "codex", sessionId: target.id, message: "one send", inputId: "metadata-deadline-input", humanRequested: true,
    } });
    await sent;
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    expect(nativeWrites).toBe(1);
    expect(payload.response).toMatchObject({
      status: "unknown", reason: "baseline_unavailable", target: { sessionId: target.id },
      jobRef: expect.stringMatching(/^herder:\/\/jobs\/job_/),
    });
  });
});
