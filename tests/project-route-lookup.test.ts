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
  findProjectRouteMatch,
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
    expect(findProjectModelRoute(routes, `${root}/app`)?.matchKind).toBe("exact");
    expect(findProjectModelRoute(routes, `${root}/APP`)?.matchKind).toBe("case");
    expect(findProjectModelRoute(routes, "app-card")?.matchKind).toBe("alias");
    expect(findProjectModelRoute(routes, `${root}/app/src`)?.matchKind).toBe("nested");
  });

  it("names the route key of every kind of match", () => {
    const root = projectRoot();
    const routes = { [`${root}/app`]: { harnesses: ["opencode"] as const, aliases: ["app-card"] } };
    expect(findProjectModelRoute(routes, `${root}/app`)?.routeKey).toBe(`${root}/app`);
    expect(findProjectModelRoute(routes, `${root}/APP`)?.routeKey).toBe(`${root}/app`);
    expect(findProjectModelRoute(routes, "app-card")?.routeKey).toBe(`${root}/app`);
    expect(findProjectModelRoute(routes, `${root}/app/src`)?.routeKey).toBe(`${root}/app`);
  });
});

describe("the boundary of a route root", () => {
  it("does not capture a folder that only starts with the same characters", () => {
    const root = projectRoot();
    const routes = { [`${root}/app/deep`]: { harnesses: ["opencode"] as const } };
    expect(findProjectModelRoute(routes, `${root}/app/deep/child`)?.matchKind).toBe("nested");
    expect(findProjectModelRoute(routes, `${root}/app/deepx`)).toBeUndefined();
    expect(findProjectModelRoute(routes, `${root}/app/deep-backup`)).toBeUndefined();
  });

  it("resolves an alias to the route and never uses it as a root", () => {
    const root = projectRoot();
    const routes = { [`${root}/app`]: { harnesses: ["opencode"] as const, aliases: ["app-card"] } };
    expect(findProjectModelRoute(routes, "app-card")?.routeKey).toBe(`${root}/app`);
    expect(findProjectModelRoute(routes, "app-card")?.matchKind).toBe("alias");
    expect(findProjectModelRoute(routes, "app-card/child")).toBeUndefined();
  });
});

describe("the determinism of the lookup", () => {
  it("breaks a tie between two roots of the same length by the smaller root", () => {
    const root = projectRoot();
    // The same length, inserted in reverse alphabetical order.
    const routes = {
      [`${root}/app/sub`]: { harnesses: ["opencode"] as const },
      [`${root}/app/SUB`]: { harnesses: ["opencode"] as const },
    };
    expect(findProjectModelRoute(routes, `${root}/app/Sub`)?.matchKind).toBe("case");
    expect(findProjectModelRoute(routes, `${root}/app/Sub`)?.routeKey).toBe(`${root}/app/SUB`);
  });

  it("resolves the same route whatever the order of the keys of the document", () => {
    const root = projectRoot();
    const first = {
      [`${root}/app/sub`]: { harnesses: ["opencode"] as const, aliases: ["shared-card"] },
      [`${root}/app/SUB`]: { harnesses: ["opencode"] as const, aliases: ["shared-card"] },
      [`${root}/app/deep`]: { harnesses: ["opencode"] as const },
    };
    const second = {
      [`${root}/app/deep`]: { harnesses: ["opencode"] as const },
      [`${root}/app/SUB`]: { harnesses: ["opencode"] as const, aliases: ["shared-card"] },
      [`${root}/app/sub`]: { harnesses: ["opencode"] as const, aliases: ["shared-card"] },
    };
    for (const directory of [`${root}/app/Sub`, `${root}/app/sub/src`, `${root}/app/deep/src`, "shared-card"]) {
      expect(findProjectModelRoute(second, directory)?.routeKey)
        .toBe(findProjectModelRoute(first, directory)?.routeKey);
    }
    expect(findProjectModelRoute(first, "shared-card")?.routeKey).toBe(`${root}/app/SUB`);
    expect(findProjectModelRoute(second, "shared-card")?.routeKey).toBe(`${root}/app/SUB`);
  });

  it("gives the longer root the directory it contains", () => {
    const root = projectRoot();
    const routes = {
      [`${root}/app`]: { harnesses: ["opencode"] as const },
      [`${root}/app/sub`]: { harnesses: ["opencode"] as const },
    };
    expect(findProjectModelRoute(routes, `${root}/app/sub/src`)?.routeKey).toBe(`${root}/app/sub`);
    expect(findProjectModelRoute(routes, `${root}/app/src`)?.routeKey).toBe(`${root}/app`);
  });
});

