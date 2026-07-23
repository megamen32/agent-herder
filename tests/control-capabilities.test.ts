import { describe, expect, it } from "vitest";
import { getHarnessCapabilities, type HarnessAdapter } from "../src/types/index.js";

describe("harness control capabilities", () => {
  it("reports native controls without conflating stop with cancel or terminate", () => {
    const adapter = {
      type: "codex",
      name: "Codex app-server",
      controlCapabilities: {
        cancelTurn: true,
        detach: true,
        resume: true,
        terminate: false,
        recover: true,
        fork: true,
        modelSwitch: true,
        subagents: true,
        events: true,
      },
    } as HarnessAdapter;

    expect(getHarnessCapabilities(adapter)).toEqual({
      cancelTurn: true,
      detach: true,
      resume: true,
      terminate: false,
      recover: true,
      fork: true,
      modelSwitch: true,
      subagents: true,
      events: true,
    });
  });
});
