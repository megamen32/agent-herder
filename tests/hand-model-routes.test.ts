import { describe, expect, it } from "vitest";
import {
  INCIDENT_EXECUTION,
  healthModelForHarness,
  isApprovedHealthRoute,
  normalizeHealthExecution,
  normalizeIncidentExecution,
} from "../src/health-remediation.js";
import { NOTICEPLACE_HEALTH_MODELS, isNoticeplaceHealthModel } from "../src/automation/noticeplace-health-policy.js";
import { INCIDENT_MODELS, validateNoticeplaceHealthLaunch } from "../src/automation/noticeplace-health-launch.js";

const paidRoutes = [
  "omniroute/cx/gpt-6-luna",
  "omniroute/glm-5.3-flash-minimax-m3.1",
  "omniroute/minimax-combo-m3.1",
  "minimax-coding-plan/MiniMax-M3.1-Flash",
  "omniroute/minimax-coding-plan/MiniMax-M3.1-Flash",
  "minimax/MiniMax-M3.1-Flash",
  "omniroute/minimax/MiniMax-M3.1-Flash",
];

describe("Notice Place incident model route", () => {
  it("allows the explicitly pinned subscription route among approved incident models", () => {
    expect(NOTICEPLACE_HEALTH_MODELS.known).toEqual([...INCIDENT_MODELS]);
    expect(INCIDENT_MODELS.has("omniroute/cx/gpt-6-luna")).toBe(true);
    for (const route of paidRoutes) {
      const approved = INCIDENT_MODELS.has(route);
      expect(isNoticeplaceHealthModel(route)).toBe(approved);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(approved);
      const refusal = validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" });
      expect(refusal).toBeUndefined();
    }
  });

  it("lets Herder own the model choice and still rejects malformed route syntax", () => {
    for (const route of ["bad route", "omniroute/cx/gpt-6-luna/extra "]) {
      expect(isNoticeplaceHealthModel(route)).toBe(false);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(false);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeTruthy();
    }
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", operationId: "op" })).toBeUndefined();
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: "omniroute/provider/model", operationId: "op" })).toBeUndefined();
  });

  it("refuses another provider and a padded route", () => {
    for (const route of ["omniroute/minimax-combo-m3.1 ", " account:zai/GLM-5.3-Flash"]) {
      expect(isApprovedHealthRoute(route)).toBe(false);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeTruthy();
    }
  });

  it("uses the Luna incident default while preserving strict route shape and other forbidden cases", () => {
    expect(INCIDENT_EXECUTION.provider).toBe("omniroute");
    expect(INCIDENT_EXECUTION.model).toBe("omniroute/cx/gpt-6-luna");
    expect(healthModelForHarness("opencode", INCIDENT_EXECUTION)).toBe("omniroute/cx/gpt-6-luna");
    expect([...INCIDENT_MODELS]).toContain("omniroute/cx/gpt-6-luna");
  });

  it("refuses another harness and a provider substitution of the incident route", () => {
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, runtime: "zcode" })).toThrow();
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, provider: "bad provider" })).toThrow();
    expect(normalizeIncidentExecution({ ...INCIDENT_EXECUTION, provider: "minimax", model: "minimax/MiniMax-M3.1-Flash" }).provider).toBe("minimax");
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: "x".repeat(257) })).toThrow();
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: "bad\nmodel" })).toThrow();
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: "  " })).toThrow();
  });

  it("keeps the approved model of the other runtimes pinned", () => {
    expect(normalizeHealthExecution({
      runtime: "zcode",
      provider: "account:zai-individual-coding-plan",
      model: "GLM-5.3-Flash",
      reasoning: "high",
      topic: "health",
    }).model).toBe("GLM-5.3-Flash");
    expect(() => normalizeHealthExecution({
      runtime: "zcode",
      provider: "account:zai-individual-coding-plan",
      model: "gpt-4o",
      reasoning: "high",
      topic: "health",
    })).toThrow(/model/);
  });
});