describe("the matrix of nested roots", () => {
  it("gives the deeper route to the deeper folder", () => {
    const root = projectRoot();
    const parent = `${root}/a`;
    const child = `${root}/a/b`;
    const routes = {
      [parent]: { harnesses: ["opencode"] as const },
      [child]: { harnesses: ["opencode"] as const },
    };
    expect(findProjectModelRoute(routes, child)?.routeKey).toBe(child);
    expect(findProjectModelRoute(routes, `${child}/src`)?.routeKey).toBe(child);
    expect(findProjectModelRoute(routes, `${parent}/src`)?.routeKey).toBe(parent);
  });

  it("keeps a sibling of the deeper route on the parent route", () => {
    const root = projectRoot();
    const parent = `${root}/a`;
    const child = `${root}/a/b`;
    const routes = {
      [parent]: { harnesses: ["opencode"] as const },
      [child]: { harnesses: ["opencode"] as const },
    };
    // /a/bc and /a/b-backup are children of /a, not of /a/b.
    expect(findProjectModelRoute(routes, `${parent}/bc`)?.routeKey).toBe(parent);
    expect(findProjectModelRoute(routes, `${parent}/b-backup`)?.routeKey).toBe(parent);
  });

  it("does not let the deeper route capture its siblings", () => {
    const root = projectRoot();
    const parent = `${root}/a`;
    const child = `${root}/a/b`;
    const routes = { [child]: { harnesses: ["opencode"] as const } };
    expect(findProjectModelRoute(routes, `${parent}/bc`)).toBeUndefined();
    expect(findProjectModelRoute(routes, `${parent}/b-backup`)).toBeUndefined();
    expect(findProjectModelRoute(routes, `${child}/src`)?.routeKey).toBe(child);
  });
});

describe("the gate and the launch of one directory", () => {
  it("find the same route, also inside a routed project", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"], aliases: ["app-card"] },
    });
    for (const directory of [`${root}/app`, `${root}/app/src`, `${root}/app/src/deep`]) {
      const launchRoute = findProjectRoute(policy, directory);
      expect(findModelPolicyRouteForPath(policy.projectRoutes, directory)).toBe(launchRoute);
      expect(findModelPolicyRoute(policy.projectRoutes, directory)).toBe(launchRoute);
      expect(findProjectRouteKey(policy, directory)).toBe(`${root}/app`);
      expect(findProjectRouteMatch(policy, directory)?.routeKey).toBe(`${root}/app`);
    }
    expect(findProjectRouteMatch(policy, `${root}/app`)?.matchKind).toBe("exact");
    expect(findProjectRouteMatch(policy, `${root}/app/src`)?.matchKind).toBe("nested");
  });

  it("refuse the same model at the tool boundary and at the launch", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: {
        harnesses: ["opencode"],
        models: { opencode: "denied-model" },
        deniedModels: ["denied-model"],
      },
    });
    const directory = `${root}/app/src`;
    expect(resolveProjectLaunch(policy, { project: directory }))
      .toEqual({ kind: "exhausted", reason: "model_not_permitted" });
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "denied-model"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
  });
});

describe("a project without a route", () => {
  it("keeps the global policy of the harness", async () => {
    const root = projectRoot();
    const policy = policyWith({ [`${root}/other`]: { harnesses: ["opencode"] } });
    const directory = `${root}/app/src`;
    expect(resolveProjectLaunch(policy, { project: directory })).toEqual({ kind: "unconfigured" });
    expect(findProjectRoute(policy, directory)).toBeUndefined();
    expect(findProjectRouteKey(policy, directory)).toBeUndefined();
    expect(findProjectRouteMatch(policy, directory)).toBeUndefined();
    expect(modelPermittedForProject(policy, directory, "any-model")).toBe(true);
    expect(effectiveModelForProject(policy, directory, "opencode")).toBe(globalModel);
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "any-model"))
      .resolves.toBeUndefined();
  });
});
