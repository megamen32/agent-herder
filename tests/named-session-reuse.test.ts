import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

interface FakeSession {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
}

/**
 * A stand-in for the OpenCode 2 server.
 *
 * It answers the endpoints the core client uses and reproduces the two
 * properties that made the defect visible: the listing is a window of the
 * newest sessions, while a name search reaches the whole catalog.
 */
class FakeOpenCode {
  private readonly sessions: FakeSession[] = [];
  private readonly server: Server;
  private created = 0;
  /** The search parameter is ignored and the answer is always a full window. */
  saturateSearch = false;
  /** The search parameter never matches anything. */
  blindSearch = false;

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
      time: { created: session.created, updated: session.updated },
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
      if (this.saturateSearch) {
        // A window that is full and does not contain the name: the server
        // cannot prove that the session does not exist.
        const filler = Array.from({ length: limit }, (_, index) => ({
          id: `ses_filler_${index}`,
          title: `filler-${index}`,
          directory: directory ?? "",
          created: 0,
          updated: 0,
        }));
        this.json(res, filler.map((session) => this.payload(session)));
        return;
      }
      if (this.blindSearch) { this.json(res, []); return; }
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

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "agent-herder-session-reuse-"));
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stop.json");
  process.env.AGENT_HERDER_NAMED_SESSION_STORE = join(storeDir, "named-sessions.json");
});

afterEach(async () => {
  delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  delete process.env.AGENT_HERDER_NAMED_SESSION_STORE;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-session-reuse-ws-"));
  cleanups.push(path);
  return realpath(path);
}

/** A restarted runtime: the in-memory caches are gone, the durable state is not. */
async function restartedSeam(): Promise<typeof import("../src/named-session.js")["newOrResumeNamedSession"]> {
  vi.resetModules();
  const module = await import("../src/named-session.js");
  return module.newOrResumeNamedSession;
}

function noise(cwd: string, prefix: string, count: number, from: number): FakeSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${prefix}_${index}`,
    title: `${prefix}-${index}`,
    directory: cwd,
    created: from + index,
    updated: from + index,
  }));
}

/** Sessions that are newer than everything the herder created so far. */
function newerNoise(cwd: string, prefix: string, count: number): FakeSession[] {
  return noise(cwd, prefix, count, Date.now() + 1000);
}

describe("named session reuse", () => {
  it("reuses a named session that the newest listing window no longer shows", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      // The named session is the oldest one of 601: every window of the newest
      // sessions leaves it out.
      fake.add({ id: "ses_old", title: "project-launch-9b9047df64d6f34c", directory: cwd, created: 1, updated: 1 });
      for (const session of noise(cwd, "noise", 600, 1000)) fake.add(session);
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const { newOrResumeNamedSession } = await import("../src/named-session.js");

      const result = await newOrResumeNamedSession(adapters, {
        harness: "opencode",
        name: "project-launch-9b9047df64d6f34c",
        cwd,
        message: "work",
        inputId: "input-1",
      });

      expect(result.ok).toBe(true);
      expect(result.created).toBe(false);
      expect(result.sessionId).toBe("ses_old");
      expect(fake.createdCount).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  it("reuses the session of a repeated delivery after the listing window moved on", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const first = await deliver(adapters, {
        harness: "opencode",
        name: "project-launch-repeat",
        cwd,
        message: "work",
        inputId: "input-1",
      });
      expect(first.ok).toBe(true);
      expect(first.created).toBe(true);
      const sessionId = first.sessionId;
      expect(sessionId).toBeTruthy();

      // 600 newer sessions land in the same directory, so the created session
      // left every window of the newest sessions.
      for (const session of newerNoise(cwd, "late", 600)) fake.add(session);

      const restarted = await restartedSeam();
      const second = await restarted(adapters, {
        harness: "opencode",
        name: "project-launch-repeat",
        cwd,
        message: "work again",
        inputId: "input-2",
      });

      expect(second.ok).toBe(true);
      expect(second.created).toBe(false);
      expect(second.sessionId).toBe(sessionId);
      expect(fake.createdCount).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  it("refuses to create a second session when the catalog cannot answer the name", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.saturateSearch = true;
      for (const session of noise(cwd, "noise", 600, 1000)) fake.add(session);
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: "project-launch-unknown",
        cwd,
        message: "work",
        inputId: "input-1",
      });

      expect(result.ok).toBe(false);
      expect(result.created).toBe(false);
      expect(result.error).toMatch(/search window/);
      expect(fake.createdCount).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  it("reuses the session from the durable binding when the catalog cannot find it", async () => {
    const cwd = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
      await adapter.init();
      const adapters = new Map([["opencode", adapter]]);
      const deliver = await restartedSeam();

      const first = await deliver(adapters, {
        harness: "opencode",
        name: "project-launch-binding",
        displayTitle: "Инцидент: сайт возвращает 502 | fleet-health",
        cwd,
        message: "work",
        inputId: "input-1",
      });
      expect(first.ok).toBe(true);
      expect(first.created).toBe(true);
      const sessionId = first.sessionId;
      expect((await adapter.getSession(sessionId!))?.title).toBe("Инцидент: сайт возвращает 502 | fleet-health");

      // The catalog stops answering the name, and the listing window moved on.
      fake.blindSearch = true;
      for (const session of newerNoise(cwd, "late", 600)) fake.add(session);

      const restarted = await restartedSeam();
      const second = await restarted(adapters, {
        harness: "opencode",
        name: "project-launch-binding",
        cwd,
        message: "work again",
        inputId: "input-2",
      });

      expect(second.ok).toBe(true);
      expect(second.created).toBe(false);
      expect(second.sessionId).toBe(sessionId);
      expect(fake.createdCount).toBe(1);

      const bindings = JSON.parse(await readFile(process.env.AGENT_HERDER_NAMED_SESSION_STORE!, "utf8")) as {
        bindings: Array<{ name: string; sessionId: string }>;
      };
      expect(bindings.bindings).toContainEqual(expect.objectContaining({
        name: "project-launch-binding",
        sessionId,
      }));
    } finally {
      await fake.stop();
    }
  });
});
