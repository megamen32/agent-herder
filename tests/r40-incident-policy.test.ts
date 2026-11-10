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
    expect(healthModelForHarness("opencode", incidentExecution)).toBe("omniroute/cx/gpt-6-luna");
  });

  it("retains direct MiniMax compatibility and rejects invalid Luna profile substitutions", () => {
    expect(normalizeIncidentExecution({runtime:"opencode",provider:"minimax-coding-plan",model:"MiniMax-M3.1-Flash",reasoning:"default",topic:"health"}).model).toBe("MiniMax-M3.1-Flash");
    for (const provider of ["bad provider", "x".repeat(257)]) {
      expect(() => normalizeIncidentExecution({ ...incidentExecution, provider })).toThrow(/provider/);
    }
    for (const model of ["x".repeat(257), "bad model", "bad\nmodel"]) {
      expect(() => normalizeIncidentExecution({ ...incidentExecution, model })).toThrow(/model/);
    }
    expect(normalizeIncidentExecution({ ...incidentExecution, model: "omniroute/cx/gpt-6-luna/extra" }).model).toBe("omniroute/cx/gpt-6-luna/extra");
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
