import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessAutomationSettings, withAutopilotHarness } from "../src/web-ui/harness-automation-settings.js";
import {AUTOCONTINUE_HARNESS_IDS,loadAutocontinueHarnesses} from '../src/web-ui/autocontinue-harnesses.js';

describe("separate mechanism pages with independent harness settings", () => {
  it('renders all existing recovery settings and distinguishes a failed read from unsupported capability',async()=>{
    const result=await loadAutocontinueHarnesses(async(path)=>{
      const harness=path.split('/').at(-1)!;
      if(harness==='qoder')throw new Error('failed');
      return {harness,enabled:harness==='hermes',source:'global'} as any;
    });
    const html=renderToStaticMarkup(createElement(HarnessAutomationSettings,{
      mode:'autocontinue',available:new Set(AUTOCONTINUE_HARNESS_IDS),loaded:new Set(Object.keys(result.settings)),
      failed:new Set(result.failed),enabled:new Set(['hermes']),onToggle:()=>{},
    }));
    expect(html).not.toContain('Пока не поддерживается');
    expect(html).toContain('Не удалось загрузить');
    expect(html).toMatch(/role="switch" aria-label="Автопродолжение · Hermes" aria-checked="true"[^>]*>/);
    expect(html).toMatch(/role="switch" aria-label="Автопродолжение · Qoder"[^>]*disabled=""/);
    for(const name of ['OpenCode','Claude Code','Fast Agent','ChatGPT'])expect(html).toMatch(new RegExp(`role="switch" aria-label="Автопродолжение · ${name}"[^>]*(?<!disabled="")>`));
  });
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
