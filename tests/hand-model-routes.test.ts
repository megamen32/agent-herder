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

describe("hand-picked model routes", () => {
  it("allows the MiniMax subscription route as a fallback and keeps the combo first", () => {
    expect(NOTICEPLACE_HEALTH_MODELS.known[0]).toBe("omniroute/minimax-combo-m3.1");
    expect(INCIDENT_EXECUTION.model).toBe("omniroute/minimax-combo-m3.1");
    for (const route of paidRoutes) {
      const approved = route.startsWith("omniroute/") || route.startsWith("minimax-coding-plan/");
      expect(isApprovedHealthRoute(route)).toBe(approved);
      expect(isNoticeplaceHealthModel(route)).toBe(approved);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(approved);
      const refusal = validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" });
      if (approved) expect(refusal).toBeUndefined();
      else expect(typeof refusal).toBe("string");
      if (approved) {
        expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: route })).not.toThrow();
      } else {
        expect(() => normalizeIncidentExecution({ ...INCIDENT_EXECUTION, model: route })).toThrow();
      }
    }
  });

  it("approves every other route of the OmniRoute gateway", () => {
    for (const route of ["omniroute/minimax-combo-m3.1", "omniroute/glm-5.3-flash-minimax-m3.1", "omniroute/provider/model"]) {
      expect(isApprovedHealthRoute(route)).toBe(true);
      expect(isNoticeplaceHealthModel(route)).toBe(true);
      expect(NOTICEPLACE_HEALTH_MODELS.includes(route)).toBe(true);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeUndefined();
    }
  });

  it("refuses another provider and a padded route", () => {
    for (const route of ["zai/GLM-4.6", "minimax/MiniMax-M3.1-Flash", "omniroute/minimax-combo-m3.1 ", " account:zai/GLM-5.3-Flash"]) {
      expect(isApprovedHealthRoute(route)).toBe(false);
      expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: route, operationId: "op" })).toBeTruthy();
    }
  });

  it("keeps the default route verifiable and the provider of the incident route", () => {
    expect(INCIDENT_EXECUTION.provider).toBe("omniroute");
    expect(INCIDENT_EXECUTION.model).toBe("omniroute/minimax-combo-m3.1");
    expect(healthModelForHarness("opencode", INCIDENT_EXECUTION)).toBe("omniroute/minimax-combo-m3.1");
    expect([...INCIDENT_MODELS]).toContain("omniroute/minimax-combo-m3.1");
    expect([...INCIDENT_MODELS]).toContain("omniroute/glm-5.3-flash-minimax-m3.1");
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
