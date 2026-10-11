import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessAutomationSettings, withAutopilotHarness } from "../src/web-ui/harness-automation-settings.js";

describe("independent automation settings for each harness", () => {
  it("shows both capabilities for every supported harness without pretending unavailable recovery exists", () => {
    const html = renderToStaticMarkup(createElement(HarnessAutomationSettings, {
      autopilot: { enabled: true, harnesses: ["zcode"] },
      continuation: { codex: { enabled: true }, zcode: { enabled: false } },
      onAutopilotToggle: () => {}, onContinuationToggle: () => {},
      onOpenAutopilot: () => {}, onOpenContinuation: () => {},
    }));
    for (const name of ["Codex", "ZCode", "Claude Code", "OpenCode", "Hermes", "Qoder", "Fast Agent", "ChatGPT"]) {
      expect(html).toContain(`aria-label="Автопилот · ${name}"`);
      expect(html).toContain(`aria-label="Автопродолжение · ${name}"`);
    }
    expect(html).toMatch(/aria-label="Автопродолжение · Codex" aria-checked="true"/);
    expect(html).toMatch(/aria-label="Автопилот · Codex" aria-checked="false"/);
    expect(html).toMatch(/aria-label="Автопродолжение · ZCode" aria-checked="false"/);
    expect(html).toMatch(/aria-label="Автопилот · ZCode" aria-checked="true"/);
    expect(html).toMatch(/aria-label="Автопродолжение · OpenCode" aria-checked="false" disabled=""/);
    expect(html).toMatch(/aria-label="Автопилот · OpenCode" aria-checked="false"/);
  });

  it("changes one harness without changing the master, other harnesses or task policy", () => {
    const policy = { enabled: true, harnesses: ["zcode", "hermes"] as Array<"zcode" | "hermes" | "opencode">, timeout: { mode: "hold" }, card: { includeReason: false } };
    const changed = withAutopilotHarness(policy, "opencode", true);
    expect(changed).toEqual({ ...policy, harnesses: ["zcode", "hermes", "opencode"] });
    expect(withAutopilotHarness(changed, "hermes", false)).toEqual({ ...policy, harnesses: ["zcode", "opencode"] });
    expect(policy.harnesses).toEqual(["zcode", "hermes"]);
    expect(changed.timeout).toBe(policy.timeout);
  });

  it("does not display a configured harness as active while the Autopilot master is off", () => {
    const html = renderToStaticMarkup(createElement(HarnessAutomationSettings, {
      autopilot: { enabled: false, harnesses: ["zcode"] }, continuation: {},
      onAutopilotToggle: () => {}, onContinuationToggle: () => {},
      onOpenAutopilot: () => {}, onOpenContinuation: () => {},
    }));
    expect(html).toContain("Разрешён · общий автопилот выключен");
    expect(html).toContain("Загружаю…");
  });
});
