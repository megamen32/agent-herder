/**
 * The owner asks the nodes what they hold, and a node that does not answer
 * must not cost the owner the whole round.
 *
 * The answer of the panel is fast because the owner keeps the last answer of
 * every node. The truth is not lost in the keeping: the answer names when
 * the state of every node was really read, it says that the answer is old,
 * and a node that did not answer stays a node that did not answer — it is
 * never counted as a node that holds the document.
 */

import { describe, expect, it } from "vitest";

import {
  CommonSettingsPeerCache,
  readCommonSettingsFleet,
  type CommonSettingsNodeStatus,
  type CommonSettingsTransport,
} from "../src/common-settings/index.js";
import { peerAvailabilityOf, resetPeerAvailability } from "../src/mesh/fleet-direct-transport.js";

const revision = "sha256:242d560fc9b33fc7624b2f6ea91e7de2";
const peers = [
  { hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" },
  { hostId: "mac-mini-2012.lan", target: "mcp:shell:mac-mini-2012.lan:AgentHerder" },
];

/** The state of a node that holds the wanted revision. */
function appliedStatus(hostId: string): CommonSettingsNodeStatus {
  return {
    hostId,
    role: "member",
    optIn: true,
    appliedRevision: revision,
    appliedAt: "2026-10-24T12:12:50.478Z",
    conflicts: [],
  };
}

describe("the poll of the fleet of the common settings", () => {
  it("answers fast and honestly when a node does not answer, and does not ask it again", async () => {
    const cache = new CommonSettingsPeerCache();
    let asked = 0;
    let askedDead = 0;
    const transport: CommonSettingsTransport = {
      cache,
      async read() { return null; },
      async status(target: string) {
        asked++;
        if (target.includes("mac-mini")) {
          askedDead++;
          // The node is down: it takes its own timeout to say so.
          await new Promise((resolve) => setTimeout(resolve, 300));
          throw new Error("direct_native_listener_unavailable");
        }
        return appliedStatus("server-44");
      },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };

    const started = Date.now();
    const fleet = await readCommonSettingsFleet({ transport, peers, revision, budgetMs: 50 });
    const elapsed = Date.now() - started;

    // The answer of the panel does not wait for the node that is down.
    expect(elapsed).toBeLessThan(200);
    // The node that answered is named with the truth.
    const live = fleet.nodes.find((node) => node.hostId === "server-44");
    expect(live?.fact).toBe("применена");
    expect(live?.reachable).toBe(true);
    expect(live?.appliedRevision).toBe(revision);
    // The node that did not answer is a node that did not answer: never one
    // that holds the document.
    const dead = fleet.nodes.find((node) => node.hostId === "mac-mini-2012.lan");
    expect(dead?.reachable).toBe(false);
    expect(dead?.fact).toBe("недоступна");
    expect(dead?.status).toBe("не подтвердил");
    expect(dead?.appliedRevision).toBeNull();
    expect(fleet.unreachable).toEqual(["mac-mini-2012.lan"]);
    expect(fleet.confirmed).toBe(1);
    // The node that did not answer is counted among the nodes of the fleet:
    // it is never counted as one that holds the document.
    expect(fleet.total).toBe(2);
    // The revision of the owner is not moved by the poll.
    expect(revision).toBe("sha256:242d560fc9b33fc7624b2f6ea91e7de2");

    // The round that did not arrive in time finishes in the background.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(askedDead).toBe(1);

    // The second answer of the panel is fast and does not ask the node that
    // is down again: the background does not spin.
    const askedBefore = asked;
    const secondStarted = Date.now();
    const second = await readCommonSettingsFleet({ transport, peers, revision, budgetMs: 50 });
    const secondElapsed = Date.now() - secondStarted;
    expect(secondElapsed).toBeLessThan(200);
    expect(asked).toBe(askedBefore);
    expect(askedDead).toBe(1);
    const deadAgain = second.nodes.find((node) => node.hostId === "mac-mini-2012.lan");
    expect(deadAgain?.reachable).toBe(false);
    expect(deadAgain?.fact).toBe("недоступна");
    // The reason of the failure is the reason of the node, not a guess.
    expect(deadAgain?.reason).toContain("direct_native_listener_unavailable");
    // The answer says when the state of the node was really read.
    expect(deadAgain?.checkedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(deadAgain?.checkedAt ?? ""))).toBe(false);
  });

  it("does not pass an old answer off as a fresh one", async () => {
    let clock = 1_000_000;
    const cache = new CommonSettingsPeerCache(() => clock);
    let asked = 0;
    const transport: CommonSettingsTransport = {
      cache,
      async read() { return null; },
      async status(target: string) {
        asked++;
        return appliedStatus(target.includes("mac-mini") ? "mac-mini-2012.lan" : "server-44");
      },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };

    const first = await readCommonSettingsFleet({ transport, peers, revision, budgetMs: 50, freshTtlMs: 100 });
    const firstChecked = first.nodes.find((node) => node.hostId === "server-44")?.checkedAt;
    expect(firstChecked).toBe(new Date(1_000_000).toISOString());
    expect(first.nodes.every((node) => node.stale === false)).toBe(true);

    // The window of freshness is over: the answer is served, and it says that
    // it is old and when it was really read.
    clock += 5_000;
    const second = await readCommonSettingsFleet({ transport, peers, revision, budgetMs: 50, freshTtlMs: 100 });
    const stale = second.nodes.find((node) => node.hostId === "server-44");
    expect(stale?.stale).toBe(true);
    expect(stale?.checkedAt).toBe(firstChecked);
    // The refresh happens in the background and does not hold the answer:
    // every node of the fleet is asked again, and the answer does not wait.
    expect(asked).toBe(4);
  });

  it("asks the nodes for the truth when the document has to reach them", async () => {
    const cache = new CommonSettingsPeerCache();
    let asked = 0;
    let noticed = "";
    const transport: CommonSettingsTransport = {
      cache,
      async read() { return null; },
      async status() {
        asked++;
        return { hostId: "server-44", role: "member", optIn: true, appliedRevision: "sha256:old", appliedAt: null, conflicts: [] };
      },
      async notify(_target: string, wanted: string) {
        noticed = wanted;
        return { hostId: "server-44", role: "member", optIn: true, appliedRevision: wanted, appliedAt: "2026-10-24T12:12:50.478Z", conflicts: [] };
      },
      async setOptIn() { return null; },
      async restore() { return null; },
    };

    const fleet = await readCommonSettingsFleet({ transport, peers: [peers[0]], revision, distribute: true, budgetMs: 50 });
    // The round that moves the document is a live one: the cache never hides
    // a node that has to be told.
    expect(asked).toBe(1);
    expect(noticed).toBe(revision);
    expect(fleet.nodes[0].status).toBe("подтвердил");
    expect(fleet.nodes[0].stale).toBe(false);
  });
});

