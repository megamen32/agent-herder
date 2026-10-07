import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAUNCH_POLICY,
  updateAllowedHarness,
  updatePreferredHarness,
} from "../src/web-ui/launch-policy-settings.js";

const component = readFileSync(new URL("../src/web-ui/launch-policy-settings.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

describe("new session launch policy settings", () => {
  it("starts with the requested explicit draft without changing the persisted policy", () => {
    expect(DEFAULT_LAUNCH_POLICY).toEqual({
      version: 1,
      allowedHarnesses: ["codex", "zcode"],
      preferredHarness: "codex",
      models: {
        codex: "gpt-5.6-sol",
        zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      },
    });
  });

  it("keeps an empty allowlist disabled and remembers the preferred runtime", () => {
    const noCodex = updateAllowedHarness(DEFAULT_LAUNCH_POLICY, "codex", false);
    expect(noCodex).toMatchObject({ allowedHarnesses: ["zcode"], preferredHarness: "zcode" });
    const disabled = updateAllowedHarness(noCodex, "zcode", false);
    expect(disabled.allowedHarnesses).toEqual([]);
    expect(disabled.preferredHarness).toBe("zcode");
  });

  it("does not switch a preferred runtime to one that is not allowed", () => {
    const switched = updatePreferredHarness(DEFAULT_LAUNCH_POLICY, "zcode");
    expect(switched.preferredHarness).toBe("zcode");
    expect(switched.allowedHarnesses).toEqual(DEFAULT_LAUNCH_POLICY.allowedHarnesses);
    expect(switched.models).toEqual(DEFAULT_LAUNCH_POLICY.models);
    expect(updatePreferredHarness(switched, "opencode")).toBe(switched);
  });

  it("loads and saves only through the launch-policy API with an explicit save action", () => {
    expect(component).toContain('requestJson<unknown>("/api/automation/launch-policy")');
    expect(component).toContain('requestJson<unknown>("/api/automation/launch-policy", {');
    expect(component).toContain('method: "PUT"');
    expect(component).toContain("body: JSON.stringify(policy)");
    expect(component).toContain('requestJson<{ adapters?: Array<{ id: string; name: string; active: boolean }> }>("/api/adapters")');
    expect(component).toContain(".filter((item) => item.active)");
    expect(component).toContain("/api/models?harness=");
    expect(component).toContain("Настройки запуска ещё не сохранены");
    expect(component).toContain("До сохранения автоматический запуск новых сессий запрещён.");
    expect(component).toContain("Автоматический запуск новых сессий отключён.");
    expect(component).toContain('disabled={!valid || saving || loading || Boolean(loadError)}');
    expect(component).not.toContain("/api/sessions");
  });

  it("exposes launch policy as its own desktop and mobile settings entry", () => {
    expect(main).toContain('"autocontinue" | "autopilot" | "launch-policy"');
    expect(main).toContain('aria-label="Новая сессия"');
    expect(main).toContain('>Настройки запуска новых сессий</button>');
    expect(main).toContain('setAutomationSettings("launch-policy")');
    expect(main).toContain("<LaunchPolicySettings />");
  });
});
