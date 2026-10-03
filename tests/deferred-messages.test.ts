import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DeferredMessageStore, isBusyCodexWriter, renderDeferredMessages } from "../src/deferred-messages.js";

const projectRoot = resolve(import.meta.dirname, "..");

async function runHook(script: string, input: unknown, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [resolve(projectRoot, script)], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr || `hook exited ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("durable cross-agent inbox", () => {
  it("atomically consumes only the target session messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-inbox-"));
    try {
      const store = new DeferredMessageStore(join(root, "messages.json"));
      await store.add("codex-a", "message one");
      await store.add("codex-a", "message two");
      await store.add("zcode-b", "other session");

      const claimed = await store.take("codex-a");
      expect(claimed.map((message) => message.message)).toEqual(["message one", "message two"]);
      expect(renderDeferredMessages(claimed)).toContain("<agent-herder-inbox>");
      expect(await store.list("codex-a")).toEqual([]);
      expect(await store.list("zcode-b")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers only the native Codex active-writer collision", () => {
    expect(isBusyCodexWriter("codex", "thread t already has an active writer")).toBe(true);
    expect(isBusyCodexWriter("zcode", "already has an active writer")).toBe(false);
    expect(isBusyCodexWriter("codex", "network failed")).toBe(false);
  });

  it("continues a busy Codex thread with inbox context at its Stop boundary", async () => {
    let requestedUrl = "";
    const server = createServer((request, response) => {
      requestedUrl = request.url || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ inboxContext: "<agent-herder-inbox>coordinate now</agent-herder-inbox>", inboxCount: 1 }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const output = JSON.parse(await runHook("scripts/codex-stop-hook.mjs", {
        hook_event_name: "Stop", session_id: "codex-busy", cwd: projectRoot,
      }, { AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`, PLUGIN_ROOT: projectRoot }));
      expect(output).toEqual({ decision: "block", reason: "<agent-herder-inbox>coordinate now</agent-herder-inbox>" });
      expect(requestedUrl).toContain("consume=1");
      expect(requestedUrl).toContain("sessionId=codex-busy");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
