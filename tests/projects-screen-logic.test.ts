import { describe, expect, it } from "vitest";
import {
  buildProjectEntries,
  filterKnownProjectPaths,
  filterProjectEntries,
  groupProjectEntriesByMachine,
  isRealProjectPath,
  isRestrictedProject,
  projectName,
  sortProjectEntries,
  type FleetHostFact,
  type FleetSessionFact,
} from "../src/web-ui/projects-settings.js";
import type { ProjectLaunchRoute } from "../src/web-ui/launch-policy-settings.js";

const hosts: FleetHostFact[] = [
  { hostId: "roomhacker-server-100", label: "server-100", state: "ready" },
  { hostId: "roomhacker-server-88", label: "server-88", state: "ready" },
  { hostId: "server-44", label: "server-44", state: "offline" },
  { hostId: "roomhacker-server-44", label: "server-44-b", state: "unavailable" },
  { hostId: "mac-mini-2012.lan", label: "mac-mini", state: "ready" },
];

const sessions: FleetSessionFact[] = [
  { hostId: "roomhacker-server-100", launchCwd: "/home/roomhacker/PycharmProjects/TelegramAuto", lastActivity: "2026-10-22T18:00:00Z", model: "omniroute/minimax-combo-m3.1" },
  { hostId: "roomhacker-server-100", launchCwd: "/home/roomhacker/PycharmProjects/TelegramAuto/sub", lastActivity: "2026-10-22T19:30:00Z", model: "" },
  { hostId: "roomhacker-server-88", launchCwd: "/home/roomhacker/agents-projects/agent-herder", lastActivity: "2026-10-22T12:00:00Z", model: "" },
];

const routes: Array<[string, ProjectLaunchRoute]> = [
  ["/home/roomhacker/PycharmProjects/TelegramAuto", {
    harnesses: ["opencode"],
    aliases: ["TelegramAuto", "TGC"],
    allowedModels: ["omniroute/minimax-combo-m3.1"],
    deniedModels: ["codex/gpt-6.1-sol"],
  }],
  ["/home/roomhacker/agents-projects/agent-herder", { harnesses: ["codex", "opencode"] }],
  ["/home/roomhacker/Documents/ServerAdministartion", { harnesses: ["opencode"], aliases: ["ServerAdministartion"] }],
];

const entries = buildProjectEntries(routes, hosts, sessions);

describe("the search over the projects", () => {
  it("finds a project by its human name, its path and its machine, ignoring the case", () => {
    expect(filterProjectEntries(entries, "telegramauto").map((entry) => entry.project))
      .toEqual(["/home/roomhacker/PycharmProjects/TelegramAuto"]);
    expect(filterProjectEntries(entries, "PYCHARM").map((entry) => entry.project))
      .toEqual(["/home/roomhacker/PycharmProjects/TelegramAuto"]);
    expect(filterProjectEntries(entries, "СЕРВЕР 88").map((entry) => entry.project))
      .toEqual(["/home/roomhacker/agents-projects/agent-herder"]);
  });

  it("finds a project by the machine id and by a card identifier", () => {
    expect(filterProjectEntries(entries, "mac-mini-2012.lan")).toEqual([]);
    expect(filterProjectEntries(entries, "roomhacker-server-88").map((entry) => entry.project))
      .toEqual(["/home/roomhacker/agents-projects/agent-herder"]);
    expect(filterProjectEntries(entries, "TGC").map((entry) => entry.project))
      .toEqual(["/home/roomhacker/PycharmProjects/TelegramAuto"]);
  });

  it("keeps every project when the query is empty and hides the list when nothing matches", () => {
    expect(filterProjectEntries(entries, "   ")).toHaveLength(3);
    expect(filterProjectEntries(entries, "нетакого")).toEqual([]);
  });
});