describe("the availability of a node of the fleet", () => {
  it("does not ask a node that is down again and again", async () => {
    resetPeerAvailability();
    const { FleetDirectTransport } = await import("../src/mesh/fleet-direct-transport.js");
    const transport = new FleetDirectTransport(
      [{ hostId: "l61-dead-node", sshHost: "127.0.0.1", nativeUser: "roomhacker", port: 1, python: "/usr/bin/python3" }],
      2000,
    );
    const target = "mcp:shell:l61-dead-node:AgentHerder";

    const firstStarted = Date.now();
    const firstError = await transport.call(target, "common_settings_status", {}).then(
      () => null,
      (error: Error) => error,
    );
    const firstElapsed = Date.now() - firstStarted;
    expect(firstError).toBeTruthy();
    expect(firstError?.message).toMatch(/^[a-z_]+$/);

    // The node is remembered as one that does not answer.
    const known = peerAvailabilityOf("l61-dead-node");
    expect(known).toBeTruthy();
    expect(known?.error).toBe(firstError?.message);
    expect(known?.until).toBeGreaterThan(Date.now());

    // The next read of the same node costs nothing: it fails at once, in the
    // same words, and no connection is opened.
    const secondStarted = Date.now();
    const secondError = await transport.call(target, "common_settings_status", {}).then(
      () => null,
      (error: Error) => error,
    );
    const secondElapsed = Date.now() - secondStarted;
    expect(secondError?.message).toBe(firstError?.message);
    expect(secondElapsed).toBeLessThan(50);
    expect(secondElapsed).toBeLessThan(firstElapsed);
    resetPeerAvailability();
  });
});
