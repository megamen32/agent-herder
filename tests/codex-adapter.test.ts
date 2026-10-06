import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

async function makeCodexFixture(root: string, executable: string): Promise<CodexAdapter> {
  const codexDir = join(root, "codex");
  const sessionDir = join(codexDir, "sessions", "2026", "10", "06");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({
    id: "thread-queued-stop", thread_name: "Queued stop test", updated_at: new Date().toISOString(),
  }) + "\n");
  await writeFile(join(sessionDir, "rollout-thread-queued-stop.jsonl"), JSON.stringify({
    type: "session_meta", payload: { id: "thread-queued-stop", session_id: "thread-queued-stop", cwd: root },
  }) + "\n");
  return new CodexAdapter({ codexBin: executable, codexDir });
}

describe("Codex CLI queued prompt stop fence", () => {
  it("drops a queued prompt held by a fresh manual stop before spawning exec resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-queued-stop-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const stopStorePath = join(root, "human-stops.json");
    const executionLog = join(root, "executed.txt");
    const executable = join(root, "fake-codex");
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = stopStorePath;
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${executionLog}'\n`);
    await chmod(executable, 0o755);
    const adapter = await makeCodexFixture(root, executable);
    try {
      await getHumanStopStore().hold({ harness: "codex", id: "thread-queued-stop" }, {
        id: "manual-stop-before-admission", at: new Date().toISOString(), reason: "operator stopped before queued send",
      });

      await expect(adapter.sendMessage("thread-queued-stop", { message: "generated queued prompt", queue: true }))
        .resolves.toMatchObject({ ok: false });

      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(readFile(executionLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(getHumanStopStore().isGeneratedPrompt("codex", "thread-queued-stop", { text: "generated queued prompt" }))
        .resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
    }
  });

  it("records automated queued text before detached admission and leaves human text unmarked", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-queued-ledger-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const executionLog = join(root, "executed.txt");
    const executable = join(root, "fake-codex");
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "human-stops.json");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${executionLog}'\n`);
    await chmod(executable, 0o755);
    const adapter = await makeCodexFixture(root, executable);
    const originalGetSession = adapter.getSession.bind(adapter);
    adapter.getSession = async (id) => {
      const session = await originalGetSession(id);
      return session ? { ...session, meta: { ...session.meta, activeTurnId: "previous-unrelated-turn" } } : null;
    };
    try {
      await expect(adapter.sendMessage("thread-queued-stop", { message: "automated queued text", queue: true }))
        .resolves.toEqual({ ok: true });
      await expect(getHumanStopStore().isGeneratedPrompt("codex", "thread-queued-stop", { text: "automated queued text" }))
        .resolves.toBe(true);
      await expect(getHumanStopStore().isGeneratedPrompt("codex", "thread-queued-stop", { turnId: "previous-unrelated-turn" }))
        .resolves.toBe(false);

      await expect(adapter.sendMessage("thread-queued-stop", { message: "automated synchronous text" }))
        .resolves.toEqual({ ok: true });
      await expect(getHumanStopStore().isGeneratedPrompt("codex", "thread-queued-stop", { text: "automated synchronous text" }))
        .resolves.toBe(true);

      await expect(adapter.sendMessage("thread-queued-stop", { message: "explicit human text", queue: true, origin: "human" }))
        .resolves.toEqual({ ok: true });
      await expect(getHumanStopStore().isGeneratedPrompt("codex", "thread-queued-stop", { text: "explicit human text" }))
        .resolves.toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await readFile(executionLog, "utf8")).toContain("automated queued text");
      expect(await readFile(executionLog, "utf8")).toContain("explicit human text");
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
    }
  });
});
