import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-hooks-http-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startServer(): Promise<string> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("the API of the hooks", () => {
  it("names every hook, its state and what it does", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/hooks`);
    expect(response.status).toBe(200);
    const view = await readJson(response);
    expect(view.prohibitionsEnabled).toBe(true);
    expect(view.known).toBe(true);
    const hooks = view.hooks as Array<Record<string, unknown>>;
    expect(hooks.map((hook) => hook.kind)).toEqual(["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]);
    expect(hooks[0]?.humanName).toContain("Stop");
    expect(hooks[0]?.state).toBe("включены");
  });

  it("moves the lever as an explicit action of the owner", async () => {
    const base = await startServer();
    const moved = await fetch(`${base}/api/hooks/prohibitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner", prohibitionsEnabled: false, reason: "хуки мешают" }),
    });
    expect(moved.status).toBe(200);
    const view = await readJson(moved);
    expect(view.prohibitionsEnabled).toBe(false);
    expect(view.reason).toBe("хуки мешают");

    // The hooks read the light answer: the prohibitions are off.
    const read = await readJson(await fetch(`${base}/api/hooks/prohibitions`));
    expect(read.known).toBe(true);
    expect(read.prohibitionsEnabled).toBe(false);
  });

  it("refuses an automatic attempt to move the lever", async () => {
    const base = await startServer();
    const refused = await fetch(`${base}/api/hooks/prohibitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "automation", prohibitionsEnabled: false }),
    });
    expect(refused.status).toBe(403);
    const body = await readJson(refused);
    expect(String(body.error)).toContain("только явное действие владельца");
  });

  it("refuses a hook that does not exist and names the ones that do", async () => {
    const base = await startServer();
    const refused = await fetch(`${base}/api/hooks/prohibitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner", disabledHooks: ["NoSuchHook"] }),
    });
    expect(refused.status).toBe(400);
    const body = await readJson(refused);
    expect(String(body.error)).toContain("Stop");
  });

  it("refuses a change that was made on an old state", async () => {
    const base = await startServer();
    const first = await readJson(await fetch(`${base}/api/hooks/prohibitions`));
    const stale = await fetch(`${base}/api/hooks/prohibitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": "\"stale\"" },
      body: JSON.stringify({ source: "owner", prohibitionsEnabled: false }),
    });
    expect(stale.status).toBe(412);
    expect(String((await readJson(stale)).error)).toContain("изменилось в другой вкладке");
    expect(first.etag).toBeTruthy();
  });

  it("shows the last refusal of the hook that refused", async () => {
    const base = await startServer();
    const reported = await fetch(`${base}/api/hooks/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook: "Stop",
        outcome: "refused",
        reason: "сессия не остановлена: хук продолжил ход",
        sessionId: "codex:1",
      }),
    });
    expect(reported.status).toBe(200);
    const view = await readJson(await fetch(`${base}/api/hooks`));
    const stop = (view.hooks as Array<Record<string, unknown>>).find((hook) => hook.kind === "Stop");
    expect((stop?.lastRefusal as Record<string, unknown>)?.reason).toBe("сессия не остановлена: хук продолжил ход");
  });

  it("keeps the journal of the changes of the lever", async () => {
    const base = await startServer();
    await fetch(`${base}/api/hooks/prohibitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner", prohibitionsEnabled: false, reason: "мешают" }),
    });
    const view = await readJson(await fetch(`${base}/api/hooks`));
    const audit = view.audit as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("мешают");
  });
});
