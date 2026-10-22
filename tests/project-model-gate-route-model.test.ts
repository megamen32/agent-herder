import { describe, expect, it } from "vitest";

import { assertModelAllowedForProjectRoute } from "../src/project-model-gate.js";
import { MODEL_NOT_PERMITTED_CODE, ModelNotPermittedError, type ProjectModelPolicy } from "../src/project-model-policy.js";

/** The root of the configured route. */
const ROUTE_ROOT = "/workspace/project";
/** A directory inside the root of the route. */
const ROUTE_SUBDIR = "/workspace/project/sub";

/** A policy whose route permits one model and forbids another. */
function policy(): ProjectModelPolicy {
  return {
    models: { opencode: "omniroute/minimax-combo-m3.1" },
    projectRoutes: {
      [ROUTE_ROOT]: {
        aliases: ["app-card"],
        allowedModels: ["omniroute/minimax-combo-m3.1"],
        deniedModels: ["minimax-coding-plan/MiniMax-M3.1-Flash"],
      },
    },
  };
}

describe("the model of the request against the route of the project", () => {
  it("refuses a model the lists of the route do not permit", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), ROUTE_ROOT, "omniroute/glm-5.3-flash"))
      .toThrow(ModelNotPermittedError);
    try {
      assertModelAllowedForProjectRoute(policy(), ROUTE_ROOT, "omniroute/glm-5.3-flash");
      expect.unreachable("the forbidden model must be refused");
    } catch (error) {
      expect((error as ModelNotPermittedError).code).toBe(MODEL_NOT_PERMITTED_CODE);
    }
  });

  it("refuses a denied model even when the list allows it", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), ROUTE_ROOT, "minimax-coding-plan/MiniMax-M3.1-Flash"))
      .toThrow(ModelNotPermittedError);
  });

  it("permits the model the route lists as allowed", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), ROUTE_ROOT, "omniroute/minimax-combo-m3.1")).not.toThrow();
  });

  it("judges a project of the route by the same lists, however it is named", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), "app-card", "omniroute/glm-5.3-flash"))
      .toThrow(ModelNotPermittedError);
    expect(() => assertModelAllowedForProjectRoute(policy(), ROUTE_SUBDIR, "omniroute/glm-5.3-flash"))
      .toThrow(ModelNotPermittedError);
  });

  it("does not check a project without a route", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), "/workspace/other", "omniroute/glm-5.3-flash")).not.toThrow();
    expect(() => assertModelAllowedForProjectRoute(undefined, ROUTE_ROOT, "omniroute/glm-5.3-flash")).not.toThrow();
  });

  it("does not check a request without a model", () => {
    expect(() => assertModelAllowedForProjectRoute(policy(), ROUTE_ROOT, undefined)).not.toThrow();
  });
});
