import { describe, it, expect } from "vitest";
import { HARNESS_RUNTIME_CAPABILITIES, harnessRuntimeCapabilities } from "../src/types/harness-runtime.js";
import type { HarnessType } from "../src/types/common.js";
import { AUTOPILOT_HARNESSES } from "../src/autopilot/policy.js";

const ALL_HARNESSES: readonly HarnessType[] = [
  "codex", "opencode", "claude", "qoder", "hermes", "zcode",
  "fast-agent", "chatgpt", "zai", "browser-chat", "minimax-code",
];

describe("harness runtime capabilities registry", () => {
  it("covers every HarnessType exactly once", () => {
    for (const harness of ALL_HARNESSES) {
      expect(HARNESS_RUNTIME_CAPABILITIES[harness]).toBeDefined();
    }
    expect(Object.keys(HARNESS_RUNTIME_CAPABILITIES).sort()).toEqual([...ALL_HARNESSES].sort());
  });

  it("throws on an unknown harness type instead of returning a default", () => {
    expect(() => harnessRuntimeCapabilities("definitely-not-a-harness")).toThrow(/unknown harness type/);
  });

  it("marks exactly the AUTOPILOT_HARNESSES set as autopilot-eligible", () => {
    const eligible = ALL_HARNESSES.filter(h => HARNESS_RUNTIME_CAPABILITIES[h].autopilotEligible).sort();
    expect(eligible).toEqual([...AUTOPILOT_HARNESSES].sort());
  });

  it("restricts browserChat to chatgpt, zai and the browser-chat alias", () => {
    const browserChats = ALL_HARNESSES.filter(h => HARNESS_RUNTIME_CAPABILITIES[h].browserChat).sort();
    expect(browserChats).toEqual(["browser-chat", "chatgpt", "zai"]);
  });

  it("keeps the human-stop observer on codex, zcode and opencode only", () => {
    const observed = ALL_HARNESSES.filter(h => HARNESS_RUNTIME_CAPABILITIES[h].humanStopObserver).sort();
    expect(observed).toEqual(["codex", "opencode", "zcode"]);
  });

  it("reserves localInject for hermes", () => {
    const localInject = ALL_HARNESSES.filter(h => HARNESS_RUNTIME_CAPABILITIES[h].localInject);
    expect(localInject).toEqual(["hermes"]);
  });

  it("uses deliverInRunner only for opencode (inbox transport with agent-resume fallback)", () => {
    const delivered = ALL_HARNESSES.filter(h => HARNESS_RUNTIME_CAPABILITIES[h].autopilotDispatch === "deliverInRunner");
    expect(delivered).toEqual(["opencode"]);
  });

  it("treats browser chats as observer-driven, not hook-driven", () => {
    for (const h of ["chatgpt", "zai", "browser-chat"] as const) {
      expect(HARNESS_RUNTIME_CAPABILITIES[h].hookDrivenStop).toBe(false);
    }
    for (const h of ["codex", "opencode", "claude", "hermes", "zcode", "qoder"] as const) {
      expect(HARNESS_RUNTIME_CAPABILITIES[h].hookDrivenStop).toBe(true);
    }
  });
});
