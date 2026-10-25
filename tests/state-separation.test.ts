import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import {
  SEPARATION_KEYS,
  separateStates,
  separationDimension,
  type SeparationKey,
  type SeparationReading,
  type SeparatedStateView,
} from "../src/hooks/state-separation.js";
import {
  hooksReading,
  prohibitionsReading,
  quotaPolicyReading,
  readSeparatedStateView,
  sessionStopReading,
  sessionStopUnknown,
  type SeparationSources,
} from "../src/hooks/state-separation-read.js";
import { defaultHooksProhibitions, parseHooksProhibitions } from "../src/hooks/state.js";

function reading(overrides: Partial<SeparationReading> = {}): SeparationReading {
  return { known: true, active: false, source: "test://source", reason: "test", ...overrides };
}

function allReadings(): Record<SeparationKey, SeparationReading> {
  return {
    session_stop: reading({ source: "test://session_stop" }),
    prohibitions: reading({ source: "test://prohibitions" }),
    hooks: reading({ source: "test://hooks" }),
    quota_policy: reading({ source: "test://quota_policy" }),
    network_pause: reading({ source: "test://network_pause" }),
  };
}

function stateOf(view: SeparatedStateView, key: SeparationKey): string {
  return separationDimension(view, key)?.state ?? "missing";
}

describe("the five states of the product, separated", () => {
  it("answers with five states, each one with its own key and its own source", () => {
    const view = separateStates(allReadings());
    expect(view.keys).toEqual([...SEPARATION_KEYS]);
    expect(view.keys.length).toBe(5);
    expect(view.dimensions.length).toBe(5);
    expect(new Set(view.dimensions.map((dimension) => dimension.source)).size).toBe(5);
    // Three owners: the owner of the session, the owner of the panel, the operator of the node.
    expect(new Set(view.dimensions.map((dimension) => dimension.owner)).size).toBe(3);
    expect(view.activeCount).toBe(0);
    expect(view.unknown.length).toBe(0);
  });

  it("counts the states that are in effect: 0, 1, 3 and 5 read differently", () => {
    const none = separateStates(allReadings());
    expect(none.activeCount).toBe(0);

    const one = separateStates({ ...allReadings(), prohibitions: reading({ active: true }) });
    expect(one.activeCount).toBe(1);
    expect(stateOf(one, "prohibitions")).toBe("active");
    expect(stateOf(one, "hooks")).toBe("inactive");

    const three = separateStates({
      ...allReadings(),
      session_stop: reading({ active: true }),
      quota_policy: reading({ active: true }),
      network_pause: reading({ active: true }),
    });
    expect(three.activeCount).toBe(3);
    expect(stateOf(three, "session_stop")).toBe("active");
    expect(stateOf(three, "quota_policy")).toBe("active");
    expect(stateOf(three, "network_pause")).toBe("active");
    expect(stateOf(three, "prohibitions")).toBe("inactive");
    expect(stateOf(three, "hooks")).toBe("inactive");

    const five = separateStates({
      session_stop: reading({ active: true }),
      prohibitions: reading({ active: true }),
      hooks: reading({ active: true }),
      quota_policy: reading({ active: true }),
      network_pause: reading({ active: true }),
    });
    expect(five.activeCount).toBe(5);
    expect(five.dimensions.every((dimension) => dimension.state === "active")).toBe(true);
  });

  it("never reads the stop of a session off the prohibitions of the hooks", () => {
    // The stop of a session is held while the prohibitions are off: the two
    // states say opposite things and both of them stay true.
    const held = separateStates({
      ...allReadings(),
      session_stop: reading({ active: true }),
      prohibitions: reading({ active: false }),
    });
    expect(stateOf(held, "session_stop")).toBe("active");
    expect(stateOf(held, "prohibitions")).toBe("inactive");
    expect(held.activeCount).toBe(1);

    // And the other way round: the prohibitions are on while the session is
    // not held at all.
    const notHeld = separateStates({
      ...allReadings(),
      session_stop: reading({ active: false }),
      prohibitions: reading({ active: true }),
    });
    expect(stateOf(notHeld, "session_stop")).toBe("inactive");
    expect(stateOf(notHeld, "prohibitions")).toBe("active");
    expect(notHeld.activeCount).toBe(1);
  });

  it("never reads the runtime of the hooks off the prohibitions", () => {
    // The live shape of the product: the prohibitions are on, the runtime of
    // the hooks is off. One document, two different answers.
    const document = parseHooksProhibitions({
      version: 1,
      hooksEnabled: false,
      prohibitionsEnabled: true,
      disabledHooks: ["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"],
    });
    const prohibitions = prohibitionsReading({ enabled: document.prohibitionsEnabled, known: true });
    const hooks = hooksReading({ state: document, known: true });
    expect(prohibitions.active).toBe(true);
    expect(hooks.active).toBe(false);
    expect(hooks.facts.runningHooks).toEqual([]);
    expect(hooks.facts.disabledHooks.length).toBe(5);
  });

  it("moves one state without moving the other four", () => {
    for (const key of SEPARATION_KEYS) {
      const before = separateStates(allReadings());
      const after = separateStates({ ...allReadings(), [key]: reading({ active: true, source: "test://moved" }) });
      const changed = after.dimensions.filter(
        (dimension, index) => JSON.stringify(dimension) !== JSON.stringify(before.dimensions[index]),
      );
      expect(changed.length).toBe(1);
      expect(changed[0]?.key).toBe(key);
      expect(after.activeCount - before.activeCount).toBe(1);
    }
  });

  it("never shows an unread state as a working one", () => {
    const view = separateStates({
      ...allReadings(),
      network_pause: { known: false, active: true, source: "test://broken", reason: "юнит недоступен" },
    });
    const dimension = separationDimension(view, "network_pause");
    expect(dimension?.state).toBe("unknown");
    expect(dimension?.active).toBe(false);
    expect(view.activeCount).toBe(0);
    expect(view.unknown).toEqual(["network_pause"]);
  });

  it("keeps a broken source inside its own state", async () => {
    const sources: SeparationSources = {
      readSessionStop: async () => { throw new Error("store unavailable"); },
      readProhibitions: async () => reading({ active: true }),
      readHooks: async () => reading({ active: true }),
      readQuotaPolicy: async () => reading({ active: true }),
      readNetworkPause: async () => reading({ active: true }),
    };
    const view = await readSeparatedStateView(sources);
    expect(view.unknown).toEqual(["session_stop"]);
    expect(view.activeCount).toBe(4);
    expect(stateOf(view, "prohibitions")).toBe("active");
    expect(stateOf(view, "session_stop")).toBe("unknown");
  });

  it("names the stop of a session by its own store and reads the quota policy by its own file", () => {
    const stopped = sessionStopReading({ harness: "codex", sessionId: "s-1", held: true });
    expect(stopped.active).toBe(true);
    expect(stopped.source).toContain("human-stops.json");
    expect(stopped.facts.harness).toBe("codex");
    expect(stopped.facts.sessionId).toBe("s-1");

    const unknown = sessionStopUnknown({ reason: "нужны harness и sessionId" });
    expect(unknown.known).toBe(false);
    expect(unknown.active).toBe(false);

    const quota = quotaPolicyReading({
      policy: { enabled: true, minRemainingPercent: 20, onUnknown: "block" },
      known: true,
      revision: "abc",
    });
    expect(quota.active).toBe(true);
    expect(quota.source).toContain("codex-quota-guard.json");
    expect(quota.facts.minRemainingPercent).toBe(20);
    expect(quota.facts.onUnknown).toBe("block");
  });

  it("keeps the default document of the hooks: the prohibitions are on, the runtime is off", () => {
    const document = defaultHooksProhibitions();
    expect(document.prohibitionsEnabled).toBe(true);
    expect(document.hooksEnabled).toBe(false);
    const view = separateStates({
      session_stop: reading({ active: false }),
      prohibitions: prohibitionsReading({ enabled: document.prohibitionsEnabled, known: true }),
      hooks: hooksReading({ state: document, known: true }),
      quota_policy: reading({ active: false }),
      network_pause: reading({ active: false }),
    });
    expect(stateOf(view, "prohibitions")).toBe("active");
    expect(stateOf(view, "hooks")).toBe("inactive");
    expect(view.activeCount).toBe(1);
  });
});

