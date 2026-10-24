import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommonSettingsPanel,
  deliverySummary,
  fleetStateLine,
  nodeFactText,
  nodeRevisionText,
} from "../src/web-ui/settings/common-settings-section.js";
import {
  touchesCommonSettings,
  type CommonSettingsView,
  type SettingsView,
} from "../src/web-ui/settings/settings-client.js";

/**
 * The panel of the common settings shows the facts of the nodes.
 *
 * The screen names four facts and not two: a node that holds the wanted
 * revision applied it, a node that holds another one diverged, a node that
 * answered and applied nothing has not applied it yet, and a node that did
 * not answer is unreachable. A node that did not answer is never shown as
 * applied, and the panel never borrows the revision of another node for it.
 */

const sectionSource = readFileSync(new URL("../src/web-ui/settings/common-settings-section.tsx", import.meta.url), "utf8");
const screenSource = readFileSync(new URL("../src/web-ui/settings/settings-screen.tsx", import.meta.url), "utf8");

/** The view of the fleet as the panel shows it. */
const view: CommonSettingsView = {
  ok: true,
  role: "owner",
  owner: "roomhacker-server-100",
  revision: "sha256:new",
  createdAt: "2026-10-24T00:00:00.000Z",
  document: null,
  nodes: [
    {
      hostId: "server-44",
      optIn: true,
      reachable: true,
      fact: "применена",
      status: "подтвердил",
      appliedRevision: "sha256:new",
      confirmedAt: "2026-10-24T00:05:00.000Z",
      reason: null,
      conflicts: [],
    },
    {
      hostId: "server-88",
      optIn: null,
      reachable: false,
      fact: "недоступна",
      status: "не подтвердил",
      appliedRevision: null,
      confirmedAt: null,
      reason: "direct_peer_unavailable",
      conflicts: [],
    },
  ],
  notParticipating: [],
  state: "Применено частично",
  confirmed: 1,
  total: 2,
  unconfirmed: ["server-88"],
  unreachable: ["server-88"],
  checkedAt: "2026-10-24T00:06:00.000Z",
};

describe("the panel shows the facts of the nodes and nothing else", () => {
  const html = renderToStaticMarkup(createElement(CommonSettingsPanel, { view }));
  const rowOf = (hostId: string): string => {
    const match = html.match(new RegExp(`<tr[^>]*>\\s*<td><code>${hostId}</code>[\\s\\S]*?</tr>`));
    return match ? match[0] : "";
  };

  it("shows the revision that the node really applied", () => {
    expect(rowOf("server-44")).toContain("применена");
    expect(rowOf("server-44")).toContain("sha256:new");
    expect(rowOf("server-44")).toContain("herder-settings-state-applied");
  });

  it("shows a node that did not answer as unreachable and never as applied", () => {
    const row = rowOf("server-88");
    expect(row).toContain("недоступна");
    expect(row).toContain("herder-settings-state-unreachable");
    expect(row).not.toContain("herder-settings-state-applied");
    expect(row).not.toContain("применена");
    // The revision of a node that did not answer is unknown, and the panel
    // does not borrow the revision of another node for it.
    expect(row).toContain("неизвестно");
    expect(row).not.toContain("sha256:new");
  });

  it("names the node that did not answer in the line of the fleet", () => {
    expect(fleetStateLine(view)).toBe("Применено частично (1 из 2); не подтвердили: server-88 (недоступен)");
  });

  it("says what the delivery did, with the nodes that did not take the document", () => {
    expect(deliverySummary(view)).toBe(
      "Реввизия sha256:new: применили server-44; не применили: server-88 (недоступен).",
    );
  });

  it("names the fact and the revision of a node in words", () => {
    expect(nodeFactText(view.nodes[0])).toBe("применена");
    expect(nodeFactText(view.nodes[1])).toBe("недоступна");
    expect(nodeRevisionText(view.nodes[0])).toBe("sha256:new");
    expect(nodeRevisionText(view.nodes[1])).toBe("неизвестно");
  });
});

describe("the change of a common setting is delivered and confirmed by the fleet", () => {
  it("knows that a common setting changed and a machine setting did not", () => {
    const settings = { commonSettings: { keys: ["NOTIFY_CENTER_PROJECT", "NOTIFY_CENTER_RECIPIENT"] } } as unknown as SettingsView;
    expect(touchesCommonSettings(settings, ["herder.env/NOTIFY_CENTER_RECIPIENT"])).toBe(true);
    expect(touchesCommonSettings(settings, ["herder.env/AGENT_HERDER_BROWSER_WORKER_PORT"])).toBe(false);
    expect(touchesCommonSettings(settings, ["node-config/hostId"])).toBe(false);
    expect(touchesCommonSettings(null, ["herder.env/NOTIFY_CENTER_RECIPIENT"])).toBe(false);
  });

  it("asks the fleet to take the document when the owner changes a common setting", () => {
    // The panel asks the fleet to take the new document and shows the answer
    // of the nodes: the confirmation of the delivery is the answer of the
    // fleet, never the panel's own word.
    expect(sectionSource).toContain("syncCommonSettings()");
    expect(sectionSource).toContain("setNotice(deliverySummary(result));");
    expect(screenSource).toContain("setDelivery((value) => value + 1);");
    expect(screenSource).toContain("<CommonSettingsSection delivery={delivery} />");
  });
});
