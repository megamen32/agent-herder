import { describe, expect, it } from "vitest";

import { hostsOf, modelsOf, sessionsOf } from "../src/web-ui/settings/runtime-section.js";

/**
 * The display of the models, the hosts and the sessions of the fleet.
 *
 * The routes answer in their own shapes, and the section must read them
 * without guessing: a list that is not a list is an empty list, and the
 * reason of an empty answer is shown instead of an empty table.
 */

describe("the display of the runtime of the node", () => {
  it("reads the catalog of the models in its own shapes", () => {
    expect(modelsOf([{ id: "model-a" }, { id: "model-b" }])).toEqual(["model-a", "model-b"]);
    expect(modelsOf({ models: ["model-c"] })).toEqual(["model-c"]);
    expect(modelsOf({ items: [{ model: "model-d" }] })).toEqual(["model-d"]);
    expect(modelsOf({ nothing: true })).toEqual([]);
    expect(modelsOf(null)).toEqual([]);
  });

  it("reads the hosts of the fleet in its own shape", () => {
    expect(hostsOf({ hosts: [{ hostId: "roomhacker-server-100" }] })).toEqual(["roomhacker-server-100"]);
    expect(hostsOf({ hosts: ["node-a"] })).toEqual(["node-a"]);
    expect(hostsOf({ hosts: [{}] })).toEqual(["узел без имени"]);
    expect(hostsOf({})).toEqual([]);
  });

  it("counts the sessions of the fleet", () => {
    expect(sessionsOf({ sessions: [1, 2, 3] })).toBe(3);
    expect(sessionsOf({ total: 2179 })).toBe(2179);
    expect(sessionsOf({ sessionCount: 12 })).toBe(12);
    expect(sessionsOf({})).toBe(0);
  });
});
