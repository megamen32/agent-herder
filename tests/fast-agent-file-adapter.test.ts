import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FastAgentFileAdapter } from "../src/adapters/fast-agent.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Fast Agent persisted observer", () => {
  it("lists native sessions and exposes recent messages without starting a process", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-"));
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "session-1",
      created_at: "2026-08-18T10:00:00.000Z",
      last_activity: "2026-08-18T10:01:00.000Z",
      metadata: { first_user_preview: "Inspect the project", extras: { harness_session_id: "session-1" } },
      execution: { status: "completed" },
    }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [
      { role: "user", timestamp: "2026-08-18T10:00:00.000Z", content: [{ type: "text", text: "Inspect the project" }] },
      { role: "assistant", timestamp: "2026-08-18T10:01:00.000Z", content: [{ type: "text", text: "I inspected it." }] },
    ] }));

    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    await adapter.init();
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "fast-agent:session-1",
      harness: "fast-agent",
      status: "stopped",
      title: "Inspect the project",
      cwd: home,
      messageCount: 2,
      lastMessage: "I inspected it.",
    });
    expect(await adapter.getSessionMessages("fast-agent:session-1", 1)).toMatchObject([{ text: "I inspected it." }]);
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue work" })).toEqual({ ok: true });
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue in background", queue: true })).toEqual({ ok: true });
  });
});
