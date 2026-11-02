import { describe, it, expect } from "vitest";
import { harnessRuntimeCapabilities, getHarnessRuntimeCapabilities } from "../src/types/harness-runtime.js";
import type { HarnessType } from "../src/types/common.js";
import { AUTOPILOT_HARNESSES } from "../src/autopilot/policy.js";

// Each adapter file self-registers its runtime capabilities at module load.
// Importing them populates the accumulator so the lookups below see every
// harness without a central registry file.
import "../src/adapters/codex-app-server.js";
import "../src/adapters/opencode.js";
import "../src/adapters/claude.js";
import "../src/adapters/qoder.js";
import "../src/adapters/hermes/adapter.js";
import "../src/adapters/zcode.js";
import "../src/adapters/fast-agent.js";
import "../src/adapters/minimax-code.js";
import "../src/adapters/browser-chat.js";

const ALL_HARNESSES: readonly HarnessType[] = [
  "codex", "opencode", "claude", "qoder", "hermes", "zcode",
  "fast-agent", "chatgpt", "zai", "browser-chat", "minimax-code",
];

describe("self-declaring harness runtime capabilities", () => {
  it("every HarnessType is registered by its adapter file", () => {
    for (const harness of ALL_HARNESSES) {
      expect(() => harnessRuntimeCapabilities(harness)).not.toThrow();
    }
  });

  it("throws on an unknown harness type instead of returning a default", () => {
    expect(() => harnessRuntimeCapabilities("definitely-not-a-harness")).toThrow(/unknown harness type/);
  });

  it("marks exactly the AUTOPILOT_HARNESSES set as autopilot-eligible", () => {
    const eligible = ALL_HARNESSES.filter(h => harnessRuntimeCapabilities(h).autopilotEligible).sort();
    expect(eligible).toEqual([...AUTOPILOT_HARNESSES].sort());
  });

  it("restricts browserChat to chatgpt, zai and the browser-chat alias", () => {
    const browserChats = ALL_HARNESSES.filter(h => harnessRuntimeCapabilities(h).browserChat).sort();
    expect(browserChats).toEqual(["browser-chat", "chatgpt", "zai"]);
  });

  it("keeps the human-stop observer on codex, zcode and opencode only", () => {
    const observed = ALL_HARNESSES.filter(h => harnessRuntimeCapabilities(h).humanStopObserver).sort();
    expect(observed).toEqual(["codex", "opencode", "zcode"]);
  });

  it("reserves localInject for hermes", () => {
    const localInject = ALL_HARNESSES.filter(h => harnessRuntimeCapabilities(h).localInject);
    expect(localInject).toEqual(["hermes"]);
  });

  it("uses deliverInRunner only for opencode (inbox transport with agent-resume fallback)", () => {
    const delivered = ALL_HARNESSES.filter(h => harnessRuntimeCapabilities(h).autopilotDispatch === "deliverInRunner");
    expect(delivered).toEqual(["opencode"]);
  });

  it("treats browser chats as observer-driven, not hook-driven", () => {
    for (const h of ["chatgpt", "zai", "browser-chat"] as const) {
      expect(harnessRuntimeCapabilities(h).hookDrivenStop).toBe(false);
    }
    for (const h of ["codex", "opencode", "claude", "hermes", "zcode", "qoder"] as const) {
      expect(harnessRuntimeCapabilities(h).hookDrivenStop).toBe(true);
    }
  });

  it("getHarnessRuntimeCapabilities prefers the adapter instance field", () => {
    const fake = { type: "codex", runtimeCapabilities: { ...harnessRuntimeCapabilities("codex"), localInject: true } };
    expect(getHarnessRuntimeCapabilities(fake).localInject).toBe(true);
  });

  it("getHarnessRuntimeCapabilities falls back to the registry when the adapter has not declared caps", () => {
    const fake = { type: "claude" };
    expect(getHarnessRuntimeCapabilities(fake)).toEqual(harnessRuntimeCapabilities("claude"));
  });
});
