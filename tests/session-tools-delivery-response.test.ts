import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
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

  it("sends once, returns only new visible assistant text and a stable read-only fetch URI", async () => {
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
        messages.push({ id: "new-assistant", role: "assistant", text: "new visible answer", parts: [{ type: "text", text: "new visible answer" }] });
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
      harness: "codex", sessionId: target.id, message: "Please answer.", inputId: "sync-response-1",
    } });
    const first = await call();
    const payload = JSON.parse(first.content[0]?.text ?? "{}");
    expect(sends).toBe(1);
    expect(payload.response).toMatchObject({
      status: "partial", text: "new visible answer", jobRef: expect.stringMatching(/^herder:\/\/jobs\/job_/),
      responseFetchUri: expect.stringMatching(/^herder:\/\/delivery-responses\/host-a\/codex\/target-response\/job_/),
    });

    const second = await call();
    expect(second.content[0]?.text).toContain("Message sent to");
    expect(sends).toBe(1);
  });
});
