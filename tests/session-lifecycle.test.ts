import { describe, expect, it } from "vitest";
import { lifecycleStateFor, markLifecycleEvent } from "../src/session-lifecycle.js";
import { HerderEventBus } from "../src/herder-events.js";

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

  it("publishes lifecycle hooks directly to granular session resources", () => {
    const events = new HerderEventBus();
    markLifecycleEvent("zcode", "sess-native", "turn-end", "/workspace", events);
    expect(events.listAfter(0).map((event) => ({ uri: event.uri, source: event.source }))).toEqual([
      { uri: "herder://sessions", source: "lifecycle-hook" },
      { uri: "herder://sessions/zcode/sess-native", source: "lifecycle-hook" },
      { uri: "herder://sessions/zcode/sess-native/messages", source: "lifecycle-hook" },
    ]);
  });

  it("ignores empty session ids", () => {
    markLifecycleEvent("zcode", "   ", "start");
    expect(lifecycleStateFor("zcode", "")).toBeUndefined();
  });
});
