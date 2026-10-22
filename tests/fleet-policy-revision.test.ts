import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABSENT_LAUNCH_POLICY_ETAG } from "../src/automation-launch-policy.js";
import {
  fleetPolicyRevisionLedgerPath,
  readFleetPolicyRevisions,
  type FleetPolicyRevisionTransport,
} from "../src/mesh/fleet-policy-revision.js";
import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { unwrapResult } from "../src/mesh/protocol.js";

const DESIRED = '"sha256:0123456789abcdef"';
const OTHER = '"sha256:fedcba9876543210"';

function transportWith(answers: Record<string, unknown | Error>): FleetPolicyRevisionTransport {
  return {
    async call(target: string): Promise<unknown> {
      const answer = answers[target];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error("node_unreachable");
      return answer;
    },
  };
}

function nodeAnswer(appliedRevision: string, kind: "valid" | "absent" | "invalid" = "valid"): unknown {
  return { structuredContent: { hostId: "peer", launchPolicy: { kind, appliedRevision } } };
}

describe("the applied revision of the policy of the launch in the fleet", () => {
  it("calls a node that applied the wanted version synchronized", async () => {
    const summary = await readFleetPolicyRevisions({
      transport: transportWith({ "mcp:shell:peer:AgentHerder": nodeAnswer(DESIRED) }),
      peers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
      desiredRevision: DESIRED,
    });
    expect(summary.synchronized).toBe(true);
    expect(summary.diverged).toEqual([]);
    expect(summary.unconfirmed).toEqual([]);
    expect(summary.nodes[0]?.status).toBe("synchronized");
    expect(summary.nodes[0]?.appliedRevision).toBe(DESIRED);
  });

  it("shows a node that holds another version and does not call it synchronized", async () => {
    const summary = await readFleetPolicyRevisions({
      transport: transportWith({ "mcp:shell:peer:AgentHerder": nodeAnswer(OTHER) }),
      peers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
      desiredRevision: DESIRED,
    });
    expect(summary.synchronized).toBe(false);
    expect(summary.diverged).toEqual(["peer"]);
    const node = summary.nodes[0];
    expect(node?.status).toBe("diverged");
    // Both versions are named, so the divergence is visible without reading
    // the file of that node.
    expect(node?.appliedRevision).toBe(OTHER);
    expect(node?.desiredRevision).toBe(DESIRED);
    expect(node?.reason).toContain(OTHER);
    expect(node?.reason).toContain(DESIRED);
  });

  it("does not call a node without a document applied", async () => {
    const summary = await readFleetPolicyRevisions({
      transport: transportWith({ "mcp:shell:peer:AgentHerder": nodeAnswer(ABSENT_LAUNCH_POLICY_ETAG, "absent") }),
      peers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
      desiredRevision: DESIRED,
    });
    expect(summary.synchronized).toBe(false);
    const node = summary.nodes[0];
    expect(node?.status).not.toBe("synchronized");
    expect(node?.appliedRevision).toBe(ABSENT_LAUNCH_POLICY_ETAG);
    expect(node?.reason).toContain("нет документа");
  });

  it("keeps a node that did not answer unconfirmed, with its last known confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herder-policy-revisions-"));
    try {
      const ledgerPath = fleetPolicyRevisionLedgerPath(dir);
      writeFileSync(
        ledgerPath,
        JSON.stringify({ peer: { appliedRevision: OTHER, at: "2026-10-22T10:00:00.000Z" } }),
        "utf8",
      );
      const summary = await readFleetPolicyRevisions({
        transport: transportWith({ "mcp:shell:peer:AgentHerder": new Error("node_unreachable") }),
        peers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
        desiredRevision: DESIRED,
        ledgerPath,
      });
      expect(summary.synchronized).toBe(false);
      expect(summary.unconfirmed).toEqual(["peer"]);
      const node = summary.nodes[0];
      expect(node?.status).toBe("unconfirmed");
      // The last confirmation is named, and it is not agreement.
      expect(node?.lastKnown?.appliedRevision).toBe(OTHER);
      expect(node?.lastKnown?.at).toBe("2026-10-22T10:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the last confirmation of a node that answered, so the next failure names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herder-policy-revisions-"));
    try {
      const ledgerPath = fleetPolicyRevisionLedgerPath(dir);
      const transport = transportWith({ "mcp:shell:peer:AgentHerder": nodeAnswer(OTHER) });
      await readFleetPolicyRevisions({
        transport,
        peers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
        desiredRevision: DESIRED,
        ledgerPath,
      });
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, { appliedRevision: string }>;
      expect(ledger.peer?.appliedRevision).toBe(OTHER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the local node among the nodes of the fleet", async () => {
    const summary = await readFleetPolicyRevisions({
      transport: transportWith({}),
      peers: [],
      desiredRevision: DESIRED,
      local: { hostId: "local", answer: { kind: "valid", appliedRevision: DESIRED } },
    });
    expect(summary.synchronized).toBe(true);
    expect(summary.nodes).toEqual([
      { hostId: "local", status: "synchronized", appliedRevision: DESIRED, desiredRevision: DESIRED },
    ]);
  });
});

describe("the node says which version of the policy it holds", () => {
  it("reports the version of the document it holds, and reads it again on every answer", async () => {
    const versions = [{ kind: "valid" as const, appliedRevision: DESIRED }, { kind: "valid" as const, appliedRevision: OTHER }];
    let call = 0;
    const server = new McpServer({ name: "local-herder", version: "1" });
    registerFleetNodeTools(server, {
      adapters: new Map(),
      launchPolicyRevision: async () => versions[Math.min(call++, versions.length - 1)]!,
    });
    const client = new Client({ name: "policy-consumer", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const first = unwrapResult(await client.callTool({ name: "fleet_node_info", arguments: {} }));
      expect((first as any).launchPolicy.appliedRevision).toBe(DESIRED);
      // No copy is kept: the second answer reads the document again.
      const second = unwrapResult(await client.callTool({ name: "fleet_node_info", arguments: {} }));
      expect((second as any).launchPolicy.appliedRevision).toBe(OTHER);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads the applied revision of every node through the tool of the owner", async () => {
    const server = new McpServer({ name: "local-herder", version: "1" });
    registerFleetNodeTools(server, {
      adapters: new Map(),
      launchPolicyRevision: async () => ({ kind: "valid", appliedRevision: DESIRED }),
      fleetTransport: transportWith({ "mcp:shell:peer:AgentHerder": nodeAnswer(OTHER) }),
      fleetPeers: [{ hostId: "peer", target: "mcp:shell:peer:AgentHerder" }],
    });
    const client = new Client({ name: "policy-consumer", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const answer = unwrapResult(await client.callTool({ name: "fleet_policy_revisions", arguments: {} }));
      expect((answer as any).desiredRevision).toBe(DESIRED);
      expect((answer as any).synchronized).toBe(false);
      expect((answer as any).diverged).toEqual(["peer"]);
      expect((answer as any).nodes.find((node: any) => node.hostId === "peer").appliedRevision).toBe(OTHER);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
