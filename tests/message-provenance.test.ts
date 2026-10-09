import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

const cleanup: Array<() => Promise<void>> = [];
let tempRoot: string | undefined;
let previousHumanStopStore: string | undefined;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
  previousHumanStopStore = undefined;
});

function session(id: string, harness: "codex" | "zcode"): AgentSession {
  return {
    id, harness, status: "idle", title: `${harness} ${id}`, cwd: "/tmp/message-provenance-test",
    lastActivity: new Date().toISOString(), needsPermission: false,
  };
}

describe("send_message sender provenance", () => {
  it("uses a verified native sender for the reply link and marks unresolved declarations unknown", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agent-herder-message-provenance-"));
    previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(tempRoot, "human-stops.json");
    const target = session("target:thread/7", "zcode");
    const sender = session("parent:thread/42", "codex");
    const received: Array<{ id: string; options: SendMessageOptions }> = [];
    const adapter = (current: AgentSession): HarnessAdapter => ({
      type: current.harness, name: `${current.harness} provenance fixture`, async init() {},
      async listSessions() { return [current]; },
      async getSession(id) { return id === current.id ? current : null; },
      async sendMessage(id, options) { received.push({ id, options }); return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    });
    const events = new HerderEventBus();
    const server = new McpServer({ name: "message-provenance-test", version: "1" });
    registerSessionTools(server, {
      adapters: new Map([["codex", adapter(sender)], ["zcode", adapter(target)]]),
      jobs: new HerderJobRegistry(events), events,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "message-provenance-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const registered = (await client.listTools()).tools.find((tool) => tool.name === "send_message");
    expect(registered?.description).toContain("do not authenticate the caller");
    await client.callTool({ name: "send_message", arguments: {
      harness: "zcode", sessionId: target.id, message: "Please inspect this.", mode: "queue",
      fromSessionId: sender.id,
    } });

    const expectedUrl = `https://agent.bezrabotnyi.com/#/session/${encodeURIComponent(`codex:${sender.id}`)}`;
    expect(received[0]?.id).toBe(target.id);
    expect(received[0]?.options.message).toContain(`Codex ${sender.id}`);
    expect(received[0]?.options.message).toContain(expectedUrl);
    expect(received[0]?.options.message).toContain("без ACK");
    expect(received[0]?.options.message).toContain("Please inspect this.");
    expect(received[0]?.options.message!.length).toBeLessThan(550);

    await client.callTool({ name: "send_message", arguments: {
      harness: "zcode", sessionId: target.id, message: "Continue without a known sender.", mode: "queue",
      fromSessionId: "missing-parent",
    } });
    expect(received[1]?.options.message).toContain("Отправитель неизвестен: сессия не проверена.");
    expect(received[1]?.options.message).not.toContain("#/session/");
    expect(received[1]?.options.message).not.toContain('"harness":"zcode"');
    expect(received[1]?.options.message).not.toContain("Reply here");
    expect(received[1]?.options.message).toContain("Continue without a known sender.");
  });

  it("stops sender lookup after its deadline even when the current adapter resolves later", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agent-herder-message-provenance-timeout-"));
    previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(tempRoot, "human-stops.json");
    const target = session("target-timeout", "zcode");
    let delivered = "";
    let laterSenderLookupCalls = 0;
    const targetAdapter: HarnessAdapter = {
      type: "zcode", name: "ZCode target", async init() {},
      async listSessions() { return [target]; },
      async getSession(id) {
        if (id === "slow-sender") laterSenderLookupCalls += 1;
        return id === target.id ? target : null;
      },
      async sendMessage(_id, options) { delivered = options.message; return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    let finishSenderLookup!: (value: AgentSession | null) => void;
    const delayedSenderLookup = new Promise<AgentSession | null>((resolve) => { finishSenderLookup = resolve; });
    let senderLookupCalls = 0;
    const delayedSenderAdapter: HarnessAdapter = {
      type: "codex", name: "Unavailable Codex lookup", async init() {},
      async listSessions() { return []; },
      async getSession() { senderLookupCalls += 1; return delayedSenderLookup; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "message-provenance-timeout-test", version: "1" });
    registerSessionTools(server, {
      adapters: new Map([["codex", delayedSenderAdapter], ["zcode", targetAdapter]]),
      jobs: new HerderJobRegistry(events), events,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "message-provenance-timeout-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    const startedAt = Date.now();
    const result = await client.callTool({ name: "send_message", arguments: {
      harness: "zcode", sessionId: target.id, message: "deliver despite sender lookup timeout", mode: "queue",
      fromSessionId: "slow-sender",
    } });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.isError).not.toBe(true);
    expect(delivered).toContain("Отправитель неизвестен: сессия не проверена.");
    expect(delivered).not.toContain("#/session/");
    expect(delivered).toContain("deliver despite sender lookup timeout");
    expect(senderLookupCalls).toBe(1);
    finishSenderLookup(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(laterSenderLookupCalls).toBe(0);
  });
});
