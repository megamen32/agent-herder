import { describe, expect, it } from "vitest";
import { AgentHerderSessionConverter } from "../src/session-convert.js";

describe("session conversion cancellation", () => {
  it("terminates the conversion worker when the owning job is cancelled", async () => {
    const converter = new AgentHerderSessionConverter();
    const controller = new AbortController();
    const pending = converter.convert({
      sessionId: "cancel-me",
      from: "claude",
      to: "codex",
      searchPaths: ["/tmp/agent-herder-nonexistent-convert-source"],
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
