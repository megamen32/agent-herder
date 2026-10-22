import { describe, expect, it } from "vitest";

import {
  resolveProjectLaunch,
  validateAutomationLaunchPolicy,
  type AutomationLaunchPolicy,
} from "../src/automation-launch-policy.js";
import {
  ModelNotPermittedError,
  assertModelPermittedForProject,
  conflictingModelEntries,
  modelMatchesEntry,
  modelPermittedForProject,
  modelPermittedForRoute,
} from "../src/project-model-policy.js";
import {
  assertModelAllowedForDirectoryWithPolicy,
  assertModelAllowedForProject,
  routeModelViolation,
} from "../src/project-model-gate.js";

const basePolicy: AutomationLaunchPolicy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode", "opencode"],
  preferredHarness: "codex",
  models: {
    codex: "gpt-6.1-sol",
    zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
    opencode: "omniroute/minimax-combo-m3.1",
  },
};

function withRoutes(routes: AutomationLaunchPolicy["projectRoutes"]): AutomationLaunchPolicy {
  return { ...basePolicy, projectRoutes: routes };
}

describe("model list validation", () => {
  it("keeps the model lists of a project route in the normalized document", () => {
    const policy = validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: {
        "/workspace/app": {
          harnesses: ["opencode"],
          allowedModels: ["omniroute/minimax-combo-m3.1"],
          deniedModels: ["gpt-6.1-sol"],
        },
      },
    });
    expect(policy.projectRoutes?.["/workspace/app"]?.allowedModels).toEqual(["omniroute/minimax-combo-m3.1"]);
    expect(policy.projectRoutes?.["/workspace/app"]?.deniedModels).toEqual(["gpt-6.1-sol"]);
  });

  it("rejects an empty entry", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: { "/workspace/app": { harnesses: ["opencode"], deniedModels: ["  "] } },
    })).toThrow(/nonempty model IDs/u);
  });

  it("rejects a repeated entry regardless of case", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: { "/workspace/app": { harnesses: ["opencode"], allowedModels: ["Model-A", "model-a"] } },
    })).toThrow(/repeats model/u);
  });

  it("rejects an entry longer than 256 characters", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: { "/workspace/app": { harnesses: ["opencode"], deniedModels: ["m".repeat(257)] } },
    })).toThrow(/at most 256 characters/u);
  });

  it("rejects more than 64 entries in one list", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: {
        "/workspace/app": { harnesses: ["opencode"], allowedModels: Array.from({ length: 65 }, (_, index) => `model-${index}`) },
      },
    })).toThrow(/not hold more than 64 models/u);
  });

  it("rejects a model that is allowed and denied at the same time", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: {
        "/workspace/app": { harnesses: ["opencode"], allowedModels: ["Model-A"], deniedModels: ["model-a"] },
      },
    })).toThrow(/as allowed and as denied at the same time/u);
  });

  it("rejects control characters in an entry", () => {
    expect(() => validateAutomationLaunchPolicy({
      ...basePolicy,
      projectRoutes: { "/workspace/app": { harnesses: ["opencode"], deniedModels: ["modela"] } },
    })).toThrow(/control characters/u);
  });
});

describe("model matching", () => {
  it("matches an exact id regardless of case and whitespace", () => {
    expect(modelMatchesEntry("omniroute/minimax-combo-m3.1", " OmniRoute/Minimax-Combo-M3.1 ")).toBe(true);
    expect(modelMatchesEntry("omniroute/minimax-combo-m3.1", "omniroute/minimax-combo-m3.2")).toBe(false);
  });

  it("matches a prefix rule that ends with a star", () => {
    expect(modelMatchesEntry("omniroute/minimax-combo-m3.1", "omniroute/minimax-*")).toBe(true);
    expect(modelMatchesEntry("gpt-6.1-sol", "omniroute/minimax-*")).toBe(false);
  });
});

describe("the per-project model gate", () => {
  it("lets a project without a route keep the global policy unchanged", () => {
    const policy = withRoutes({});
    expect(modelPermittedForProject(policy, "/workspace/app", "anything")).toBe(true);
  });

  it("denies a denied model even when it is also allowed", () => {
    const policy = withRoutes({
      "/workspace/app": { harnesses: ["opencode"], allowedModels: ["model-a"], deniedModels: ["model-a"] },
    });
    expect(modelPermittedForRoute(policy.projectRoutes!["/workspace/app"]!, "model-a")).toBe(false);
  });

  it("denies a model that is not in the non-empty allowed list", () => {
    const policy = withRoutes({
      "/workspace/app": { harnesses: ["opencode"], allowedModels: ["model-a"] },
    });
    expect(modelPermittedForProject(policy, "/workspace/app", "model-b")).toBe(false);
    expect(modelPermittedForProject(policy, "/workspace/app", "model-a")).toBe(true);
  });

  it("allows every model when the allowed list is empty", () => {
    const policy = withRoutes({ "/workspace/app": { harnesses: ["opencode"], allowedModels: [] } });
    expect(modelPermittedForProject(policy, "/workspace/app", "model-b")).toBe(true);
  });

  it("finds the route of a project by its alias", () => {
    const policy = withRoutes({
      "/workspace/app": { harnesses: ["opencode"], aliases: ["tg-commentator"], deniedModels: ["model-a"] },
    });
    expect(modelPermittedForProject(policy, "tg-commentator", "model-a")).toBe(false);
    expect(modelPermittedForProject(policy, "/workspace/app", "model-a")).toBe(false);
  });

  it("throws an error that names the project, the model and the lists", () => {
    const policy = withRoutes({
      "/workspace/app": { harnesses: ["opencode"], allowedModels: ["model-a"], deniedModels: ["model-b"] },
    });
    expect(() => assertModelPermittedForProject(policy, "/workspace/app", "model-b")).toThrow(ModelNotPermittedError);
    try {
      assertModelPermittedForProject(policy, "/workspace/app", "model-b");
      throw new Error("expected the gate to refuse the model");
    } catch (error) {
      const failure = error as ModelNotPermittedError;
      expect(failure.code).toBe("model_not_permitted_for_project");
      expect(failure.message).toContain("/workspace/app");
      expect(failure.message).toContain("model-b");
      expect(failure.message).toContain("model-a");
    }
  });

  it("reports the entries that are allowed and denied at the same time", () => {
    expect(conflictingModelEntries(["model-a", "model-b"], ["model-b"])).toEqual(["model-b"]);
    expect(conflictingModelEntries(["model-a"], ["model-c"])).toEqual([]);
  });
});

