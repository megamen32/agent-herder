/**
 * The scope of a setting: what travels to the fleet and what stays on the machine.
 *
 * The list of the scope is the one place that decides it, and the document of
 * the common settings is built from that list only. A machine setting never
 * enters the document: a path, a port, a binary and the identity of the node
 * are correct only for the machine they live on.
 */

import { describe, expect, it } from "vitest";

import { HERDER_ENV_CATALOG, NODE_CONFIG_CATALOG } from "../src/web/settings-catalog.js";
import {
  assertNoMachineSettings,
  buildCommonDocument,
  CommonSettingsMachineFieldError,
  commonEnvironmentKeys,
  isCommonSettingId,
  machineSettingIds,
  scopeOfSettingId,
  unclassifiedCatalogSettings,
} from "../src/common-settings/index.js";

describe("the scope of a setting is decided in one place", () => {
  it("places every setting of the catalog on one side of the line", () => {
    // A setting of the catalog that is not classified would silently never
    // travel, so a new setting of the catalog forces a decision here.
    expect(unclassifiedCatalogSettings()).toEqual([]);
  });

  it("calls the settings of the product common", () => {
    for (const key of commonEnvironmentKeys()) {
      expect(scopeOfSettingId(`herder.env/${key}`)).toBe("common");
    }
    expect(isCommonSettingId("herder.env/NOTIFY_CENTER_PROJECT")).toBe(true);
  });

  it("calls the paths, the ports, the binaries and the identity of the node machine", () => {
    const machine = [
      "node-config/hostId",
      "node-config/webPort",
      "node-config/nodeBin",
      "node-config/codexSocket",
      "node-config/codexBin",
      "node-config/catalogs",
      "node-config/stateDir",
      "node-config/fleetDir",
      "node-config/harnesses",
      "node-config/sourceSha",
      "herder.env/AGENT_HERDER_BROWSER_WORKER_PORT",
    ];
    for (const id of machine) {
      expect(scopeOfSettingId(id)).toBe("machine");
      expect(isCommonSettingId(id)).toBe(false);
    }
    expect(machineSettingIds()).toEqual(expect.arrayContaining(machine));
  });

  it("calls an unnamed setting machine, so nothing travels without a decision", () => {
    expect(scopeOfSettingId("herder.env/SOMETHING_NEW")).toBe("machine");
    expect(scopeOfSettingId("node-config/anything")).toBe("machine");
  });
});

describe("the common document holds the common settings and nothing else", () => {
  it("does not take the machine records of the node", () => {
    const document = buildCommonDocument({
      owner: "roomhacker-server-100",
      environment: {
        NOTIFY_CENTER_PROJECT: "agent-herder",
        // A machine setting that was named by mistake never enters the
        // document.
        AGENT_HERDER_BROWSER_WORKER_PORT: "9012",
      },
    });
    expect(document.environment.NOTIFY_CENTER_PROJECT).toBe("agent-herder");
    expect(Object.keys(document.environment)).not.toContain("AGENT_HERDER_BROWSER_WORKER_PORT");
    expect(document.environment).not.toHaveProperty("hostId");
    expect(document.environment).not.toHaveProperty("webPort");
    expect(document.environment).not.toHaveProperty("nodeBin");
    expect(document.environment).not.toHaveProperty("codexSocket");
    expect(document.environment).not.toHaveProperty("codexBin");
    expect(document.environment).not.toHaveProperty("catalogs");
  });

  it("refuses a document that carries a machine setting instead of trimming it", () => {
    const document = buildCommonDocument({ owner: "roomhacker-server-100" });
    const spoiled = { ...document, environment: { ...document.environment, AGENT_HERDER_BROWSER_WORKER_PORT: "9012" } };
    expect(() => assertNoMachineSettings(spoiled)).toThrow(CommonSettingsMachineFieldError);
  });

  it("keeps every common key of the environment, even the ones that are not set", () => {
    const document = buildCommonDocument({ owner: "roomhacker-server-100" });
    expect(Object.keys(document.environment).sort()).toEqual([...commonEnvironmentKeys()].sort());
    expect(document.environment.NOTIFY_CENTER_PROJECT).toBeNull();
  });
});

describe("the catalog of the product and the scope of the settings agree", () => {
  it("names every key of the environment of the catalog, common or machine", () => {
    const catalogKeys = HERDER_ENV_CATALOG.map((entry) => entry.id.slice("herder.env/".length)).sort();
    const named = [
      ...commonEnvironmentKeys(),
      ...machineSettingIds().filter((id) => id.startsWith("herder.env/")).map((id) => id.slice("herder.env/".length)),
    ].sort();
    expect(named).toEqual(catalogKeys);
  });

  it("names every key of the configuration of the node as machine", () => {
    for (const entry of NODE_CONFIG_CATALOG) {
      expect(scopeOfSettingId(entry.id)).toBe("machine");
    }
  });
});
