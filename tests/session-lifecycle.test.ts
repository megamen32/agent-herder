import { describe, expect, it } from "vitest";
import { lifecycleStateFor, markLifecycleEvent } from "../src/session-lifecycle.js";

describe("session lifecycle registry", () => {
  it("tracks start -> turn boundaries -> end", () => {
    markLifecycleEvent("zcode", "sess-lc", "start");
    expect(lifecycleStateFor("zcode", "sess-lc")).toBe("running");
    markLifecycleEvent("zcode", "sess-lc", "turn-end");
    expect(lifecycleStateFor("zcode", "sess-lc")).toBe("idle");
    markLifecycleEvent("zcode", "sess-lc", "turn-start");
    expect(lifecycleStateFor("zcode", "sess-lc")).toBe("running");
    markLifecycleEvent("zcode", "sess-lc", "end");
    expect(lifecycleStateFor("zcode", "sess-lc")).toBe("ended");
  });

  it("ignores empty session ids", () => {
    markLifecycleEvent("zcode", "   ", "start");
    expect(lifecycleStateFor("zcode", "")).toBeUndefined();
  });
});