const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-state-separation-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(root, "human-stops.json"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startServer(): Promise<string> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("the route of the separated states", () => {
  it("answers with five states, and the two of the hooks differ", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/state-separation`);
    expect(response.status).toBe(200);
    const view = await response.json() as SeparatedStateView;
    expect(view.ok).toBe(true);
    expect(view.keys).toEqual([...SEPARATION_KEYS]);
    expect(view.dimensions.length).toBe(5);
    // The default document of the hooks: the prohibitions are on, the runtime
    // of the hooks is off. Two different answers out of one document.
    expect(stateOf(view, "prohibitions")).toBe("active");
    expect(stateOf(view, "hooks")).toBe("inactive");
    expect(stateOf(view, "session_stop")).toBe("unknown");
    expect(stateOf(view, "quota_policy")).toBe("active");
    const pause = separationDimension(view, "network_pause");
    expect(["active", "inactive", "unknown"]).toContain(pause?.state);
    expect(pause?.source).toContain("systemctl is-active");
  });

  it("names the session of the stop, and reads it from its own store", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/state-separation?harness=codex&sessionId=s-42`);
    expect(response.status).toBe(200);
    const view = await response.json() as SeparatedStateView;
    const stop = separationDimension(view, "session_stop");
    expect(stop?.state).toBe("inactive");
    expect(stop?.known).toBe(true);
    expect(stop?.facts.harness).toBe("codex");
    expect(stop?.facts.sessionId).toBe("s-42");
    expect(stop?.source).toContain("human-stops.json");
  });
});

describe("the stop of a session is a lever of its own", () => {
  it("holds the session and shows the truth, while the other four read their own way", async () => {
    const base = await startServer();
    // The stop is written into an isolated store of the test, never into the
    // live one of the node.
    await getHumanStopStore().hold(
      { harness: "codex", id: "s-held" },
      { id: "explicit-stop:l48", at: new Date().toISOString(), reason: "explicit-stop" },
    );
    const held = await (await fetch(`${base}/api/state-separation?harness=codex&sessionId=s-held`)).json() as SeparatedStateView;
    const stop = separationDimension(held, "session_stop");
    expect(stop?.state).toBe("active");
    expect(stop?.active).toBe(true);
    expect(stop?.facts.held).toBe(true);
    // The other four read their own way: the stop of one session moved nothing else.
    expect(stateOf(held, "prohibitions")).toBe("active");
    expect(stateOf(held, "hooks")).toBe("inactive");
    expect(stateOf(held, "quota_policy")).toBe("active");
    expect(held.activeCount).toBe(4);

    // Another session of the same harness is not held, and the other four
    // states read exactly the same.
    const other = await (await fetch(`${base}/api/state-separation?harness=codex&sessionId=s-other`)).json() as SeparatedStateView;
    expect(stateOf(other, "session_stop")).toBe("inactive");
    expect(stateOf(other, "prohibitions")).toBe("active");
    expect(stateOf(other, "hooks")).toBe("inactive");
    expect(other.activeCount).toBe(3);
  });
});
