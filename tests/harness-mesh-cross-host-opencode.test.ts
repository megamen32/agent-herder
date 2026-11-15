import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery } from "../src/user-message-delivery.js";
import { registerHarnessMeshTools } from "../src/mesh/register-tools.js";
import { GptAdminMesh, type GptAdminTransport, type MeshDelivery } from "../src/mesh/gptadmin.js";
import { trustedMeshIngressForOwnerStdio } from "../src/mesh/authenticated-ingress.js";
import type { HarnessAdapter } from "../src/types/index.js";

type FakeSession = {
  id: string;
  harness: "opencode";
  hostId: string;
  status: "idle";
  title: string;
  cwd: string;
  lastActivity: string;
  needsPermission: false;
};

type NativeCall = { id: string; options: Record<string, any> };
type Owner = {
  hostId: string;
  session: FakeSession;
  server: McpServer;
  client: Client;
  delivery: UserMessageDelivery;
  jobs: HerderJobRegistry;
  calls: NativeCall[];
  ledgerPath: string;
  readMessages: () => Promise<Array<{ role: string; text: string }>>;
};

function address(hostId: string, nativeSessionId: string) {
  return { hostId, harness: "opencode", nativeSessionId } as const;
}

async function openOwner(hostId: string, nativeSessionId: string, ledgerPath: string, calls: NativeCall[]): Promise<Owner> {
  const session: FakeSession = {
    id: nativeSessionId,
    harness: "opencode",
    hostId,
    status: "idle",
    title: hostId + " fake OpenCode",
    cwd: hostId === "host-44" ? "/workspace/A/B" : "/workspace/A",
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
  const sendMessage = vi.fn(async (id: string, options: Record<string, any>) => {
    calls.push({ id, options });
    const previous = await readMessages();
    previous.push({ role: "user", text: String(options.message) }, { role: "assistant", text: "HERDER_TEST_MODEL_OK" });
    await writeFile(ledgerPath + ".transcript.json", JSON.stringify(previous), { mode: 0o600 });
    return { ok: true, admitted: true, inputId: options.inputId, turnId: "turn-" + hostId };
  });
  const readMessages = async (): Promise<Array<{ role: string; text: string }>> => {
    try { return JSON.parse(await readFile(ledgerPath + ".transcript.json", "utf8")) as Array<{ role: string; text: string }>; }
    catch { return []; }
  };
  const adapter = {
    type: "opencode",
    async getSession(id: string) { return id === session.id ? session : null; },
    async listSessions() { return [session]; },
    async getSessionMessages(id: string) { return id === session.id ? await readMessages() : null; },
    async sendMessage(id: string, options: Record<string, any>) { return sendMessage(id, options); },
    async sendActiveMessage(id: string, options: Record<string, any>) { return sendMessage(id, options); },
    isReady: () => true,
  } as unknown as HarnessAdapter;
  const events = new HerderEventBus();
  const jobsPath = ledgerPath + ".jobs.json";
  const jobs = new HerderJobRegistry(events, { persistencePath: jobsPath });
  const delivery = new UserMessageDelivery(
    new Map([["opencode", adapter]]),
    { sendMessage: async (_harness, id, options) => adapter.sendMessage(id, options) },
    jobs,
    { pollMs: 1, maxWaitMs: 2_000, maxPending: 4 },
  );
  const server = new McpServer({ name: "fake-opencode-owner-" + hostId, version: "1" });
  registerHarnessMeshTools(server, {
    hostId,
    adapters: new Map([["opencode", adapter]]),
    ledgerPath,
    userMessageDelivery: delivery,
    trustedIngress: trustedMeshIngressForOwnerStdio(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fake-opencode-client-" + hostId, version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { hostId, session, server, client, delivery, jobs, calls, ledgerPath, readMessages };
}

async function closeOwner(owner: Owner): Promise<void> {
  owner.delivery.close();
  await owner.client.close();
  await owner.server.close();
}

class InMemoryGptAdminTransport implements GptAdminTransport {
  remote?: Owner;
  dropNextDeliveryResponse = false;
  readonly targetHost: string;

  constructor(targetHost: string) { this.targetHost = targetHost; }

  async discover(): Promise<unknown> {
    return { servers: [{ server_id: "mcp:shell:" + this.targetHost + ":AgentHerder", kind: "child_mcp", status: "online" }] };
  }

  async schema(): Promise<unknown> {
    return { tools: [{ name: "fleet_node_info" }, { name: "mesh_deliver" }] };
  }

  async readSession(_target: string, harness: string, sessionId: string): Promise<unknown> {
    if (!this.remote) throw new Error("remote_owner_unavailable");
    return { hostId: this.targetHost, session: { id: sessionId, harness, cwd: this.remote.session.cwd }, messages: await this.remote.readMessages() };
  }

  async call(_target: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (tool === "fleet_node_info") return { hostId: this.targetHost };
    if (!this.remote) throw new Error("remote_owner_unavailable");
    const result = await this.remote.client.callTool({ name: tool, arguments: args });
    if (this.dropNextDeliveryResponse && tool === "mesh_deliver") {
      this.dropNextDeliveryResponse = false;
      throw new Error("simulated_timeout_after_dispatch");
    }
    const block = result.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") throw new Error("remote_result_missing_text");
    return JSON.parse(block.text);
  }
}

const request = (message = "work in nested project"): MeshDelivery => ({
  target: address("host-44", "ses-opencode-44"),
  sender: address("host-100", "ses-opencode-100"),
  inputId: "cross-host-opencode-1",
  message,
});

let root: string | undefined;
let owners: Owner[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(closeOwner));
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("fake OpenCode cross-host Agent Herder gate", () => {
  it("delivers through a real MCP owner consumer, preserves sender, replays from durable state, and reads back after restart", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-cross-host-opencode-"));
    const calls: NativeCall[] = [];
    const ledger = join(root, "host-44-mesh-ledger.json");
    const target = await openOwner("host-44", "ses-opencode-44", ledger, calls);
    owners.push(target);
    const transport = new InMemoryGptAdminTransport("host-44");
    transport.remote = target;
    const mesh = new GptAdminMesh(transport);

    const first = await mesh.deliver(request());
    expect(["queued", "admitted"]).toContain(first.state);
    expect(first.inputId).toBe("cross-host-opencode-1");
    await vi.waitFor(() => expect(target.jobs.list(10).find((job) => job.ownerSessionId === target.session.id)?.state).toBe("completed"));
    expect(calls).toHaveLength(1);
    const beforeRestart = await transport.readSession("mcp:shell:host-44:AgentHerder", "opencode", "ses-opencode-44");
    expect(beforeRestart).toMatchObject({ hostId: "host-44", messages: expect.arrayContaining([{ role: "assistant", text: "HERDER_TEST_MODEL_OK" }]) });
    expect(calls[0]?.options.durableUserDelivery.actor).toMatchObject({
      kind: "agent",
      principal: "agent-herder-owner-mcp",
      senderVerified: false,
      senderAssertion: { hostId: "host-100", harness: "opencode", nativeSessionId: "ses-opencode-100" },
    });

    const ledgerState = JSON.parse(await readFile(ledger, "utf8")) as Record<string, { pair: string; receipt: unknown }>;
    expect(Object.values(ledgerState).some((entry) => entry.pair.includes("host-100") && entry.pair.includes("ses-opencode-100"))).toBe(true);

    await closeOwner(target);
    owners = [];
    const restarted = await openOwner("host-44", "ses-opencode-44", ledger, calls);
    owners.push(restarted);
    transport.remote = restarted;
    const afterRestart = await new GptAdminMesh(transport).deliver(request());
    expect(afterRestart.inputId).toBe("cross-host-opencode-1");
    expect(["queued", "admitted"]).toContain(afterRestart.state);
    expect(calls).toHaveLength(1);
    const readback = await transport.readSession("mcp:shell:host-44:AgentHerder", "opencode", "ses-opencode-44");
    expect(readback).toMatchObject({ hostId: "host-44", messages: expect.arrayContaining([{ role: "user", text: expect.stringContaining("work in nested project") }, { role: "assistant", text: "HERDER_TEST_MODEL_OK" }]) });

    const conflict = await new GptAdminMesh(transport).deliver(request("changed payload"));
    expect(conflict).toMatchObject({ state: "not_attempted", inputId: "cross-host-opencode-1", retryable: false, reason: "input_id_conflict" });
    expect(calls).toHaveLength(1);
  });

  it("turns a lost remote response into UNKNOWN and never replays the native effect", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-cross-host-unknown-"));
    const calls: NativeCall[] = [];
    const target = await openOwner("host-44", "ses-opencode-44", join(root, "ledger.json"), calls);
    owners.push(target);
    const transport = new InMemoryGptAdminTransport("host-44");
    transport.remote = target;
    transport.dropNextDeliveryResponse = true;

    const first = await new GptAdminMesh(transport).deliver(request());
    expect(first).toMatchObject({ state: "unknown", inputId: "cross-host-opencode-1", retryable: false });
    await vi.waitFor(() => expect(target.jobs.list(10).find((job) => job.ownerSessionId === target.session.id)?.state).toBe("completed"));
    expect(calls).toHaveLength(1);

    const reconciled = await new GptAdminMesh(transport).deliver(request());
    expect(reconciled.inputId).toBe("cross-host-opencode-1");
    expect(["queued", "admitted"]).toContain(reconciled.state);
    expect(calls).toHaveLength(1);
  });
});
