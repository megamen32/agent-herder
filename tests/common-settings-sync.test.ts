/**
 * The common settings travel: the document, the application, the confirmation.
 *
 * The owner changes one thing and every node that takes the common settings
 * holds the same value and confirms the revision it applied. A node that was
 * off catches up when it comes back. A node that holds its own value shows the
 * deviation with both values, and the common value wins. A node that did not
 * answer is unknown, and unknown is never agreement.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommonSettingsDocument,
  buildCommonDocument,
  catchUpCommonSettings,
  commonSettingsRevision,
  emptyCommonSettingsState,
  parseCommonSettingsDocument,
  readCommonSettingsFleet,
  type CommonSettingsHooksLever,
  type CommonSettingsNodeState,
  type CommonSettingsTarget,
  type CommonSettingsTransport,
} from "../src/common-settings/index.js";

/** The settings of a node, as a fake of the product of the node. */
function fakeTarget(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const target: CommonSettingsTarget = {
    async readEnvironment() {
      return {
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { present: true, value }])),
      };
    },
    async readSecretValue(key: string) {
      return values[key];
    },
    async applyEnvironment(changes: Record<string, string | null>) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete values[key];
        else values[key] = value;
      }
      return [];
    },
  };
  return { values, target };
}

/** The lever of the prohibitions of the hooks, as a fake of the lever. */
function fakeHooksLever(initial: { prohibitionsEnabled: boolean; disabledHooks?: string[] }) {
  const state = { prohibitionsEnabled: initial.prohibitionsEnabled, disabledHooks: [...(initial.disabledHooks ?? [])] };
  const lever: CommonSettingsHooksLever = {
    async read() {
      return { known: true, prohibitionsEnabled: state.prohibitionsEnabled, disabledHooks: [...state.disabledHooks] };
    },
    async apply(next) {
      state.prohibitionsEnabled = next.prohibitionsEnabled;
      state.disabledHooks = [...next.disabledHooks];
      return { ok: true };
    },
  };
  return { state, lever };
}

/** The state of a node that never took the common settings. */
function memberState(): CommonSettingsNodeState {
  return { ...emptyCommonSettingsState("member"), optIn: true };
}

describe("the revision of the document is the identity of its content", () => {
  it("is the same on two nodes that hold the same values", () => {
    const left = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    const right = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    expect(left.revision).toBe(right.revision);
  });

  it("moves when a common setting changes", () => {
    const before = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    const after = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "other" } });
    expect(after.revision).not.toBe(before.revision);
  });

  it("moves when the lever of the hooks moves", () => {
    const before = buildCommonDocument({ owner: "roomhacker-server-100", hooks: { prohibitionsEnabled: true, disabledHooks: [] } });
    const after = buildCommonDocument({ owner: "roomhacker-server-100", hooks: { prohibitionsEnabled: false, disabledHooks: [] } });
    expect(after.revision).not.toBe(before.revision);
  });

  it("does not move when the time of the assembly moves", () => {
    const before = buildCommonDocument({ owner: "roomhacker-server-100", createdAt: "2026-10-23T00:00:00.000Z" });
    const after = buildCommonDocument({ owner: "roomhacker-server-100", createdAt: "2026-10-23T01:00:00.000Z" });
    expect(after.revision).toBe(before.revision);
  });

  it("refuses a document that does not hold its own revision", () => {
    const document = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    const spoiled = { ...document, environment: { ...document.environment, NOTIFY_CENTER_PROJECT: "other" } };
    expect(() => parseCommonSettingsDocument(spoiled)).toThrow(/не соответствует своей ревизии/);
  });
});

