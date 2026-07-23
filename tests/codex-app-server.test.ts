import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

describe("Codex app-server adapter", () => {
  it("keeps a native thread, interrupts turns, resumes, and forks", async () => {
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      modelIds: ["gpt-test", "gpt-test-2"],
    });

    await adapter.init();
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("thread-1");
    expect(sessions[0].harness).toBe("codex");

    const queued = await adapter.sendMessage("thread-1", { message: "hold", queue: true });
    expect(queued).toEqual({ ok: true });
    expect(await adapter.cancelTurn("thread-1")).toEqual({ ok: true });
    expect(await adapter.resumeSession("thread-1")).toEqual({ ok: true });
    expect(await adapter.changeModel("thread-1", "gpt-test-2")).toEqual({ ok: true });

    const forked = await adapter.forkSession("thread-1", "continue in a child");
    expect(forked.ok).toBe(true);
    expect(forked.sessionId).toBe("thread-fork-1");
    expect(await adapter.listModels()).toEqual(["gpt-test", "gpt-test-2"]);

    await adapter.dispose();
  });
});
