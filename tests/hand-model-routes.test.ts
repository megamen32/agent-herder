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
  "minimax-coding-plan/MiniMax-M3.1-Flash",
  "omniroute/minimax-coding-plan/MiniMax-M3.1-Flash",
  "minimax/MiniMax-M3.1-Flash",
  "omniroute/minimax/MiniMax-M3.1-Flash",
];

describe("Notice Place incident model route", () => {
  it("allows only the direct MiniMax subscription route for incidents", () => {
    expect(NOTICEPLACE_HEALTH_MODELS.known).toEqual(["minimax-coding-plan/MiniMax-M3.1-Flash"]);
    expect(INCIDENT_EXECUTION.model).toBe("MiniMax-M3.1-Flash");
    for (const route of paidRoutes) {
      const approved = route === "minimax-coding-plan/MiniMax-M3.1-Flash";
      expect(isNoticeplaceHealthModel(route)).toBe(approved);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(approved);
      const refusal = validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" });
      if (approved) expect(refusal).toBeUndefined();
      else expect(typeof refusal).toBe("string");
    }
  });

  it("does not reuse the general OmniRoute health route gate for incidents", () => {
    for (const route of ["omniroute/minimax-combo-m3.1", "omniroute/glm-5.3-flash-minimax-m3.1", "omniroute/provider/model"]) {
      expect(isApprovedHealthRoute(route)).toBe(true);
      expect(isNoticeplaceHealthModel(route)).toBe(false);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(false);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeTruthy();
    }
  });

  it("refuses another provider and a padded route", () => {
    for (const route of ["zai/GLM-4.6", "minimax/MiniMax-M3.1-Flash", "omniroute/minimax-combo-m3.1 ", " account:zai/GLM-5.3-Flash"]) {
      expect(isApprovedHealthRoute(route)).toBe(false);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeTruthy();
    }
  });

  it("keeps the default route verifiable and the provider of the incident route", () => {
    expect(INCIDENT_EXECUTION.provider).toBe("minimax-coding-plan");
    expect(INCIDENT_EXECUTION.model).toBe("MiniMax-M3.1-Flash");
    expect(healthModelForHarness("opencode", INCIDENT_EXECUTION)).toBe("minimax-coding-plan/MiniMax-M3.1-Flash");
    expect([...INCIDENT_MODELS]).toEqual(["minimax-coding-plan/MiniMax-M3.1-Flash"]);
  });

  it("refuses another harness and a provider substitution of the incident route", () => {
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, runtime: "zcode" })).toThrow();
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, provider: "minimax" })).toThrow();
    expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: "zai/GLM-4.6" })).toThrow();
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
