import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessAutomationSettings, withAutopilotHarness } from "../src/web-ui/harness-automation-settings.js";

describe("separate mechanism pages with independent harness settings", () => {
  it("renders only Autopilot switches on the Autopilot page", () => {
    const html = renderToStaticMarkup(createElement(HarnessAutomationSettings, {
      mode: "autopilot", available: new Set(["codex", "zcode", "claude", "opencode", "hermes"]), enabled: new Set(["zcode"]), onToggle: () => {},
    }));
    for (const name of ["Codex", "ZCode", "Claude Code", "OpenCode", "Hermes", "Qoder", "Fast Agent", "ChatGPT"]) expect(html).toContain(`aria-label="Автопилот · ${name}"`);
    expect(html).not.toContain("Автопродолжение");
    expect(html).toContain('aria-label="Автопилот · ZCode" aria-checked="true"');
  });
  it("renders only recovery switches on the Autocontinue page", () => {
    const html = renderToStaticMarkup(createElement(HarnessAutomationSettings, {
      mode: "autocontinue", available: new Set(["codex", "zcode"]), enabled: new Set(["codex"]), loaded: new Set(["codex", "zcode"]), onToggle: () => {},
    }));
    expect(html).not.toContain("Автопилот");
    expect(html).toContain('aria-label="Автопродолжение · Codex" aria-checked="true"');
    expect(html).toContain('aria-label="Автопродолжение · ZCode" aria-checked="false"');
    expect(html).toMatch(/aria-label="Автопродолжение · OpenCode".*?disabled=""/);
  });
  it("changes a single harness without changing other policy settings", () => {
    const policy = { enabled: true, harnesses: ["zcode", "hermes"] as Array<"zcode" | "hermes" | "opencode">, timeout: { mode: "hold" } };
    expect(withAutopilotHarness(policy, "opencode", true)).toEqual({ ...policy, harnesses: ["zcode", "hermes", "opencode"] });
    expect(withAutopilotHarness(policy, "hermes", false)).toEqual({ ...policy, harnesses: ["zcode"] });
    expect(policy.harnesses).toEqual(["zcode", "hermes"]);
  });
});
