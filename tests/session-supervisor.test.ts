import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter } from "../src/adapters/acp.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-acp-agent.mjs");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AcpAdapter", () => {
  it("keeps one ACP connection while listing, resuming, and prompting a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-acp-"));
    const counterFile = join(root, "methods.log");
    const adapter = new AcpAdapter({
      profile: "fake-claude",
      command: process.execPath,
      args: [fixture],
      cwd: root,
      env: { FAKE_ACP_COUNTER: counterFile },
    });
    cleanups.push(async () => {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    });

    await adapter.init();
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "acp:fake-claude:fake-session-1", harness: "claude", title: "Fake ACP session" });

    const resumed = await adapter.resumeSession("acp:fake-claude:fake-session-1");
    expect(resumed).toEqual({ ok: true });
    const replay = await adapter.getSessionMessages("acp:fake-claude:fake-session-1", 3);
    expect(replay).toHaveLength(2);
    expect(replay).toEqual([
      expect.objectContaining({ role: "user", text: "old prompt" }),
      expect.objectContaining({ role: "assistant", parts: expect.arrayContaining([expect.objectContaining({ type: "tool_result", output: "passed" })]) }),
    ]);
    expect(await adapter.sendMessage("acp:fake-claude:fake-session-1", { message: "first" })).toEqual({ ok: true });
    expect(await adapter.sendMessage("acp:fake-claude:fake-session-1", { message: "second" })).toEqual({ ok: true });

    const methods = (await readFile(counterFile, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "session/load")).toHaveLength(2);
    expect(methods.filter((method) => method === "session/prompt")).toHaveLength(2);
  });

  it("does not call cached prompt messages ACP history when session/load is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-acp-no-load-"));
    const adapter = new AcpAdapter({
      profile: "fake-claude-no-load",
      command: process.execPath,
      args: [fixture],
      cwd: root,
      env: { FAKE_ACP_NO_LOAD: "1" },
    });
    cleanups.push(async () => {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    });

    await adapter.init();
    await adapter.listSessions();
    const id = "acp:fake-claude-no-load:fake-session-1";
    await adapter.sendMessage(id, { message: "cached only" });
    expect(await adapter.getSessionMessages(id, 3)).toBeNull();
  });
});