describe("the order and the grouping of the projects", () => {
  it("puts the freshest project first and the oldest last", () => {
    const sorted = sortProjectEntries(entries, "recent");
    expect(sorted.map((entry) => entry.name)).toEqual(["TelegramAuto", "agent-herder", "ServerAdministartion"]);
    expect(sorted[0]?.lastActivity).toBe("2026-10-22T19:30:00Z");
  });

  it("orders the projects by name when the operator asks for it", () => {
    expect(sortProjectEntries(entries, "name").map((entry) => entry.name))
      .toEqual(["agent-herder", "ServerAdministartion", "TelegramAuto"]);
  });

  it("groups the projects by the machine with the label of the fleet", () => {
    const groups = groupProjectEntriesByMachine(sortProjectEntries(entries, "recent"));
    expect(groups.map((group) => group.label)).toEqual(["Сервер 100", "Сервер 88", "Машина неизвестна"]);
    expect(groups[0]?.entries.map((entry) => entry.name)).toEqual(["TelegramAuto"]);
    expect(groups[2]?.entries.map((entry) => entry.name)).toEqual(["ServerAdministartion"]);
  });

  it("takes the machine and the freshness of the project from the sessions of the fleet", () => {
    const telegram = entries.find((entry) => entry.name === "TelegramAuto");
    expect(telegram?.hostId).toBe("roomhacker-server-100");
    expect(telegram?.hostLabel).toBe("Сервер 100");
    expect(telegram?.environmentCount).toBe(1);
    expect(telegram?.modelCount).toBe(2);
    expect(telegram?.aliases).toEqual(["TelegramAuto", "TGC"]);
  });

  it("names the project by its card identifier, and by its folder when there is none", () => {
    expect(projectName("/home/roomhacker/PycharmProjects/video_watching", { harnesses: ["opencode"] }))
      .toBe("video_watching");
    expect(projectName("/home/roomhacker/PycharmProjects/video_watching", { harnesses: ["opencode"], aliases: ["TGC"] }))
      .toBe("TGC");
  });
});

describe("the list of the known project folders", () => {
  it("keeps the real projects", () => {
    expect(isRealProjectPath("/home/roomhacker/PycharmProjects/TelegramAuto")).toBe(true);
    expect(isRealProjectPath("/home/roomhacker/agents-projects/agent-herder")).toBe(true);
    expect(isRealProjectPath("/home/user/Documents/ServerAdministartion")).toBe(true);
  });

  it("drops the worktrees, the caches and the temporary copies", () => {
    expect(isRealProjectPath("/home/roomhacker/.codex/worktrees/abc123")).toBe(false);
    expect(isRealProjectPath("/home/roomhacker/.cache/lhc-overseer")).toBe(false);
    expect(isRealProjectPath("/home/roomhacker/agents-projects/.worktrees/herder-x")).toBe(false);
    expect(isRealProjectPath("/tmp/herder-final-window-2")).toBe(false);
    expect(isRealProjectPath("/home/roomhacker/PycharmProjects/TelegramAuto/node_modules")).toBe(false);
  });

  it("filters the known paths without touching the real ones", () => {
    const paths = [
      "/home/roomhacker/PycharmProjects/TelegramAuto",
      "/home/roomhacker/.codex/worktrees/abc123",
      "/home/roomhacker/.cache/lhc-overseer",
      "/home/roomhacker/agents-projects/agent-herder",
    ];
    expect(filterKnownProjectPaths(paths)).toEqual([
      "/home/roomhacker/PycharmProjects/TelegramAuto",
      "/home/roomhacker/agents-projects/agent-herder",
    ]);
  });
});

describe("the closed projects of the rule of the owner", () => {
  it("knows the two closed roots of the guard of the OpenCode integration", () => {
    expect(isRestrictedProject("/home/roomhacker/PycharmProjects/TelegramAuto")).toBe(true);
    expect(isRestrictedProject("/home/roomhacker/PycharmProjects/video_watching")).toBe(true);
    expect(isRestrictedProject("/home/roomhacker/PycharmProjects/video_watching/sub")).toBe(true);
    expect(isRestrictedProject("/home/roomhacker/agents-projects/agent-herder")).toBe(false);
  });
});
