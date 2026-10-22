/**
 * The confirmation of the fleet is computed from the answer of the nodes.
 *
 * The owner reads one number and one list: how many nodes hold the wanted
 * revision and which nodes did not confirm. The names of the nodes are never
 * guessed — a node that did not answer is named as one that did not confirm.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeConfirmationState,
  readConfirmationLedger,
  readFleetConfirmation,
  toConfirmationNodes,
  type SettingsConfirmationNode,
} from "../src/web/settings-fleet-confirmation.js";
import type { FleetPolicyRevisionSummary } from "../src/mesh/fleet-policy-revision.js";

/** One node of the fleet, as the owner reads it. */
function node(
  hostId: string,
  status: SettingsConfirmationNode["status"],
  extra: Partial<SettingsConfirmationNode> = {},
): SettingsConfirmationNode {
  return {
    hostId,
    status,
    appliedRevision: null,
    confirmedAt: null,
    reason: null,
    ...extra,
  };
}

describe("the state of the application is computed from the answer of the nodes", () => {
  it("is «Применено» when every node holds the wanted revision", () => {
    const summary = computeConfirmationState([
      node("server-44", "подтвердил"),
      node("server-88", "подтвердил"),
    ], true);
    expect(summary.state).toBe("Применено");
    expect(summary.confirmed).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.unconfirmed).toEqual([]);
  });

  it("is «Применено частично» and names the nodes that did not answer", () => {
    const summary = computeConfirmationState([
      node("server-44", "подтвердил"),
      node("server-88", "не подтвердил"),
      node("mac-mini-2012.lan", "расходится"),
    ], true);
    expect(summary.state).toBe("Применено частично");
    expect(summary.confirmed).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.unconfirmed).toEqual(["server-88", "mac-mini-2012.lan"]);
  });

  it("is «Узел недоступен» when nobody answered the round of asking", () => {
    const summary = computeConfirmationState([
      node("server-44", "не подтвердил"),
      node("server-88", "не подтвердил"),
    ], true);
    expect(summary.state).toBe("Узел недоступен");
    expect(summary.confirmed).toBe(0);
    expect(summary.unconfirmed).toEqual(["server-44", "server-88"]);
  });

  it("is «Применяется» when the change waits for its confirmation", () => {
    const summary = computeConfirmationState([node("server-44", "не подтвердил")], false);
    expect(summary.state).toBe("Применяется");
  });

  it("is «Записано» when there is no node to confirm it", () => {
    const summary = computeConfirmationState([], true);
    expect(summary.state).toBe("Записано");
    expect(summary.total).toBe(0);
  });
});

describe("the nodes of the fleet are named with the revision and the time", () => {
  const summary: FleetPolicyRevisionSummary = {
    ok: true,
    desiredRevision: "rev-1",
    synchronized: false,
    diverged: ["server-88"],
    unconfirmed: ["mac-mini-2012.lan"],
    nodes: [
      { hostId: "roomhacker-server-100", status: "synchronized", appliedRevision: "rev-1", desiredRevision: "rev-1" },
      { hostId: "server-44", status: "synchronized", appliedRevision: "rev-1", desiredRevision: "rev-1" },
      { hostId: "server-88", status: "diverged", appliedRevision: "rev-0", desiredRevision: "rev-1", reason: "Нода держит другую версию политики." },
      { hostId: "mac-mini-2012.lan", status: "unconfirmed", desiredRevision: "rev-1", lastKnown: { appliedRevision: "rev-0", at: "2026-10-22T17:00:00.000Z" }, reason: "Нода не отдала свою версию политики." },
    ],
  };

  it("names the state of every node in the words of the owner", () => {
    const nodes = toConfirmationNodes(summary, {
      "roomhacker-server-100": { appliedRevision: "rev-1", at: "2026-10-22T18:00:00.000Z" },
      "server-44": { appliedRevision: "rev-1", at: "2026-10-22T18:00:01.000Z" },
    });
    expect(nodes.map((item) => [item.hostId, item.status])).toEqual([
      ["roomhacker-server-100", "подтвердил"],
      ["server-44", "подтвердил"],
      ["server-88", "расходится"],
      ["mac-mini-2012.lan", "не подтвердил"],
    ]);
  });

  it("keeps the revision the node holds and the time of the last confirmation", () => {
    const nodes = toConfirmationNodes(summary, {
      "roomhacker-server-100": { appliedRevision: "rev-1", at: "2026-10-22T18:00:00.000Z" },
      "server-44": { appliedRevision: "rev-1", at: "2026-10-22T18:00:01.000Z" },
    });
    const diverged = nodes.find((item) => item.hostId === "server-88");
    expect(diverged?.appliedRevision).toBe("rev-0");
    expect(diverged?.reason).toContain("другую версию");
    const unconfirmed = nodes.find((item) => item.hostId === "mac-mini-2012.lan");
    expect(unconfirmed?.appliedRevision).toBe("rev-0");
    expect(unconfirmed?.confirmedAt).toBe("2026-10-22T17:00:00.000Z");
    expect(unconfirmed?.reason).toContain("не отдала");
  });

  it("names the time of the confirmation of the local node", () => {
    const nodes = toConfirmationNodes(summary, {}, { localHostId: "roomhacker-server-100", checkedAt: "2026-10-22T18:05:00.000Z" });
    expect(nodes.find((item) => item.hostId === "roomhacker-server-100")?.confirmedAt).toBe("2026-10-22T18:05:00.000Z");
  });
});

