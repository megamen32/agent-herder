import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { FleetCreateJournal } from "../src/mesh/fleet-create-journal.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

describe("fleet creation through the caller and owner MCPs", () => {
  it("creates once on the owner and returns its native session to the caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-fleet-ci-"));
    const owner = new McpServer({ name: "owner", version: "1" });
    const caller = new McpServer({ name: "caller", version: "1" });
    const ownerClient = new Client({ name: "fleet-transport", version: "1" });
    const consumer = new Client({ name: "consumer", version: "1" });
    let localCreates = 0;
    let ownerCreates = 0;
    const ownerAdapter = { createSession: async ({ cwd, name }: { cwd: string; name: string }) => { ownerCreates++; if (name === "ci-uncertain") throw new Error("lost after admission"); return { id: "owner-session", cwd }; } };
    const localAdapter = { createSession: async () => { localCreates++; throw new Error("wrong owner"); } };
    const journal = new FleetCreateJournal(join(dir, "journal.json"), { profileId: "test", userId: "test" });
    registerFleetNodeTools(owner, { adapters: new Map([["codex", ownerAdapter as never]]), ownerJournal: journal });
    const [ownerClientTransport, ownerServerTransport] = InMemoryTransport.createLinkedPair();
    await owner.connect(ownerServerTransport);
    await ownerClient.connect(ownerClientTransport);
    const peer = { hostId: "server-44", sshHost: "test.invalid", nativeUser: "test", port: 1, python: "/usr/bin/python3" };
    const transport = { call: async (_target: string, tool: string, args: Record<string, unknown>, id: string) => {
      if (tool === "fleet_node_info") {
        const info = await ownerClient.callTool({ name: "fleet_node_info", arguments: {} });
        return { structuredContent: { ...info.structuredContent, hostId: "server-44" } };
      }
      expect(tool).toBe("create_session");
      return ownerClient.callTool({ name: "fleet_create_session", arguments: { ...args, inputId: id } });
    } };
    const events = new HerderEventBus();
    registerSessionTools(caller, { adapters: new Map([["codex", localAdapter as never]]), jobs: new HerderJobRegistry(events), events, routingPeers: [peer], transport: transport as never });
    const [consumerTransport, callerTransport] = InMemoryTransport.createLinkedPair();
    await caller.connect(callerTransport);
    await consumer.connect(consumerTransport);
    try {
      const args = { harness: "codex", name: "ci-fleet-session", cwd: "/tmp", hostId: "server-44", model: "gpt-6-luna" };
      const first = await consumer.callTool({ name: "create_session", arguments: args });
      const second = await consumer.callTool({ name: "create_session", arguments: args });
      const conflict = await consumer.callTool({ name: "create_session", arguments: { ...args, model: "different-model" } });
      expect(first.structuredContent).toMatchObject({ ok: true, sessionId: "owner-session", hostId: "server-44" });
      expect(second.structuredContent).toMatchObject({ ok: true, sessionId: "owner-session", hostId: "server-44" });
      expect(conflict.structuredContent).toMatchObject({ ok: false, created: false, reason: "input_id_conflict" });
      expect(ownerCreates).toBe(1);
      expect(localCreates).toBe(0);
      await getHumanStopStore().hold({ harness: "codex", id: "held-session", cwd: await realpath("/tmp"), title: "ci-stopped" }, { id: "human-stop-test", at: new Date().toISOString(), reason: "explicit-stop" });
      const stopped = await consumer.callTool({ name: "create_session", arguments: { ...args, name: "ci-stopped" } });
      expect(stopped.structuredContent).toMatchObject({ ok: false, created: false, state: "not_attempted" });
      expect(ownerCreates).toBe(1);
      const uncertain = { ...args, name: "ci-uncertain" };
      const firstUnknown = await consumer.callTool({ name: "create_session", arguments: uncertain });
      const secondUnknown = await consumer.callTool({ name: "create_session", arguments: uncertain });
      expect(firstUnknown.structuredContent).toMatchObject({ ok: false, created: false, state: "unknown" });
      expect(secondUnknown.structuredContent).toMatchObject({ ok: false, created: false, state: "unknown" });
      expect(ownerCreates).toBe(2);
    } finally {
      await consumer.close(); await caller.close(); await ownerClient.close(); await owner.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
