import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { resetSessionLabelCache } from "../src/session-labels.js";
import type { HarnessAdapter } from "../src/types/index.js";

/**
 * The metadata of a session and the native name of the same session.
 *
 * The metadata belongs to Herder and is stored by Herder itself. The native
 * name is an operation of the harness and only some harnesses have it. The
 * metadata is stored in both cases, and the answer tells the owner which of
 * the two outcomes happened.
 */

const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-l69-label-"));
  cleanups.push(root);
  // The label store of Herder itself, in a scratch file: the test never
  // touches the metadata of a live session.
  vi.stubEnv("AGENT_HERDER_SESSION_LABELS", join(root, "session-labels.json"));
  resetSessionLabelCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetSessionLabelCache();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A harness whose runtime has no native rename channel at all. */
function harnessWithoutRename(): HarnessAdapter {
  return { name: "minimax-code" } as unknown as HarnessAdapter;
}

/** A harness with a native rename channel, the way Codex has one. */
function harnessWithRename(renames: string[], failure?: string): HarnessAdapter {
  return {
    name: "codex",
    renameSession: async (id: string, options: { title: string }) => {
      renames.push(`${id} -> ${options.title}`);
      if (failure) return { ok: false, error: failure, previousTitle: "было" };
      return { ok: true, sessionId: id, previousTitle: "было", title: options.title };
    },
  } as unknown as HarnessAdapter;
}

async function startServer(adapters: Map<string, HarnessAdapter>): Promise<string> {
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

interface LabelAnswer {
  ok?: boolean;
  title?: string;
  renamed?: boolean;
  nativeTitle?: string;
  renameError?: string;
  previousTitle?: string | null;
  error?: string;
  label?: { project?: string; goal?: string; stage?: string };
}

describe("the metadata of a session of a harness without a native rename channel", () => {
  it("is stored and the answer says plainly that the name did not change", async () => {
    const base = await startServer(new Map([["minimax-code", harnessWithoutRename()]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mvs-1", harness: "minimax-code", project: "Herder", goal: "починить панель", stage: "приёмка" }),
    });
    expect(response.status).toBe(200);
    const answer = await response.json() as LabelAnswer;
    // The metadata is saved: the write does not depend on the rename.
    expect(answer.ok).toBe(true);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.goal).toBe("починить панель");
    expect(answer.label?.stage).toBe("приёмка");
    // The answer does not pretend that a rename happened.
    expect(answer.renamed).toBe(false);
    expect(answer.renameError).toContain("нет нативного канала переименования");
    expect(answer.nativeTitle).toBeUndefined();
    // The name that was composed is still the name that was asked for.
    expect(answer.title).toBe("Herder | починить панель | приёмка");

    const read = await fetch(`${base}/api/sessions/label?sessionId=mvs-1&harness=minimax-code`);
    expect(read.status).toBe(200);
    const stored = await read.json() as { label?: { project?: string; goal?: string; stage?: string } };
    expect(stored.label?.project).toBe("Herder");
    expect(stored.label?.goal).toBe("починить панель");
    expect(stored.label?.stage).toBe("приёмка");
  });

  it("keeps the stored metadata when the native rename of the harness fails", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", harnessWithRename(renames, "канал переименования занят")]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "mvs-2", harness: "codex", project: "Herder", stage: "диагностика" }),
    });
    expect(response.status).toBe(200);
    const answer = await response.json() as LabelAnswer;
    // The metadata is not lost because the rename failed.
    expect(answer.ok).toBe(true);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.stage).toBe("диагностика");
    expect(answer.renamed).toBe(false);
    expect(answer.renameError).toBe("канал переименования занят");
    expect(renames).toHaveLength(1);

    const read = await fetch(`${base}/api/sessions/label?sessionId=mvs-2&harness=codex`);
    const stored = await read.json() as { label?: { project?: string; stage?: string } };
    expect(stored.label?.project).toBe("Herder");
    expect(stored.label?.stage).toBe("диагностика");
  });
});

describe("the metadata of a session of a harness with a native rename channel", () => {
  it("renames the session and stores the metadata", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", harnessWithRename(renames)]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-10", harness: "codex", project: "Herder", goal: "починить панель", stage: "приёмка" }),
    });
    expect(response.status).toBe(200);
    const answer = await response.json() as LabelAnswer;
    expect(answer.ok).toBe(true);
    expect(answer.renamed).toBe(true);
    expect(answer.renameError).toBeUndefined();
    expect(answer.nativeTitle).toBe("Herder | починить панель | приёмка");
    expect(answer.title).toBe("Herder | починить панель | приёмка");
    expect(answer.previousTitle).toBe("было");
    // The native path of the harness wrote the name.
    expect(renames).toEqual(["s-10 -> Herder | починить панель | приёмка"]);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.goal).toBe("починить панель");
    expect(answer.label?.stage).toBe("приёмка");

    const read = await fetch(`${base}/api/sessions/label?sessionId=s-10&harness=codex`);
    const stored = await read.json() as { label?: { project?: string; stage?: string } };
    expect(stored.label?.project).toBe("Herder");
    expect(stored.label?.stage).toBe("приёмка");
  });

  it("takes the name of the owner as it is", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", harnessWithRename(renames)]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-11", harness: "codex", title: "Своё имя сессии", project: "Herder" }),
    });
    expect(response.status).toBe(200);
    const answer = await response.json() as LabelAnswer;
    expect(answer.renamed).toBe(true);
    expect(answer.title).toBe("Своё имя сессии");
    expect(renames).toEqual(["s-11 -> Своё имя сессии"]);
    // The name of the owner does not empty the stored metadata.
    expect(answer.label?.project).toBe("Herder");
  });

  it("refuses a request that carries no name at all", async () => {
    const renames: string[] = [];
    const base = await startServer(new Map([["codex", harnessWithRename(renames)]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-12", harness: "codex" }),
    });
    expect(response.status).toBe(400);
    const answer = await response.json() as LabelAnswer;
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("Нужно название");
    expect(renames).toEqual([]);
  });
});

describe("the metadata of a session of a harness that is not on this node", () => {
  it("is refused as before", async () => {
    const base = await startServer(new Map([["codex", harnessWithRename([])]]));
    const response = await fetch(`${base}/api/sessions/label`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-13", harness: "minimax-code", project: "Herder" }),
    });
    expect(response.status).toBe(404);
    const answer = await response.json() as LabelAnswer;
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("недоступна на этом узле");
  });
});
