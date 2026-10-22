/**
 * The one route lookup: the launch permission and the model gate must resolve
 * the project of a session the same way.
 *
 * The defect this covers: a session that started in a subdirectory of a routed
 * project was judged by the model lists of that project at the tool boundary,
 * but the launch permission found no route at all and launched the global
 * model of the harness.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findProjectRoute,
  findProjectRouteKey,
  resolveProjectLaunch,
  type AutomationLaunchPolicy,
} from "../src/automation-launch-policy.js";
import {
  effectiveModelForProject,
  findModelPolicyRoute,
  findModelPolicyRouteForPath,
  findProjectModelRoute,
  modelPermittedForProject,
} from "../src/project-model-policy.js";
import {
  assertModelAllowedForDirectoryWithPolicy,
  assertModelAllowedForProject,
} from "../src/project-model-gate.js";

const directories: string[] = [];

beforeAll(async () => {
  directories.push(await mkdtemp(join(tmpdir(), "agent-herder-route-lookup-")));
});

afterAll(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A real temporary project root, so no test depends on a production path. */
function projectRoot(): string {
  return directories[0]!;
}

const globalModel = "global-model";

function policyWith(routes: AutomationLaunchPolicy["projectRoutes"]): AutomationLaunchPolicy {
  return {
    version: 1,
    allowedHarnesses: ["codex", "zcode", "opencode"],
    preferredHarness: "codex",
    models: {
      codex: globalModel,
      zcode: globalModel,
      opencode: globalModel,
    },
    projectRoutes: routes,
  };
}

describe("the launch permission of a directory inside a routed project", () => {
  it("uses the model of the route instead of the global model", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    expect(resolveProjectLaunch(policy, { project: `${root}/app/src` }))
      .toMatchObject({ kind: "launch", harness: "opencode", model: "route-model" });
  });

  it("falls back to the global model of the harness when the route names none", () => {
    const root = projectRoot();
    const policy = policyWith({ [`${root}/app`]: { harnesses: ["opencode"] } });
    expect(resolveProjectLaunch(policy, { project: `${root}/app/src` }))
      .toMatchObject({ kind: "launch", harness: "opencode", model: globalModel });
  });

  it("refuses a subdirectory exactly like the project root", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], allowedModels: ["route-model"] },
    });
    const rootResolution = resolveProjectLaunch(policy, { project: `${root}/app` });
    const nestedResolution = resolveProjectLaunch(policy, { project: `${root}/app/src/deep` });
    expect(rootResolution).toEqual({ kind: "exhausted", reason: "model_not_permitted" });
    expect(nestedResolution).toEqual(rootResolution);
  });

  it("refuses a subdirectory when the route denies the model of the harness", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: [globalModel] },
    });
    expect(resolveProjectLaunch(policy, { project: `${root}/app/src` }))
      .toEqual({ kind: "exhausted", reason: "model_not_permitted" });
  });

  it("keeps a project without a route on the global policy", () => {
    const root = projectRoot();
    const policy = policyWith({ [`${root}/other`]: { harnesses: ["opencode"] } });
    expect(resolveProjectLaunch(policy, { project: `${root}/app/src` }))
      .toEqual({ kind: "unconfigured" });
    expect(modelPermittedForProject(policy, `${root}/app/src`, globalModel)).toBe(true);
  });
});

describe("the model gate of a directory inside a routed project", () => {
  it("refuses a denied model in a subdirectory of the project", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"] },
    });
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, `${root}/app/src`, "denied-model"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, `${root}/app/src`, "other-model"))
      .resolves.toBeUndefined();
  });

  it("applies the route of the containing root to an explicit request", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"] },
    });
    await expect(assertModelAllowedForProject(async () => policy, `${root}/app/src`, "denied-model"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
    expect(modelPermittedForProject(policy, `${root}/app/src`, "denied-model")).toBe(false);
  });

  it("counts the effective model of a subdirectory from the same route", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    expect(effectiveModelForProject(policy, `${root}/app/src`, "opencode")).toBe("route-model");
    expect(effectiveModelForProject(policy, `${root}/app`, "opencode")).toBe("route-model");
  });

  it("leaves a project without a route untouched", async () => {
    const root = projectRoot();
    const policy = policyWith({});
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, `${root}/app/src`, "any-model"))
      .resolves.toBeUndefined();
  });
});

describe("the shared route lookup", () => {
  it("resolves the same route for the launch permission and for the gate", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], aliases: ["app-card"] },
    });
    const directory = `${root}/app/src`;
    expect(findProjectRoute(policy, directory)).toBe(policy.projectRoutes![`${root}/app`]);
    expect(findModelPolicyRouteForPath(policy.projectRoutes, directory)).toBe(policy.projectRoutes![`${root}/app`]);
    expect(findModelPolicyRoute(policy.projectRoutes, directory)).toBe(policy.projectRoutes![`${root}/app`]);
    expect(findProjectRouteKey(policy, directory)).toBe(`${root}/app`);
  });

  it("still finds a route by its exact folder, its case and its alias", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], aliases: ["app-card"] },
    });
    const route = policy.projectRoutes![`${root}/app`];
    expect(findProjectRoute(policy, `${root}/app`)).toBe(route);
    expect(findProjectRoute(policy, `${root}/app/`.replace(/\/+$/, ""))).toBe(route);
    expect(findProjectRoute(policy, `${root}/APP`)).toBe(route);
    expect(findProjectRoute(policy, "app-card")).toBe(route);
    expect(findProjectRouteKey(policy, "app-card")).toBe(`${root}/app`);
  });

  it("lets the longest containing root win", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["route-model"] },
      [`${root}/app/sub`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    const parent = policy.projectRoutes![`${root}/app`]!;
    const child = policy.projectRoutes![`${root}/app/sub`]!;
    expect(findProjectRoute(policy, `${root}/app/src`)).toBe(parent);
    expect(findProjectRoute(policy, `${root}/app/sub/src`)).toBe(child);
    expect(findProjectRouteKey(policy, `${root}/app/sub/src`)).toBe(`${root}/app/sub`);
    expect(modelPermittedForProject(policy, `${root}/app/sub/src`, "route-model")).toBe(true);
    expect(modelPermittedForProject(policy, `${root}/app/src`, "route-model")).toBe(false);
  });

  it("does not treat a folder with a common prefix as a subdirectory", () => {
    const root = projectRoot();
    const policy = policyWith({ [`${root}/app`]: { harnesses: ["opencode"] } });
    expect(findProjectRoute(policy, `${root}/app-other`)).toBeUndefined();
    expect(findProjectRoute(policy, `${root}/app-other/src`)).toBeUndefined();
  });

  it("reports how a directory matched the route", () => {
    const root = projectRoot();
    const routes = { [`${root}/app`]: { harnesses: ["opencode"] as const, aliases: ["app-card"] } };
    expect(findProjectModelRoute(routes, `${root}/app`)?.kind).toBe("exact");
    expect(findProjectModelRoute(routes, `${root}/APP`)?.kind).toBe("case");
    expect(findProjectModelRoute(routes, "app-card")?.kind).toBe("alias");
    expect(findProjectModelRoute(routes, `${root}/app/src`)?.kind).toBe("nested");
  });
});
