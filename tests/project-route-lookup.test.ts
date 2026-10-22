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
  findGoverningProjectRoute,
  findGoverningProjectRouteMatch,
  findProjectRoute,
  findProjectRouteKey,
  findProjectRouteMatch,
  resolveProjectLaunch,
  type AutomationLaunchPolicy,
} from "../src/automation-launch-policy.js";
import { attemptKeyOf, routeKeyOf } from "../src/automation/project-launch-dispatch.js";
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

describe("the containment lookup of the model contour", () => {
  it("resolves the same route for the model resolution of the launch and for the gate", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], aliases: ["app-card"] },
    });
    for (const directory of [`${root}/app`, `${root}/app/src`]) {
      const governingRoute = findGoverningProjectRoute(policy, directory);
      expect(governingRoute).toBe(policy.projectRoutes![`${root}/app`]);
      expect(findModelPolicyRouteForPath(policy.projectRoutes, directory)).toBe(governingRoute);
      expect(findModelPolicyRoute(policy.projectRoutes, directory)).toBe(governingRoute);
      expect(findGoverningProjectRouteMatch(policy, directory)?.routeKey).toBe(`${root}/app`);
    }
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
    expect(findGoverningProjectRoute(policy, `${root}/app/src`)).toBe(parent);
    expect(findGoverningProjectRoute(policy, `${root}/app/sub/src`)).toBe(child);
    expect(findGoverningProjectRouteMatch(policy, `${root}/app/sub/src`)?.routeKey).toBe(`${root}/app/sub`);
    expect(modelPermittedForProject(policy, `${root}/app/sub/src`, "route-model")).toBe(true);
    expect(modelPermittedForProject(policy, `${root}/app/src`, "route-model")).toBe(false);
  });

  it("does not treat a folder with a common prefix as a subdirectory", () => {
    const root = projectRoot();
    const policy = policyWith({ [`${root}/app`]: { harnesses: ["opencode"] } });
    expect(findProjectRoute(policy, `${root}/app-other`)).toBeUndefined();
    expect(findProjectRoute(policy, `${root}/app-other/src`)).toBeUndefined();
    expect(findGoverningProjectRoute(policy, `${root}/app-other/src`)).toBeUndefined();
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

describe("the split of the two lookups", () => {
  it("keeps the identity of a subdirectory and gives it the rules of its project", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["route-model"], aliases: ["app-card"] },
    });
    const directory = `${root}/app/src`;
    // The identity: the subdirectory is not the project and has no route of its own.
    expect(findProjectRoute(policy, directory)).toBeUndefined();
    expect(findProjectRouteKey(policy, directory)).toBeUndefined();
    expect(findProjectRouteMatch(policy, directory)).toBeUndefined();
    // The containment: the subdirectory inherits the rules of the project.
    expect(findGoverningProjectRoute(policy, directory)).toBe(policy.projectRoutes![`${root}/app`]);
    expect(findGoverningProjectRouteMatch(policy, directory)?.matchKind).toBe("nested");
  });

  it("launches a subdirectory on the model of the route that governs it", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    expect(resolveProjectLaunch(policy, { project: `${root}/app/src` }))
      .toMatchObject({ kind: "launch", harness: "opencode", model: "route-model" });
    expect(resolveProjectLaunch(policy, { project: `${root}/app` }))
      .toMatchObject({ kind: "launch", harness: "opencode", model: "route-model" });
  });

  it("keeps the working folder and the work key of a subdirectory", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    // The work key of a subdirectory is its own path, so the launch keeps the
    // requested working folder and never moves it to the root of the route.
    expect(routeKeyOf(policy, `${root}/app/src`)).toBeUndefined();
    expect(attemptKeyOf(policy, `${root}/app/src`)).toBe(`${root}/app/src`);
    expect(routeKeyOf(policy, `${root}/app`)).toBe(`${root}/app`);
    expect(attemptKeyOf(policy, `${root}/app`)).toBe(`${root}/app`);
  });

  it("captures a folder with a common prefix by neither rule", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/a/b`]: { harnesses: ["opencode"], deniedModels: ["route-model"] },
    });
    for (const directory of [`${root}/a/bc`, `${root}/a/b-backup`, `${root}/a/bc/src`]) {
      expect(findProjectRoute(policy, directory)).toBeUndefined();
      expect(findGoverningProjectRoute(policy, directory)).toBeUndefined();
      expect(modelPermittedForProject(policy, directory, "route-model")).toBe(true);
    }
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

describe("a directory that walks with a relative segment", () => {
  it("does not inherit the lists of the route it walks out of", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/workspace/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"] },
    });
    const directory = `${root}/workspace/app/../other`;
    expect(findProjectModelRoute(policy.projectRoutes, directory)).toBeUndefined();
    expect(findProjectRoute(policy, directory)).toBeUndefined();
    expect(modelPermittedForProject(policy, directory, "denied-model")).toBe(true);
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "denied-model"))
      .resolves.toBeUndefined();
  });

  it("lands in the route it really lies in", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/workspace/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"] },
      [`${root}/workspace/other`]: { harnesses: ["opencode"], models: { opencode: "route-model" } },
    });
    const directory = `${root}/workspace/app/../other`;
    expect(findProjectModelRoute(policy.projectRoutes, directory)?.routeKey).toBe(`${root}/workspace/other`);
    expect(findProjectModelRoute(policy.projectRoutes, directory)?.matchKind).toBe("exact");
    expect(modelPermittedForProject(policy, directory, "denied-model")).toBe(true);
  });

  it("stays under the route it walks inside of", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/workspace/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"] },
    });
    const directory = `${root}/workspace/app/src/../lib`;
    expect(findProjectModelRoute(policy.projectRoutes, directory)?.routeKey).toBe(`${root}/workspace/app`);
    expect(findProjectModelRoute(policy.projectRoutes, directory)?.matchKind).toBe("nested");
    expect(modelPermittedForProject(policy, directory, "denied-model")).toBe(false);
  });

  it("keeps the boundary of a root against a sibling with a common prefix", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/workspace/app`]: { harnesses: ["opencode"] },
    });
    expect(findProjectModelRoute(policy.projectRoutes, `${root}/workspace/appX`)).toBeUndefined();
    expect(findProjectModelRoute(policy.projectRoutes, `${root}/workspace/app/../appX`)).toBeUndefined();
  });

  it("canonicalizes the directory the same way as the root", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/workspace/app`]: { harnesses: ["opencode"] },
    });
    expect(findProjectModelRoute(policy.projectRoutes, `${root}/workspace/app/./src`)?.routeKey)
      .toBe(`${root}/workspace/app`);
    expect(findProjectModelRoute(policy.projectRoutes, `${root}/workspace/./app`)?.matchKind).toBe("exact");
  });
});

describe("the identifiers of the model lists", () => {
  it("does not let a catalog leaf identifier stand in for the route", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: {
        harnesses: ["opencode"],
        allowedModels: ["omniroute/minimax-combo-m3.1"],
        deniedModels: ["gpt-6.1-sol"],
      },
    });
    const directory = `${root}/app/src`;
    // The leaf of the catalog is a different identifier than the route, so it
    // is not on the allow list of the route and the gate refuses it.
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "mmcode/MiniMax-M3.1-Flash"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "minimax-code/mmcode/MiniMax-M3.1-Flash"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
    // The route of the policy is the identifier of the model of the project.
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, directory, "omniroute/minimax-combo-m3.1"))
      .resolves.toBeUndefined();
  });

  it("does not deny the route by a leaf identifier", () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["mmcode/MiniMax-M3.1-Flash"] },
    });
    // A deny list written with a leaf identifier does not match the route: the
    // route of the policy stays permitted.
    expect(modelPermittedForProject(policy, `${root}/app/src`, "omniroute/minimax-combo-m3.1")).toBe(true);
    // The leaf identifier itself is denied, because the list names it exactly.
    expect(modelPermittedForProject(policy, `${root}/app/src`, "mmcode/MiniMax-M3.1-Flash")).toBe(false);
  });
});

describe("the gate and the launch of one directory", () => {
  it("find the same route, also inside a routed project", async () => {
    const root = projectRoot();
    const policy = policyWith({
      [`${root}/app`]: { harnesses: ["opencode"], deniedModels: ["denied-model"], aliases: ["app-card"] },
    });
    for (const directory of [`${root}/app`, `${root}/app/src`, `${root}/app/src/deep`]) {
      // The gate of the tools and the model resolution of the launch share one
      // containment lookup, so they can never judge a directory differently.
      const governingRoute = findGoverningProjectRoute(policy, directory);
      expect(findModelPolicyRouteForPath(policy.projectRoutes, directory)).toBe(governingRoute);
      expect(findModelPolicyRoute(policy.projectRoutes, directory)).toBe(governingRoute);
      expect(findGoverningProjectRouteMatch(policy, directory)?.routeKey).toBe(`${root}/app`);
    }
    expect(findGoverningProjectRouteMatch(policy, `${root}/app`)?.matchKind).toBe("exact");
    expect(findGoverningProjectRouteMatch(policy, `${root}/app/src`)?.matchKind).toBe("nested");
    // The identity of the project stays separate: a subdirectory is not the project.
    expect(findProjectRoute(policy, `${root}/app`)).toBe(policy.projectRoutes![`${root}/app`]);
    expect(findProjectRoute(policy, `${root}/app/src`)).toBeUndefined();
    expect(findProjectRouteKey(policy, `${root}/app/src`)).toBeUndefined();
    expect(findProjectRouteMatch(policy, `${root}/app/src`)).toBeUndefined();
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
