import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessAutomationSettings } from "../src/web-ui/harness-automation-settings.js";

// Verifies the kill-switch behavior: when disabledAll is true, every
// per-harness switch renders disabled and the status text changes.
// No HTTP, no MCP. React SSR only.
// NB: vitest.config.ts only includes tests/**/*.test.ts, so this file uses
// createElement instead of JSX to stay a plain .ts module.

type HarnessProps = Parameters<typeof HarnessAutomationSettings>[0];

function renderWith(props: Partial<HarnessProps> = {}) {
  return renderToStaticMarkup(
    createElement(HarnessAutomationSettings, {
      mode: "autopilot",
      available: new Set(["zai", "chatgpt", "codex"]),
      enabled: new Set(["zai"]),
      onToggle: () => {},
      ...props,
    } as HarnessProps),
  );
}

describe("HarnessAutomationSettings kill switch", () => {
  it("renders active switches when disabledAll is absent", () => {
    const html = renderWith();
    // The Z.ai switch is enabled and not disabled.
    expect(html).toContain("Разрешено");
    expect(html).toContain('aria-checked="true"');
    // No stop-signal hint by default.
    expect(html).not.toContain("Стоп-сигнал");
  });

  it("grays every switch and shows the stop-signal hint when disabledAll is true", () => {
    const html = renderWith({ disabledAll: true });
    expect(html).toContain("Стоп-сигнал: общий переключатель выключен");
    // Every switch-control button is disabled.
    const matches = html.match(/disabled=""/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // 3 harness rows
    // The disabled row class is present.
    expect(html).toContain("harness-setting-row-disabled");
  });

  it("preserves the checked state on the underlying switch even when disabled", () => {
    // The switch is still marked aria-checked, so turning the global back on
    // restores the previous selection without a write.
    const html = renderWith({ disabledAll: true });
    expect(html).toContain('aria-checked="true"');
  });
});