describe("the node applies the document and confirms the revision", () => {
  it("writes the common values and names the revision it applied", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_PROJECT: "old" });
    const document = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: { NOTIFY_CENTER_PROJECT: "agent-herder", NOTIFY_CENTER_RECIPIENT: "me" },
    });
    const result = await applyCommonSettingsDocument({
      document,
      target: node.target,
      state: memberState(),
      hostId: "server-44",
    });
    expect(result.ok).toBe(true);
    expect(result.appliedRevision).toBe(document.revision);
    expect(node.values.NOTIFY_CENTER_PROJECT).toBe("agent-herder");
    expect(node.values.NOTIFY_CENTER_RECIPIENT).toBe("me");
    expect(result.changed).toContain("herder.env/NOTIFY_CENTER_PROJECT");
  });

  it("does nothing when the node already holds the wanted revision", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_PROJECT: "agent-herder" });
    const document = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    const state: CommonSettingsNodeState = { ...memberState(), appliedRevision: document.revision, document };
    const result = await applyCommonSettingsDocument({ document, target: node.target, state, hostId: "server-44" });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.conflicts.filter((conflict) => conflict.open)).toEqual([]);
  });

  it("keeps the machine settings of the node alone", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_PROJECT: "agent-herder" });
    const document = buildCommonDocument({ owner: "roomhacker-server-100", environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });
    await applyCommonSettingsDocument({ document, target: node.target, state: memberState(), hostId: "server-44" });
    expect(node.values.AGENT_HERDER_BROWSER_WORKER_PORT).toBeUndefined();
    expect(node.values.hostId).toBeUndefined();
  });
});

describe("the node that was off catches up when it comes back", () => {
  it("takes the current revision of the owner without anybody doing it by hand", async () => {
    const owner = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: { NOTIFY_CENTER_PROJECT: "agent-herder" },
      hooks: { prohibitionsEnabled: false, disabledHooks: [] },
    });
    const node = fakeTarget({ NOTIFY_CENTER_PROJECT: "old" });
    const hooks = fakeHooksLever({ prohibitionsEnabled: true });
    const transport: CommonSettingsTransport = {
      async read() { return owner; },
      async status() { return null; },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    // The node was off: it holds nothing of the document.
    const result = await catchUpCommonSettings({
      transport,
      ownerTarget: "mcp:shell:roomhacker-server-100:AgentHerder",
      target: node.target,
      hooks: hooks.lever,
      state: memberState(),
      hostId: "server-88",
    });
    expect(result.ok).toBe(true);
    expect(result.appliedRevision).toBe(owner.revision);
    expect(node.values.NOTIFY_CENTER_PROJECT).toBe("agent-herder");
    // The state «выключено» of the lever of the hooks reaches the node too.
    expect(hooks.state.prohibitionsEnabled).toBe(false);
  });

  it("claims nothing when the owner does not answer", async () => {
    const node = fakeTarget();
    const transport: CommonSettingsTransport = {
      async read() { throw new Error("direct_peer_unavailable"); },
      async status() { return null; },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    const result = await catchUpCommonSettings({
      transport,
      ownerTarget: "mcp:shell:roomhacker-server-100:AgentHerder",
      target: node.target,
      state: memberState(),
      hostId: "server-88",
    });
    expect(result.ok).toBe(false);
    expect(result.appliedRevision).toBeNull();
    expect(result.reason).toContain("не ответил");
  });
});

describe("the deviation of a node is shown with both values", () => {
  it("keeps the local value and writes the common one", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_RECIPIENT: "my-own" });
    const document = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: { NOTIFY_CENTER_RECIPIENT: "me" },
    });
    const result = await applyCommonSettingsDocument({
      document,
      target: node.target,
      state: memberState(),
      hostId: "server-44",
    });
    expect(result.ok).toBe(true);
    expect(node.values.NOTIFY_CENTER_RECIPIENT).toBe("me");
    const conflict = result.conflicts.find((item) => item.id === "herder.env/NOTIFY_CENTER_RECIPIENT");
    expect(conflict?.commonValue).toBe("me");
    expect(conflict?.localValue).toBe("my-own");
    expect(conflict?.open).toBe(true);
  });

  it("knows that a person changed the value after the last document", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_RECIPIENT: "changed-by-hand" });
    const previous = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: { NOTIFY_CENTER_RECIPIENT: "me" },
    });
    const state: CommonSettingsNodeState = { ...memberState(), appliedRevision: previous.revision, document: previous };
    const document = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: { NOTIFY_CENTER_RECIPIENT: "owner" },
    });
    const result = await applyCommonSettingsDocument({ document, target: node.target, state, hostId: "server-44" });
    const conflict = result.conflicts.find((item) => item.id === "herder.env/NOTIFY_CENTER_RECIPIENT");
    expect(conflict?.kind).toBe("local-change");
    expect(conflict?.localValue).toBe("changed-by-hand");
    expect(conflict?.commonValue).toBe("owner");
  });

  it("shows the deviation of the lever of the hooks and applies the common position", async () => {
    const node = fakeTarget();
    const hooks = fakeHooksLever({ prohibitionsEnabled: true });
    const document = buildCommonDocument({
      owner: "roomhacker-server-100",
      hooks: { prohibitionsEnabled: false, disabledHooks: [] },
    });
    const result = await applyCommonSettingsDocument({
      document,
      target: node.target,
      hooks: hooks.lever,
      state: memberState(),
      hostId: "server-44",
    });
    expect(result.ok).toBe(true);
    expect(hooks.state.prohibitionsEnabled).toBe(false);
    const conflict = result.conflicts.find((item) => item.id === "hooks-prohibitions");
    expect(conflict?.hooksChanged).toBe(true);
    expect(conflict?.localHooksState?.prohibitionsEnabled).toBe(true);
    expect(conflict?.commonHooksState?.prohibitionsEnabled).toBe(false);
  });
});

