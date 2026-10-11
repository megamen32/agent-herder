import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AutomationLaunchPolicyStore,
  canonicalProjectKey,
  resolveProjectLaunch,
  validateAutomationLaunchPolicy,
  type AutomationLaunchPolicy,
} from "../src/automation-launch-policy.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const policy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode", "opencode"],
  preferredHarness: "codex",
  models: {
    codex: "gpt-6.1-sol",
    zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
    opencode: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview",
  },
  projectRoutes: {
    // The real cards carry their own service identifier, so the route declares it.
    "/home/roomhacker/PycharmProjects/TelegramAuto": {
      harnesses: ["opencode", "zcode"],
      aliases: ["tg-commentator", "autotelegramviews", "canonicalTelegramAuto"],
    },
    "/home/roomhacker/agents-projects/AutoFindClient": { harnesses: ["codex", "zcode", "opencode"] },
    "/workspace/pinned": {
      harnesses: ["zcode", "opencode"],
      models: { zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
    },
  },
} as const;

async function startServer(store: AutomationLaunchPolicyStore): Promise<string> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
    automationLaunchPolicyStore: store,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}/api/automation/launch-policy`;
}

describe("per-project ordered harness routes", () => {
  it("persists the ordered routes and their explicit models through the existing seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-project-routes-"));
    directories.push(root);
    const path = join(root, "launch-policy.json");
    const url = await startServer(new AutomationLaunchPolicyStore(path));

    const saved = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    });
    expect(saved.status).toBe(200);
    const reloaded = await (await fetch(url)).json() as AutomationLaunchPolicy;

    expect(reloaded.projectRoutes).toEqual({
      "/home/roomhacker/PycharmProjects/TelegramAuto": {
        harnesses: ["opencode", "zcode"],
        aliases: ["tg-commentator", "autotelegramviews", "canonicalTelegramAuto"],
      },
      "/home/roomhacker/agents-projects/AutoFindClient": { harnesses: ["codex", "zcode", "opencode"] },
      "/workspace/pinned": {
        harnesses: ["zcode", "opencode"],
        models: { zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
      },
    });
    expect(JSON.parse(await readFile(path, "utf8")).projectRoutes["/home/roomhacker/PycharmProjects/TelegramAuto"].harnesses)
      .toEqual(["opencode", "zcode"]);
  });

  it("rejects a route that is unusable or outside the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-project-routes-invalid-"));
    directories.push(root);
    const url = await startServer(new AutomationLaunchPolicyStore(join(root, "launch-policy.json")));

    const rejected = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...policy, allowedHarnesses: ["codex"], models: { codex: "c" }, projectRoutes: { "/workspace/x": { harnesses: ["zcode"] } } }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: expect.stringContaining("not allowed") });

    expect(() => validateAutomationLaunchPolicy({ ...policy, projectRoutes: { "relative/path": { harnesses: ["codex"] } } }))
      .toThrow("absolute path");
    expect(() => validateAutomationLaunchPolicy({ ...policy, projectRoutes: { "/workspace/x": { harnesses: ["codex", "codex"] } } }))
      .toThrow("Duplicate harness");
    expect(() => validateAutomationLaunchPolicy({ ...policy, projectRoutes: { "/workspace/x": { harnesses: [] } } }))
      .toThrow("at least one harness");
    expect(() => validateAutomationLaunchPolicy({
      ...policy,
      projectRoutes: { "/workspace/x": { harnesses: ["codex"], models: { zcode: "z" } } },
    })).toThrow("unused harness");
    expect(() => validateAutomationLaunchPolicy({
      ...policy,
      models: { codex: "c", zcode: "z", opencode: "" },
    })).toThrow("nonempty string");
  });

  it("advances only after a definite pre-admission failure", async () => {
    const validated = validateAutomationLaunchPolicy(policy);
    const project = "/home/roomhacker/PycharmProjects/TelegramAuto";

    expect(resolveProjectLaunch(validated, { project })).toMatchObject({
      kind: "launch", harness: "opencode", model: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview", mode: "create",
    });
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode"], outcome: "unavailable" }))
      .toMatchObject({ kind: "launch", harness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" });
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode"], outcome: "quota_exhausted" }))
      .toMatchObject({ kind: "launch", harness: "zcode" });
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode"], outcome: "pre_admission_rejected" }))
      .toMatchObject({ kind: "launch", harness: "zcode" });

    // An accepted executor and an unknown admission both stop the chain.
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode"], outcome: "accepted" }))
      .toEqual({ kind: "exhausted", reason: "accepted" });
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode"], outcome: "admission_unknown" }))
      .toEqual({ kind: "exhausted", reason: "admission_unknown" });
    // Every route harness was already tried.
    expect(resolveProjectLaunch(validated, { project, attempted: ["opencode", "zcode"], outcome: "unavailable" }))
      .toEqual({ kind: "exhausted", reason: "no_harness_left" });
  });

  it("resumes a linked session by id and hands the context over instead of cloning", () => {
    const validated = validateAutomationLaunchPolicy(policy);
    const project = "/home/roomhacker/agents-projects/AutoFindClient";

    expect(resolveProjectLaunch(validated, { project, activeSession: { harness: "codex", sessionId: "thread-42" } }))
      .toMatchObject({ kind: "launch", harness: "codex", mode: "resume", sessionId: "thread-42" });
    expect(resolveProjectLaunch(validated, {
      project,
      attempted: ["codex"],
      outcome: "quota_exhausted",
      activeSession: { harness: "codex", sessionId: "thread-42" },
    })).toMatchObject({ kind: "launch", harness: "zcode", mode: "handoff", sessionId: "thread-42", fromHarness: "codex" });
  });

  it("resolves the real Notice project identifiers and case variants", () => {
    const validated = validateAutomationLaunchPolicy(policy);
    // TGC cards are created with the service project id, not the checkout path.
    expect(resolveProjectLaunch(validated, { project: "tg-commentator" })).toMatchObject({
      kind: "launch", harness: "opencode", model: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview", mode: "create",
    });
    expect(resolveProjectLaunch(validated, { project: "autotelegramviews" })).toMatchObject({ kind: "launch", harness: "opencode" });
    expect(resolveProjectLaunch(validated, { project: "TG-Commentator" })).toMatchObject({ kind: "launch", harness: "opencode" });
    expect(resolveProjectLaunch(validated, { project: "canonicaltelegramauto" })).toMatchObject({ kind: "launch", harness: "opencode" });
    // The AutoFindClient route keeps its own canonical path with case folding.
    expect(resolveProjectLaunch(validated, { project: "/HOME/roomhacker/agents-projects/autofindclient" }))
      .toMatchObject({ kind: "launch", harness: "codex", model: "gpt-6.1-sol" });
    // An unrelated project, including autosell, is not bound to any route.
    expect(resolveProjectLaunch(validated, { project: "/home/roomhacker/PycharmProjects/AutoSellBot" }))
      .toEqual({ kind: "unconfigured" });
    expect(() => validateAutomationLaunchPolicy({
      ...policy,
      projectRoutes: { "/x": { harnesses: ["codex"], aliases: ["one", "ONE"] } },
    })).toThrow("repeats alias");
  });

  it("leaves an unconfigured project on the default route", () => {
    const validated = validateAutomationLaunchPolicy(policy);

    expect(resolveProjectLaunch(validated, { project: "/workspace/unconfigured" })).toEqual({ kind: "unconfigured" });
    expect(resolveProjectLaunch({ version: 1, allowedHarnesses: [], preferredHarness: "codex", models: {} }, { project: "/workspace/x" }))
      .toEqual({ kind: "unconfigured" });
    expect(canonicalProjectKey("/workspace/incident/")).toBe("/workspace/incident");
    expect(resolveProjectLaunch(validated, { project: "/home/roomhacker/PycharmProjects/TelegramAuto/" }).kind).toBe("launch");
  });
});
describe("project route editing", () => {
  it("keeps the ordered list usable and parses what the server returns", async () => {
    const ui = await import("../src/web-ui/launch-policy-settings.js");
    const route = { harnesses: ["opencode", "zcode"] };

    expect(ui.DEFAULT_LAUNCH_POLICY.models.codex).toBe("gpt-6.1-sol");
    expect(ui.moveProjectRouteHarness(route, "zcode", -1)).toEqual({ harnesses: ["zcode", "opencode"] });
    expect(ui.moveProjectRouteHarness(route, "zcode", -1)).toEqual({ harnesses: ["zcode", "opencode"] });
    expect(ui.moveProjectRouteHarness(route, "zcode", -1).harnesses[0]).toBe("zcode");
    expect(ui.moveProjectRouteHarness(route, "opencode", -1)).toEqual(route);
    expect(ui.normalizeProjectKey("/home/user/project/")).toBe("/home/user/project");

    expect(ui.parseProjectRoutes({
      "/home/user/project": { harnesses: ["opencode", "zcode"], models: { opencode: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview" } },
    })).toEqual({
      "/home/user/project": { harnesses: ["opencode", "zcode"], models: { opencode: "minimax-coding-plan/MiniMax-M3.1-Flash-Preview" } },
    });
    expect(() => ui.parseProjectRoutes({ "relative": { harnesses: ["codex"] } })).toThrow("абсолютным путём");
    expect(() => ui.parseProjectRoutes({ "/x": { harnesses: [] } })).toThrow("должен содержать среды");

    const updated = ui.updateProjectRoute(
      { version: 1, allowedHarnesses: ["opencode", "zcode"], preferredHarness: "opencode", models: { opencode: "o", zcode: "z" }, projectRoutes: { "/x": route } },
      "/x",
      (value) => ui.moveProjectRouteHarness(value, "zcode", -1),
    );
    expect(updated.projectRoutes?.["/x"]?.harnesses).toEqual(["zcode", "opencode"]);
    expect(ui.updateProjectRoute({ version: 1, allowedHarnesses: [], preferredHarness: "opencode", models: {} }, "/missing", (value) => value).projectRoutes).toEqual({});
  });
});
