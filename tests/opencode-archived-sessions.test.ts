import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeClient } from "agent-resume-mcp";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

interface FakeSession {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  /** The archive timestamp. Only an archived session carries it. */
  archived?: number;
}

const NAME = "project-launch-9b9047df64d6f34c";
const ARCHIVED_AT = 1792652957930;

/**
 * A stand-in for the OpenCode 2 server.
 *
 * It reproduces the property that made the defect visible: the archive
 * timestamp lives in `time.archived` of a session payload, and the server
 * keeps answering an archived session under its title.
 */
class FakeOpenCode {
  private readonly sessions: FakeSession[] = [];
  private readonly server: Server;
  private created = 0;

  constructor() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  add(session: FakeSession): void {
    this.sessions.push(session);
  }

  /** How many sessions were created through the server. */
  get createdCount(): number {
    return this.created;
  }

  private payload(session: FakeSession): Record<string, unknown> {
    return {
      id: session.id,
      title: session.title,
      location: { directory: session.directory },
      time: {
        created: session.created,
        updated: session.updated,
        ...(session.archived === undefined ? {} : { archived: session.archived }),
      },
      outcome: "completed",
    };
  }

  private json(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: value }));
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/api/config") { this.json(res, {}); return; }
    if (path === "/api/session/active") { this.json(res, {}); return; }
    if (path === "/api/permission/request") { this.json(res, []); return; }
    if (path === "/api/session" && req.method === "GET") { this.list(res, url); return; }
    if (path === "/api/session" && req.method === "POST") { await this.create(req, res); return; }
    const messages = /^\/api\/session\/([^/]+)\/message$/u.exec(path);
    if (messages && req.method === "GET") { this.json(res, []); return; }
    const prompt = /^\/api\/session\/([^/]+)\/prompt$/u.exec(path);
    if (prompt && req.method === "POST") {
      await this.readBody(req);
      this.json(res, { id: `msg_${prompt[1]!.replace(/[^A-Za-z0-9]/gu, "")}` });
      return;
    }
    const single = /^\/api\/session\/([^/]+)$/u.exec(path);
    if (single && req.method === "GET") {
      const found = this.sessions.find((session) => session.id === single[1]);
      if (!found) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ _tag: "NotFoundError" }));
        return;
      }
      this.json(res, this.payload(found));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ _tag: "NotFoundError" }));
  }

  private list(res: ServerResponse, url: URL): void {
    const directory = url.searchParams.get("directory");
    const search = url.searchParams.get("search");
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? "100"));
    const rows = this.sessions
      .filter((session) => !directory || session.directory === directory)
      .sort((left, right) => right.updated - left.updated);
    if (search !== null) {
      this.json(res, rows.filter((session) => session.title.includes(search)).slice(0, limit).map((session) => this.payload(session)));
      return;
    }
    this.json(res, rows.slice(0, limit).map((session) => this.payload(session)));
  }

  private async create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const location = body.location as { directory?: string } | undefined;
    this.created += 1;
    const session: FakeSession = {
      id: `ses_created_${this.created}`,
      title: typeof body.title === "string" ? body.title : "",
      directory: location?.directory ?? "",
      created: Date.now(),
      updated: Date.now(),
    };
    this.sessions.push(session);
    this.json(res, this.payload(session));
  }
}

const cleanups: string[] = [];
let storeDir = "";
let storePath = "";

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "agent-herder-archived-"));
  storePath = join(storeDir, "named-sessions.json");
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stop.json");
  process.env.AGENT_HERDER_NAMED_SESSION_STORE = storePath;
});

afterEach(async () => {
  delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  delete process.env.AGENT_HERDER_NAMED_SESSION_STORE;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-archived-ws-"));
  cleanups.push(path);
  return realpath(path);
}

/** A restarted runtime: the in-memory caches are gone, the durable state is not. */
async function restartedSeam(): Promise<typeof import("../src/named-session.js")["newOrResumeNamedSession"]> {
  vi.resetModules();
  const module = await import("../src/named-session.js");
  return module.newOrResumeNamedSession;
}

/** A durable binding that points at one session id. */
async function writeBinding(cwd: string, sessionId: string): Promise<void> {
  await writeFile(storePath, `${JSON.stringify({
    version: 1,
    bindings: [{ harness: "opencode", cwd, name: NAME, sessionId, title: NAME, updatedAt: new Date().toISOString() }],
  }, null, 2)}\n`, "utf8");
}

async function boundSessionIds(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as { bindings?: Array<{ sessionId?: string }> };
    return (parsed.bindings ?? []).map((binding) => String(binding.sessionId));
  } catch {
    return [];
  }
}

describe("opencode archived sessions", () => {
  it("keeps an archived session out of the core listing", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: cwd, created: 1, updated: 2 });
      fake.add({ id: "ses_archived", title: NAME, directory: cwd, created: 1, updated: 3, archived: ARCHIVED_AT });
      const client = new OpenCodeClient({ baseUrl: url, protocol: "v2" });
      await client.init();
      const sessions = await client.listSessions({ cwd });
      expect(sessions.map((session) => session.id)).toEqual(["ses_live"]);
    } finally {
      await fake.stop();
    }
  });

  it("keeps an archived session out of the adapter listing", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: cwd, created: 1, updated: 2 });
      fake.add({ id: "ses_archived", title: NAME, directory: cwd, created: 1, updated: 3, archived: ARCHIVED_AT });
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const sessions = await adapter.listSessions({ cwd });
      expect(sessions.map((session) => session.id)).toEqual(["ses_live"]);
    } finally {
      await fake.stop();
    }
  });

  it("does not offer an archived session as a named match", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: cwd, created: 1, updated: 2 });
      fake.add({ id: "ses_archived", title: NAME, directory: cwd, created: 1, updated: 3, archived: ARCHIVED_AT });
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const matches = await adapter.findNamedSessions(NAME, cwd);
      expect(matches.map((session) => session.id)).toEqual(["ses_live"]);
    } finally {
      await fake.stop();
    }
  });

  it("treats a durable binding of an archived session as stale and reuses the live one", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: cwd, created: 1, updated: 2 });
      fake.add({ id: "ses_archived", title: NAME, directory: cwd, created: 1, updated: 3, archived: ARCHIVED_AT });
      await writeBinding(cwd, "ses_archived");
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd,
        message: "work",
        inputId: "input-archived-binding",
      });

      expect(result.ok).toBe(true);
      expect(result.created).toBe(false);
      expect(result.sessionId).toBe("ses_live");
      expect(fake.createdCount).toBe(0);
      expect(await boundSessionIds()).not.toContain("ses_archived");
    } finally {
      await fake.stop();
    }
  });

  it("does not reuse an archived session that is the only one with that name", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_archived", title: NAME, directory: cwd, created: 1, updated: 3, archived: ARCHIVED_AT });
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd,
        message: "work",
        inputId: "input-archived-only",
      });

      expect(result.ok).toBe(true);
      expect(result.created).toBe(true);
      expect(result.sessionId).not.toBe("ses_archived");
      expect(fake.createdCount).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  it("still finds and reuses a live named session", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: cwd, created: 1, updated: 2 });
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd,
        message: "work",
        inputId: "input-live",
      });

      expect(result.ok).toBe(true);
      expect(result.created).toBe(false);
      expect(result.sessionId).toBe("ses_live");
      expect(fake.createdCount).toBe(0);
    } finally {
      await fake.stop();
    }
  });
});
