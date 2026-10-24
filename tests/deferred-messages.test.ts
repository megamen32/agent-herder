import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DeferredMessageStore, deferredMessages, isBusyCodexWriter, renderDeferredMessages } from "../src/deferred-messages.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import { createWebServer } from "../src/web/server.js";

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
      const requestedUrl = request.url || "";
      requestedUrls.push(requestedUrl);
      response.writeHead(200, { "content-type": "application/json" });
      // The lever of the owner: the hook asks it before it forbids anything.
      if (requestedUrl.startsWith("/api/hooks/prohibitions")) {
        response.end(JSON.stringify({ ok: true, known: true, prohibitionsEnabled: true, disabledHooks: [] }));
        return;
      }
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
      const coordinationUrls = requestedUrls.filter((url) => url.startsWith("/api/coordination/"));
      expect(coordinationUrls).toHaveLength(1);
      expect(coordinationUrls[0]).toContain("consume=0");
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

  it("continues a busy Codex thread at its Stop boundary with the decision of the panel, and the proof of it lives in the store of the panel", async () => {
    // The proof of the decision no longer travels through the local store of
    // the plugin: the panel writes it into its own store, over the route
    // POST /api/human-stop/generated-prompt. The stub of the local module stays
    // in the root of the plugin only to prove that the local path is not used.
    const seenUrls: string[] = [];
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
    // The panel of the test is the panel of the product: the same server, the
    // same routes and the same stores, in the private state directory of the
    // test file and never in the state of the running installation.
    const panel = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
    });
    await new Promise<void>((resolveListen) => panel.listen(0, "127.0.0.1", resolveListen));
    const panelAddress = panel.address();
    if (!panelAddress || typeof panelAddress === "string") throw new Error("the panel did not bind");
    const panelBase = `http://127.0.0.1:${panelAddress.port}`;
    try {
      // The lever of the owner, in the private state directory of the test file:
      // without the runtime of the hooks the panel serves no inbox at all.
      await fetch(`${panelBase}/api/hooks/prohibitions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "owner", hooksEnabled: true, prohibitionsEnabled: true }),
      });
      // The message of another agent waits for the busy thread in the inbox of the panel.
      const seeded = await deferredMessages.add("codex-busy", "coordinate now");
      // The hook talks to the panel through a recording proxy: the panel stays
      // the real one, and every address of the hook is visible to the test.
      const proxy = createServer(async (request, response) => {
        const requestedUrl = request.url || "";
        seenUrls.push(requestedUrl);
        let raw = "";
        for await (const part of request) raw += part;
        const method = request.method || "GET";
        const answer = await fetch(`${panelBase}${requestedUrl}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" || method === "HEAD" ? {} : { body: raw }),
        });
        response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
        response.end(await answer.text());
      });
      await new Promise<void>((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
      const proxyAddress = proxy.address();
      if (!proxyAddress || typeof proxyAddress === "string") throw new Error("the proxy did not bind");
      try {
        const output = JSON.parse(await runHook("scripts/codex-stop-hook.mjs", {
          hook_event_name: "Stop", session_id: "codex-busy", cwd: projectRoot,
        }, {
          AGENT_HERDER_URL: `http://127.0.0.1:${proxyAddress.port}`,
          PLUGIN_ROOT: pluginRoot,
          AGENT_HERDER_TEST_CAPTURE: capturePath,
        }));
        // 1. The decision of the panel reaches the runtime: the hook refuses the
        //    stop of the busy thread with the message of the inbox, and the
        //    runtime turns that refusal into the continuePrompt of the same turn.
        expect(output).toEqual({ decision: "block", reason: renderDeferredMessages([seeded]) });
        // 2. The proof of that decision is in the store of the panel: the digest
        //    of the exact text that the runtime received, and nothing else.
        expect(await getHumanStopStore().isGeneratedPrompt("codex", "codex-busy", { text: output.reason })).toBe(true);
        expect(await getHumanStopStore().isGeneratedPrompt("codex", "codex-busy", { text: "другой текст" })).toBe(false);
        // 3. The panel shows the refusal of the hook with its harness and session.
        const view = await (await fetch(`${panelBase}/api/hooks`)).json() as {
          hooks?: Array<{ kind?: string; lastRefusal?: { sessionId?: string; harness?: string } }>;
        };
        expect(view.hooks?.find((hook) => hook.kind === "Stop")?.lastRefusal)
          .toMatchObject({ sessionId: "codex-busy", harness: "codex" });
        // 4. The local store of the plugin was not used: the proof did not travel
        //    through the local file of the plugin any more.
        await expect(readFile(capturePath, "utf8")).rejects.toThrow(/ENOENT/);
        // 5. The fence of the panel was asked before the inbox was drained, and
        //    the inbox of the target session alone was drained.
        expect(seenUrls.some((url) => url.includes("consume=0"))).toBe(true);
        const consumingUrl = seenUrls.find((url) => url.includes("consume=1"));
        expect(consumingUrl).toContain("consume=1");
        expect(consumingUrl).toContain("sessionId=codex-busy");
        // 6. The message of the inbox was consumed exactly once.
        expect(await deferredMessages.list("codex-busy")).toEqual([]);
      } finally {
        await new Promise<void>((resolveClose, reject) => proxy.close((error) => error ? reject(error) : resolveClose()));
      }
    } finally {
      await new Promise<void>((resolveClose, reject) => panel.close((error) => error ? reject(error) : resolveClose()));
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