describe("the reader of the confirmation asks the nodes of the fleet", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "herder-confirmation-"));
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(stateDir, { recursive: true, force: true });
  });

  it("names the node that answered, the node that did not, and the revision", async () => {
    const answer = {
      structuredContent: { launchPolicy: { kind: "valid", appliedRevision: "rev-1" } },
    };
    const confirmation = await readFleetConfirmation({
      desiredRevision: "rev-1",
      localKind: "valid",
      hostId: "roomhacker-server-100",
      stateDir,
      peers: [
        { hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" },
        { hostId: "server-88", target: "mcp:shell:server-88:AgentHerder" },
      ],
      transport: {
        async call(target: string) {
          if (target.includes("server-44")) return answer;
          throw new Error("direct_peer_unavailable");
        },
      },
      now: () => new Date("2026-10-22T18:10:00.000Z"),
    });

    expect(confirmation.ok).toBe(true);
    expect(confirmation.desiredRevision).toBe("rev-1");
    expect(confirmation.source).toBe("живой опрос флота");
    expect(confirmation.state).toBe("Применено частично");
    expect(confirmation.confirmed).toBe(2);
    expect(confirmation.total).toBe(3);
    expect(confirmation.unconfirmed).toEqual(["server-88"]);
    const silent = confirmation.nodes.find((item) => item.hostId === "server-88");
    expect(silent?.status).toBe("не подтвердил");
    expect(silent?.reason).toContain("direct_peer_unavailable");
  });

  it("keeps the last confirmation of a node in the ledger beside the policy", async () => {
    const confirmation = await readFleetConfirmation({
      desiredRevision: "rev-1",
      localKind: "valid",
      hostId: "roomhacker-server-100",
      stateDir,
      peers: [{ hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" }],
      transport: {
        async call() {
          return { structuredContent: { launchPolicy: { kind: "valid", appliedRevision: "rev-1" } } };
        },
      },
      now: () => new Date("2026-10-22T18:20:00.000Z"),
    });
    expect(confirmation.state).toBe("Применено");

    const ledgerPath = join(stateDir, "fleet-policy-revisions.json");
    const ledger = await readConfirmationLedger(ledgerPath);
    expect(ledger["server-44"]?.appliedRevision).toBe("rev-1");
    expect(typeof ledger["server-44"]?.at).toBe("string");
  });

  it("claims nothing when the node holds no policy to compare with", async () => {
    await writeFile(join(stateDir, "fleet-policy-revisions.json"), JSON.stringify({
      "server-44": { appliedRevision: "rev-0", at: "2026-10-22T17:00:00.000Z" },
    }), "utf8");
    const confirmation = await readFleetConfirmation({
      desiredRevision: null,
      hostId: "roomhacker-server-100",
      stateDir,
      transport: { async call() { throw new Error("must not be called"); } },
      peers: [],
      now: () => new Date("2026-10-22T18:30:00.000Z"),
    });
    expect(confirmation.ok).toBe(false);
    expect(confirmation.desiredRevision).toBeNull();
    expect(confirmation.state).toBe("Применяется");
    expect(confirmation.source).toBe("последнее известное подтверждение");
    expect(confirmation.error).toBeTruthy();
    expect(confirmation.nodes[0]?.status).toBe("не подтвердил");
  });

  it("reads a ledger that cannot be read as an empty ledger", async () => {
    const ledger = await readConfirmationLedger(join(stateDir, "absent.json"));
    expect(ledger).toEqual({});
  });
});
