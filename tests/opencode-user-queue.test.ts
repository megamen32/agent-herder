import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { createWebServer } from "../src/web/server.js";

// Focused integration: real HTTP -> queue -> supervisor -> OpenCode adapter.
// The native synchronous response stays blocked until cleanup. Admission must
// finish before that model response; no provider, paid request or live session.
it("acknowledges OpenCode async admission while the native model response remains unfinished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herder-opencode-queue-"));
  let busy = false;
  const posts: string[] = [];
  const slowResponses: ServerResponse[] = [];
  const native = createServer((request, response) => {
    const url = new URL(request.url!, "http://native");
    response.setHeader("content-type", "application/json");
    const reply = (value: unknown) => response.end(JSON.stringify(value));
    if (request.method === "POST") {
      posts.push(url.pathname);
      busy = true;
      if (url.pathname === "/session/thread/prompt_async") {
        response.statusCode = 204;
        return response.end();
      }
      // Model work is still pending, well beyond the test delivery deadline.
      slowResponses.push(response);
      return;
    }
    if (url.pathname === "/session/status") return reply({ thread: { type: busy ? "busy" : "idle" } });
    if (url.pathname === "/session/thread/message") return reply([]);
    if (url.pathname === "/session/thread") return reply({ id: "thread", directory: dir, title: "Fixture", time: { created: Date.now(), updated: Date.now() } });
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  const nativeAddress = native.address() as { port: number };
  const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${nativeAddress.port}` });
  const adapters = new Map([["opencode", adapter]]);
  const converter = { async convert() { return { success: true, targetSessionId: "thread", targetPath: dir, messageCount: 0 }; } };
  const supervisor = new SessionSupervisor(adapters, converter, undefined, { humanStopStore: new HumanStopStore(join(dir, "stops.json")) });
  const jobs = new HerderJobRegistry(new HerderEventBus());
  const web = createWebServer({ adapters, converter, supervisor, jobs });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const post = () => fetch(`${base}/api/sessions/opencode/thread/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "fixture only", humanRequested: true, mode: "queue", inputId: "one" }),
  });
  try {
    const ack = await post();
    expect(ack.status).toBe(202);
    const initial = await ack.json();
    expect(initial).toMatchObject({ ok: true, pending: true, inputId: "one" });
    await vi.waitFor(async () => {
      const receipt = await (await fetch(`${base}/api/sessions/opencode/thread/message-status?inputId=one`)).json();
      expect(receipt).toMatchObject({ ok: true, admitted: true, inputId: "one", job: { state: "completed" } });
      expect(receipt.admissionUnknown).not.toBe(true);
    }, { timeout: 1_000, interval: 10 });
    expect((await adapter.getSession("thread"))?.status).toBe("running");
    expect(posts).toEqual(["/session/thread/prompt_async"]);
    expect((await (await post()).json()).job.id).toBe(initial.job.id);
    expect(posts).toHaveLength(1);
    expect(slowResponses).toHaveLength(0);
  } finally {
    slowResponses.forEach((response) => response.end("{}"));
    web.closeAllConnections(); native.closeAllConnections();
    await Promise.all([web, native].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(dir, { recursive: true, force: true });
  }
});