describe("launch resolution with a project model policy", () => {
  it("skips a harness whose model the project denies and uses the next one", () => {
    const policy = withRoutes({
      "/workspace/app": {
        harnesses: ["codex", "opencode"],
        models: { codex: "gpt-6.1-sol", opencode: "omniroute/minimax-combo-m3.1" },
        deniedModels: ["gpt-6.1-sol"],
      },
    });
    const resolution = resolveProjectLaunch(policy, { project: "/workspace/app" });
    expect(resolution).toMatchObject({ kind: "launch", harness: "opencode", model: "omniroute/minimax-combo-m3.1" });
  });

  it("skips a harness whose model is outside the non-empty allowed list", () => {
    const policy = withRoutes({
      "/workspace/app": {
        harnesses: ["codex", "opencode"],
        models: { codex: "gpt-6.1-sol", opencode: "omniroute/minimax-combo-m3.1" },
        allowedModels: ["omniroute/minimax-combo-m3.1"],
      },
    });
    const resolution = resolveProjectLaunch(policy, { project: "/workspace/app" });
    expect(resolution).toMatchObject({ kind: "launch", harness: "opencode" });
  });

  it("refuses explicitly when no harness of the route has a permitted model", () => {
    const policy = withRoutes({
      "/workspace/app": {
        harnesses: ["codex", "opencode"],
        models: { codex: "gpt-6.1-sol", opencode: "omniroute/minimax-combo-m3.1" },
        deniedModels: ["gpt-6.1-sol", "omniroute/minimax-combo-m3.1"],
      },
    });
    const resolution = resolveProjectLaunch(policy, { project: "/workspace/app" });
    expect(resolution).toEqual({ kind: "exhausted", reason: "model_not_permitted" });
  });

  it("leaves a project without a route unchanged", () => {
    const resolution = resolveProjectLaunch(withRoutes({}), { project: "/workspace/app" });
    expect(resolution).toEqual({ kind: "unconfigured" });
  });
});

describe("the model gate of the explicit model tools", () => {
  const policy = withRoutes({
    "/workspace/app": { harnesses: ["opencode"], aliases: ["app-card"], deniedModels: ["model-b"] },
  });

  it("passes a permitted model", async () => {
    await expect(assertModelAllowedForProject(async () => policy, "/workspace/app", "model-a")).resolves.toBeUndefined();
  });

  it("refuses a denied model", async () => {
    await expect(assertModelAllowedForProject(async () => policy, "/workspace/app", "model-b"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
  });

  it("refuses a denied model of an aliased project", async () => {
    await expect(assertModelAllowedForProject(async () => policy, "app-card", "model-b"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
  });

  it("refuses a denied model for a session in a subdirectory of the project", async () => {
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, "/workspace/app/src", "model-b"))
      .rejects.toThrow(/model_not_permitted_for_project/u);
    await expect(assertModelAllowedForDirectoryWithPolicy(async () => policy, "/workspace/app/src", "model-a"))
      .resolves.toBeUndefined();
  });

  it("allows every model when the policy has no route for the project", async () => {
    await expect(assertModelAllowedForProject(async () => withRoutes({}), "/workspace/other", "model-b"))
      .resolves.toBeUndefined();
  });
});

describe("the violation shown to the operator", () => {
  it("reports a denied effective model", () => {
    expect(routeModelViolation({ deniedModels: ["model-a"] }, "model-a")).toBe("denied");
  });

  it("reports an effective model outside the allowed list", () => {
    expect(routeModelViolation({ allowedModels: ["model-a"] }, "model-b")).toBe("not_allowed");
  });

  it("reports no violation when the model is usable", () => {
    expect(routeModelViolation({ allowedModels: ["model-a"] }, "model-a")).toBeUndefined();
    expect(routeModelViolation({}, "model-a")).toBeUndefined();
    expect(routeModelViolation({ allowedModels: ["model-a"] }, undefined)).toBeUndefined();
  });
});
