import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import { hookTimeoutContracts } from "../src/hooks/timeout-contract.js";
import type { HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-l54-routes-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** An adapter that renames a session the way the native path of Codex does. */
function renamingAdapter(renames: string[]): HarnessAdapter {
  return {
    name: "codex",
    renameSession: async (id: string, options: { title: string }) => {
      renames.push(`${id} -> ${options.title}`);
      return { ok: true, sessionId: id, previousTitle: "было", title: options.title };
    },
  } as unknown as HarnessAdapter;
}

async function startServer(adapters: Map<string, HarnessAdapter> = new Map()): Promise<string> {
  const server = createWebServer({
    adapters,
    converter: { async convert() { throw new Error("unused"); } },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("the digest of an automatic input of a harness", () => {
  it("is recorded by the panel", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/human-stop/generated-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "minimax-code", sessionId: "s-1", text: "решение хука" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // The store knows the digest of that text, and only the digest.
    expect(await getHumanStopStore().isGeneratedPrompt("minimax-code", "s-1", { text: "решение хука" })).toBe(true);
    expect(await getHumanStopStore().isGeneratedPrompt("minimax-code", "s-1", { text: "другой текст" })).toBe(false);
  });

  it("names the fields it needs", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/human-stop/generated-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "minimax-code" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "harness, sessionId and text are required" });
  });
});

describe("the metadata of a session in the panel", () => {
  it("is read back and written through the native channel of the harness", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", renamingAdapter(renames)]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-2", harness: "codex", project: "Herder", goal: "починить панель", stage: "приёмка" }),
    });
    expect(response.status).toBe(200);
    const answer = await response.json() as { ok?: boolean; title?: string; label?: { project?: string; goal?: string; stage?: string } };
    expect(answer.ok).toBe(true);
    // The title is the composed one, and the native path of the harness wrote it.
    expect(answer.title).toBe("Herder | починить панель | приёмка");
    expect(renames).toEqual(["s-2 -> Herder | починить панель | приёмка"]);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.goal).toBe("починить панель");
    expect(answer.label?.stage).toBe("приёмка");

    const read = await fetch(`${base}/api/sessions/label?sessionId=s-2&harness=codex`);
    expect(read.status).toBe(200);
    const stored = await read.json() as { label?: { project?: string; stage?: string } };
    expect(stored.label?.project).toBe("Herder");
    expect(stored.label?.stage).toBe("приёмка");
  });

  it("says plainly that a harness has no native rename channel", async () => {
    const base = await startServer(new Map([["zcode", { name: "zcode" } as unknown as HarnessAdapter]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-3", harness: "zcode", project: "Herder" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { error?: string }).error).toContain("нет нативного канала переименования");
  });

  it("does not rename a session of another machine", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", renamingAdapter(renames)]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-4", harness: "codex", hostId: "server-44", project: "Herder" }),
    });
    expect(response.status).toBe(409);
    expect(renames).toEqual([]);
  });
});

describe("the timeout contract of the hooks", () => {
  it("names every harness and says where its numbers come from", () => {
    const contracts = hookTimeoutContracts();
    const harnesses = contracts.map((contract) => contract.harness);
    expect(harnesses).toContain("minimax-code");
    expect(harnesses).toContain("codex");
    for (const contract of contracts) {
      if (contract.found) {
        expect(contract.source.length).toBeGreaterThan(0);
        // A number that was not read is never a guess.
        expect(contract.limitSeconds === null || typeof contract.limitSeconds === "number").toBe(true);
      } else {
        expect(contract.reason).toContain("нет данных");
        expect(contract.rows).toEqual([]);
      }
    }
  });
});
