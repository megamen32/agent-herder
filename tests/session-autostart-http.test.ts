import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionAutostartStore } from "../src/autopilot/unfinished-session-launcher.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("session autostart settings HTTP", () => {
  it("defaults on independently and exposes global plus per-session opt-out", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-session-autostart-http-"));
    const store = new SessionAutostartStore(join(root, "settings.json"), {});
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      sessionAutostartStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;

    await expect((await fetch(`${origin}/api/session-autostart`)).json()).resolves.toMatchObject({ enabled: true, source: "default" });
    const zcode = `${origin}/api/session-autostart/sessions/zcode/session-1?cwd=${encodeURIComponent("/workspace/zcode")}`;
    await expect((await fetch(zcode)).json()).resolves.toMatchObject({ enabled: true, source: "default" });

    await fetch(zcode, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, cwd: "/workspace/zcode" }),
    });
    await expect((await fetch(zcode)).json()).resolves.toMatchObject({ enabled: false, source: "session" });

    await fetch(`${origin}/api/session-autostart`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const codex = `${origin}/api/session-autostart/sessions/codex/codex-1?cwd=${encodeURIComponent("/workspace/codex")}`;
    await expect((await fetch(codex)).json()).resolves.toMatchObject({ enabled: false, source: "global" });
    await expect((await fetch(zcode, { method: "DELETE" })).json()).resolves.toMatchObject({ enabled: false, source: "global" });
  });
});

