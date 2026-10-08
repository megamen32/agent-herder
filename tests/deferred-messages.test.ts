import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it.each([undefined, "false"])("does not consume inbox or continue without a valid stop flag: %s", async (humanStopHeld) => {
    const requestedUrls: string[] = [];
    const server = createServer((request, response) => {
      requestedUrls.push(request.url || "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ humanStopHeld, inboxContext: "must not deliver" }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const output = await runHook("scripts/codex-stop-hook.mjs", {
        hook_event_name: "Stop", session_id: "codex-invalid-fence", cwd: projectRoot,
      }, { AGENT_HERDER_URL: `http://127.0.0.1:${address.port}` });
      expect(JSON.parse(output)).toEqual({});
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain("consume=0");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
  it("atomically consumes only the target session messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-inbox-"));
    try {
      const store = new DeferredMessageStore(join(root, "messages.json"));
      await store.add("codex-a", "message one");
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
    const requestedUrls: string[] = [];
    const pluginRoot = await mkdtemp(join(tmpdir(), "agent-herder-codex-stop-plugin-"));
    const capturePath = join(pluginRoot, "generated-input.jsonl");
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    await writeFile(join(pluginRoot, "dist", "human-stop-store.js"), [
      "export function getHumanStopStore() {",
      " return { async rememberGeneratedPrompt(harness, id, text) {",
      "  const fs = await import('node:fs/promises');",
      "  await fs.appendFile(process.env.AGENT_HERDER_TEST_CAPTURE, JSON.stringify({ harness, id, text }) + '\\n');",
      " } };",
      "}",
    ].join("\n"));
    const server = createServer((request, response) => {
      const requestedUrl = request.url || "";
      requestedUrls.push(requestedUrl);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(requestedUrl.includes("consume=1")
        ? { humanStopHeld: false, inboxContext: "<agent-herder-inbox>coordinate now</agent-herder-inbox>", inboxCount: 1 }
        : { humanStopHeld: false }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const output = JSON.parse(await runHook("scripts/codex-stop-hook.mjs", {
        hook_event_name: "Stop", session_id: "codex-busy", cwd: projectRoot,
      }, {
        AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
        PLUGIN_ROOT: pluginRoot,
        AGENT_HERDER_TEST_CAPTURE: capturePath,
      }));
      expect(output).toEqual({ decision: "block", reason: "<agent-herder-inbox>coordinate now</agent-herder-inbox>" });
      expect(JSON.parse((await readFile(capturePath, "utf8")).trim())).toEqual({
        harness: "codex", id: "codex-busy", text: "<agent-herder-inbox>coordinate now</agent-herder-inbox>",
      });
      expect(requestedUrls.some((url) => url.includes("consume=0"))).toBe(true);
      const consumingUrl = requestedUrls.find((url) => url.includes("consume=1"));
      expect(consumingUrl).toContain("consume=1");
      expect(consumingUrl).toContain("sessionId=codex-busy");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
