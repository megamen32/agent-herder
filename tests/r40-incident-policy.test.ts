import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationLaunchPolicyStore, validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { healthModelForHarness, INCIDENT_EXECUTION, normalizeIncidentExecution } from "../src/health-remediation.js";

const incidentExecution = { ...INCIDENT_EXECUTION };
const general = { version: 1, allowedHarnesses: ["codex"], preferredHarness: "codex", models: { codex: "gpt-6.1-sol" } };

describe("Notice Place incident subscription policy", () => {
  it("keeps the incident route separate from ordinary launch defaults", () => {
    expect(validateAutomationLaunchPolicy({ ...general, incidentExecution })).toEqual({ ...general, incidentExecution });
    expect(healthModelForHarness("opencode", incidentExecution)).toBe("minimax-coding-plan/MiniMax-M3.1-Flash");
  });

  it("refuses OmniRoute, provider substitutions and fallback models", () => {
    for (const provider of ["omniroute", "auto", "openai-codex", "minimax"]) {
      expect(() => normalizeIncidentExecution({ ...incidentExecution, provider })).toThrow(/provider/);
    }
    for (const model of ["minimax-combo-m3.1", "omniroute/minimax-combo-m3.1", "omniroute/minimax-coding-plan/MiniMax-M3.1-Flash", "minimax-coding-plan/MiniMax-M3.1-Flash", "zai/GLM-4.6", "x".repeat(257), "bad\nmodel"]) {
      expect(() => normalizeIncidentExecution({ ...incidentExecution, model })).toThrow(/model/);
    }
  });

  it("persists the exact direct subscription choice across a store restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "incident-policy-"));
    try {
      const path = join(root, "policy.json");
      await new AutomationLaunchPolicyStore(path).replace({ ...general, incidentExecution });
      expect(await new AutomationLaunchPolicyStore(path).load()).toEqual({ kind: "valid", policy: { ...general, incidentExecution } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
