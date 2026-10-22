import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { AUTOMATION_FORBIDDEN_CODE, AutomationDisarmStore } from "../src/automation-disarm/index.js";

const NAME = "project-launch-9b9047df64d6f34c";
const ARCHIVED_AT = 1792652957930;

interface FakeSession {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  /** The archive timestamp. Only an archived session carries it. */
  archived?: number;
}

/**
 * A stand-in for the OpenCode 2 server.
 *
 * It reproduces the property that made the archive defect visible: the server
 * keeps answering an archived session under its title, so a name search finds
 * it. It also counts the named searches, so a test can prove that the owner
 * lever refused a launch before the runtime asked the server anything.
 */
class FakeOpenCode {
  private readonly sessions: FakeSession[] = [];
  private readonly server: Server;
  private created = 0;
  private namedSearches = 0;

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

  /** How many times the server was asked to search a name. */
  get namedSearchCount(): number {
    return this.namedSearches;
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
      this.namedSearches += 1;
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
const savedEnv: Record<string, string | undefined> = {};
let root = "";
let stateDir = "";
let storePath = "";

/** Set one environment seam and remember its original value. */
function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-herder-lead-integration-"));
  cleanups.push(root);
  // The owner lever reads its durable file from the runtime state directory,
  // so the seam points at a temporary directory: the live owner file of the
  // running runtime is never read and never written by this test.
  stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  storePath = join(root, "named-sessions.json");
  setEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
  setEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(root, "human-stop.json"));
  setEnv("AGENT_HERDER_NAMED_SESSION_STORE", storePath);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A real directory, so a scope and its canonical form are one area. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-lead-area-"));
  cleanups.push(path);
  return realpath(path);
}

/** A restarted runtime: the in-memory caches are gone, the durable state is not. */
async function freshSeam(): Promise<typeof import("../src/named-session.js")["newOrResumeNamedSession"]> {
  vi.resetModules();
  const module = await import("../src/named-session.js");
  return module.newOrResumeNamedSession;
}

/** The owner forbids one area, the way the owner lever records it. */
async function forbidScope(scope: string): Promise<void> {
  const durable = AutomationDisarmStore.at(stateDir);
  const applied = await durable.applyRecord({ source: "owner", scope, forbidden: true });
  expect(applied.ok).toBe(true);
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

/** The adapters of one fake server. */
async function adaptersOf(url: string): Promise<Map<string, OpenCodeAdapter>> {
  const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2" });
  await adapter.init();
  return new Map([["opencode", adapter]]);
}

describe("the owner lever and the archive filter in one contour", () => {
  it("refuses a disarmed area with the stable code and names the area beside it", async () => {
    const area = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_archived", title: NAME, directory: area, created: 1, updated: 3, archived: ARCHIVED_AT });
      await forbidScope(area);
      const adapters = await adaptersOf(url);
      const deliver = await freshSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: area,
        message: "work",
        inputId: "input-disarmed-area",
      });

      expect(result.ok).toBe(false);
      expect(result.created).toBe(false);
      expect(result.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
      expect(result.failureCode).toBe("automation_disabled");
      expect(result.nonRetryable).toBe(true);
      expect(result.delivery).toBe("not_attempted");
      // The area travels beside the code, never inside the wording.
      expect(result.routingReasonDetail).toBe(area);
      expect(result.error).toContain("запрещён владельцем");
      expect(result.error).not.toContain(area);
    } finally {
      await fake.stop();
    }
  });

  it("refuses the disarmed area before the runtime searches the native session", async () => {
    const area = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_archived", title: NAME, directory: area, created: 1, updated: 3, archived: ARCHIVED_AT });
      await forbidScope(area);
      const adapters = await adaptersOf(url);
      const deliver = await freshSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: area,
        message: "work",
        inputId: "input-gate-first",
      });

      expect(result.ok).toBe(false);
      // The lever stands before the native search: the server was never asked
      // for a session of that name, and no session was created.
      expect(fake.namedSearchCount).toBe(0);
      expect(fake.createdCount).toBe(0);
      expect(await boundSessionIds()).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  it("keeps an archived session out of the search and drops its durable binding", async () => {
    const area = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_archived", title: NAME, directory: area, created: 1, updated: 3, archived: ARCHIVED_AT });
      await writeBinding(area, "ses_archived");
      const adapters = await adaptersOf(url);
      const deliver = await freshSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: area,
        message: "work",
        inputId: "input-archived-binding",
      });

      expect(result.ok).toBe(true);
      // The archived session is not a candidate, so the name is free and a
      // live session is created instead of the dead one.
      expect(result.created).toBe(true);
      expect(result.sessionId).not.toBe("ses_archived");
      expect(fake.createdCount).toBe(1);
      expect(fake.namedSearchCount).toBe(1);
      // The binding to the archived session is stale and does not survive.
      expect(await boundSessionIds()).not.toContain("ses_archived");
    } finally {
      await fake.stop();
    }
  });

  it("still reuses the live session of a name whose twin is archived", async () => {
    const area = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_live", title: NAME, directory: area, created: 1, updated: 2 });
      fake.add({ id: "ses_archived", title: NAME, directory: area, created: 1, updated: 3, archived: ARCHIVED_AT });
      const adapters = await adaptersOf(url);
      const deliver = await freshSeam();

      const result = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: area,
        message: "work",
        inputId: "input-live-twin",
      });

      expect(result.ok).toBe(true);
      // One live candidate, so the name is not ambiguous and nothing is made.
      expect(result.created).toBe(false);
      expect(result.sessionId).toBe("ses_live");
      expect(fake.createdCount).toBe(0);
      expect(fake.namedSearchCount).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  it("holds both halves at once: the lever refuses the disarmed area, the filter holds in the free one", async () => {
    const disarmed = await workspace();
    const free = await workspace();
    const fake = new FakeOpenCode();
    const url = await fake.start();
    try {
      fake.add({ id: "ses_archived_disarmed", title: NAME, directory: disarmed, created: 1, updated: 3, archived: ARCHIVED_AT });
      fake.add({ id: "ses_archived_free", title: NAME, directory: free, created: 1, updated: 3, archived: ARCHIVED_AT });
      await writeBinding(free, "ses_archived_free");
      await forbidScope(disarmed);
      const adapters = await adaptersOf(url);
      const deliver = await freshSeam();

      // The disarmed area: the lever refuses, and it refuses before the
      // runtime asks the server for a session of that name.
      const refused = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: disarmed,
        message: "work",
        inputId: "input-both-disarmed",
      });

      expect(refused.ok).toBe(false);
      expect(refused.failureCode).toBe(AUTOMATION_FORBIDDEN_CODE);
      expect(refused.routingReasonDetail).toBe(disarmed);
      expect(fake.namedSearchCount).toBe(0);
      expect(fake.createdCount).toBe(0);

      // The free area: the search happens, the archived session is not a
      // candidate, and its durable binding does not survive.
      const delivered = await deliver(adapters, {
        harness: "opencode",
        name: NAME,
        cwd: free,
        message: "work",
        inputId: "input-both-free",
      });

      expect(delivered.ok).toBe(true);
      expect(delivered.created).toBe(true);
      expect(delivered.sessionId).not.toBe("ses_archived_free");
      // Exactly one native search happened, and it happened in the free area.
      expect(fake.namedSearchCount).toBe(1);
      expect(fake.createdCount).toBe(1);
      expect(await boundSessionIds()).not.toContain("ses_archived_free");
    } finally {
      await fake.stop();
    }
  });
});
