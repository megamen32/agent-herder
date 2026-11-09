import { describe, expect, it } from "vitest";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";

describe("explicit Vibe owner selection", () => {
  it("selects only the configured Vibe browser session", () => {
    const selected: unknown[] = [];
    makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt",
      AHAP_BROWSER_TRANSPORT: "vibe",
      AHAP_BROWSER_ACCOUNT_SCOPE: "a".repeat(64),
      AHAP_BROWSER_VIBE_TARGET: "mcp:shell:mac-mini-2012.lan:VibeMacMiniLocal",
      AHAP_BROWSER_VIBE_SESSION_ID: "session_1",
    }, {
      macMini() { throw new Error("unexpected legacy gateway"); },
      directCdp() { throw new Error("unexpected direct CDP"); },
      vibe(config: unknown) {
        selected.push(config);
        return { async call() { return ""; } };
      },
    });
    expect(selected).toEqual([{
      target: "mcp:shell:mac-mini-2012.lan:VibeMacMiniLocal",
      sessionId: "session_1",
    }]);
  });

  it("refuses unpinned browser sessions before constructing a transport", () => {
    expect(() => makeConfiguredAdapter({
      AHAP_HARNESS: "zai",
      AHAP_BROWSER_TRANSPORT: "vibe",
      AHAP_BROWSER_ACCOUNT_SCOPE: "a".repeat(64),
      AHAP_BROWSER_VIBE_TARGET: "mcp:shell:roomhacker-server-100:VibeServer100Local",
    })).toThrow("Exact Vibe target and browser session are required");
  });

  it("awaits shutdown of its SDK child before reporting adapter cleanup", async () => {
    let closed = false;
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt", AHAP_BROWSER_TRANSPORT: "vibe", AHAP_BROWSER_ACCOUNT_SCOPE: "a".repeat(64),
      AHAP_BROWSER_VIBE_TARGET: "mcp:shell:mac-mini-2012.lan:VibeMacMiniLocal", AHAP_BROWSER_VIBE_SESSION_ID: "session_1",
    }, {
      macMini() { throw new Error("unexpected legacy gateway"); }, directCdp() { throw new Error("unexpected direct CDP"); },
      vibe() { return { async call() { return ""; }, async close() { await new Promise(resolve => setTimeout(resolve, 5)); closed = true; } }; },
    });
    await adapter.close?.();
    expect(closed).toBe(true);
  });
});