describe("the fleet names the state of every node", () => {
  const peers = [
    { hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" },
    { hostId: "server-88", target: "mcp:shell:server-88:AgentHerder" },
    { hostId: "mac-mini-2012.lan", target: "mcp:shell:mac-mini-2012.lan:AgentHerder" },
  ];
  const revision = commonSettingsRevision({ environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } });

  it("calls a node that holds the wanted revision confirmed and a node that does not answer unknown", async () => {
    const transport: CommonSettingsTransport = {
      async read() { return null; },
      async status(target: string) {
        if (target.includes("server-44")) {
          return { hostId: "server-44", role: "member", optIn: true, appliedRevision: revision, appliedAt: "2026-10-23T00:00:00.000Z", conflicts: [] };
        }
        if (target.includes("mac-mini")) {
          return { hostId: "mac-mini-2012.lan", role: "member", optIn: false, appliedRevision: null, appliedAt: null, conflicts: [] };
        }
        throw new Error("direct_peer_unavailable");
      },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    const fleet = await readCommonSettingsFleet({ transport, peers, revision });
    const confirmed = fleet.nodes.find((node) => node.hostId === "server-44");
    expect(confirmed?.status).toBe("подтвердил");
    // A node that did not answer is unknown: it is never counted as
    // synchronized.
    const silent = fleet.nodes.find((node) => node.hostId === "server-88");
    expect(silent?.status).toBe("не подтвердил");
    expect(silent?.reason).toContain("direct_peer_unavailable");
    expect(fleet.confirmed).toBe(1);
    expect(fleet.total).toBe(2);
    expect(fleet.notParticipating).toEqual(["mac-mini-2012.lan"]);
  });

  it("calls a node that holds another revision diverged and names both revisions", async () => {
    const transport: CommonSettingsTransport = {
      async read() { return null; },
      async status(target: string) {
        return { hostId: "server-44", role: "member", optIn: true, appliedRevision: "sha256:old", appliedAt: null, conflicts: [] };
      },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    const fleet = await readCommonSettingsFleet({ transport, peers: [peers[0]], revision });
    const node = fleet.nodes[0];
    expect(node.status).toBe("расходится");
    expect(node.appliedRevision).toBe("sha256:old");
    expect(node.reason).toContain("другую ревизию");
  });

  it("tells a node that holds another revision to take the document", async () => {
    let noticed = "";
    const transport: CommonSettingsTransport = {
      async read() { return null; },
      async status() {
        return { hostId: "server-44", role: "member", optIn: true, appliedRevision: "sha256:old", appliedAt: null, conflicts: [] };
      },
      async notify(target: string, wanted: string) {
        noticed = wanted;
        return { hostId: "server-44", role: "member", optIn: true, appliedRevision: wanted, appliedAt: "2026-10-23T00:05:00.000Z", conflicts: [] };
      },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    const fleet = await readCommonSettingsFleet({ transport, peers: [peers[0]], revision, distribute: true });
    expect(noticed).toBe(revision);
    expect(fleet.nodes[0].status).toBe("подтвердил");
    expect(fleet.state).toBe("Применено");
  });

  it("never counts a node that does not take the common settings", async () => {
    const transport: CommonSettingsTransport = {
      async read() { return null; },
      async status() {
        return { hostId: "server-44", role: "member", optIn: false, appliedRevision: null, appliedAt: null, conflicts: [] };
      },
      async notify() { return null; },
      async setOptIn() { return null; },
      async restore() { return null; },
    };
    const fleet = await readCommonSettingsFleet({ transport, peers: [peers[0]], revision });
    expect(fleet.total).toBe(0);
    expect(fleet.notParticipating).toEqual(["server-44"]);
  });
});
