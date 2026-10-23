import { hostname, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter, SessionDetails } from "../src/types/index.js";

// Focused integration: the conversion route of the web surface, no native turns.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-session-convert-api-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();
const temporaries: string[] = [];

type ConvertReceipt = {
  ok: boolean;
  from: string;
  to: string;
  transferred: { messageCount?: number; targetSessionId?: string; targetPath?: string };
  visibleInOpenCode: boolean;
  visibilityCause?: string;
  visibilityNote: string;
  stayed: { sessionId: string; harness: string; path?: string };
  error?: string;
};

/** A throwaway directory: every fixture of this test lives and dies inside it. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

/** An OpenCode database with the named session tables, each carrying the id. */
function opencodeDb(path: string, tables: string[], sessionIds: Record<string, string[]>): DatabaseSync {
  const db = new DatabaseSync(path);
  for (const table of tables) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY)`);
  for (const [table, ids] of Object.entries(sessionIds)) {
    const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`);
    for (const id of ids) insert.run(id);
  }
  db.close();
  return db;
}

async function withServer(
  sessionId: string,
  details: SessionDetails,
  convert: (input: unknown) => Promise<unknown>,
  opencodeSession: (id: string) => Promise<AgentSession | null>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const live: AgentSession = {
    id: sessionId,
    harness: "codex",
    status: "running",
    title: sessionId,
    cwd: details.session.cwd,
    hostId: localHost,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
  const adapter = {
    type: "codex",
    name: "codex",
    async listSessions() { return [live]; },
    async getSession(id: string) { return id === live.id ? live : null; },
  } as unknown as HarnessAdapter;
  const server = createWebServer({
    adapters: new Map([["codex", adapter]]),
    converter: {} as never,
    supervisor: {
      getSession: async (harness: string, id: string) => (harness === "opencode" ? opencodeSession(id) : null),
      getSessionDetails: async (harness: string, id: string) => (harness === "codex" && id === live.id ? details : null),
      convertSession: convert as never,
    } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function detailsFor(sessionId: string, cwd: string): SessionDetails {
  return {
    session: { id: sessionId, harness: "codex", title: sessionId, status: "running", cwd, hostId: localHost, lastActivity: "" },
    lineage: { kind: "root" },
    children: [],
    messages: [],
    history: { source: "acp-load", complete: true },
  } as SessionDetails;
}

const post = (origin: string, harness: string, id: string, body: unknown) => fetch(`${origin}/api/sessions/${harness}/${id}/convert`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const never = async () => null;

describe("POST /api/sessions/:harness/:id/convert", () => {
  afterEach(() => {
    delete process.env.OPENCODE_DB_PATH;
  });

  it("reports what was carried over and that the original session stayed", async () => {
    const cwd = tempDir("herder-convert-cwd-");
    const globalDb = join(tempDir("herder-convert-global-"), "opencode.db");
    opencodeDb(globalDb, ["session_v2", "session"], { session_v2: ["ses_abc"] });
    process.env.OPENCODE_DB_PATH = globalDb;
    await withServer("s1", detailsFor("s1", cwd), async () => ({
      success: true,
      targetSessionId: "ses_abc",
      targetPath: globalDb,
      messageCount: 40,
    }), async (id) => (id === "ses_abc" ? { id, harness: "opencode" } as AgentSession : null), async (origin) => {
      const response = await post(origin, "codex", "s1", { to: "opencode" });
      expect(response.status).toBe(200);
      const receipt = await response.json() as ConvertReceipt;
      expect(receipt.ok).toBe(true);
      expect(receipt.from).toBe("codex");
      expect(receipt.to).toBe("opencode");
      expect(receipt.transferred.messageCount).toBe(40);
      expect(receipt.transferred.targetSessionId).toBe("ses_abc");
      // The original session stays exactly where it was.
      expect(receipt.stayed).toEqual({ sessionId: "s1", harness: "codex", path: cwd });
    });
  });

  it("calls the conversion a success only when the running OpenCode serves the new session", async () => {
    const cwd = tempDir("herder-convert-cwd-");
    const globalDb = join(tempDir("herder-convert-global-"), "opencode.db");
    opencodeDb(globalDb, ["session_v2"], { session_v2: ["ses_served"] });
    process.env.OPENCODE_DB_PATH = globalDb;
    await withServer("s6", detailsFor("s6", cwd), async () => ({
      success: true,
      targetSessionId: "ses_served",
      targetPath: globalDb,
      messageCount: 12,
    }), async (id) => (id === "ses_served" ? { id, harness: "opencode" } as AgentSession : null), async (origin) => {
      const receipt = await (await post(origin, "codex", "s6", { to: "opencode" })).json() as ConvertReceipt;
      expect(receipt.visibleInOpenCode).toBe(true);
      expect(receipt.visibilityCause).toBe("served");
    });
  });

  it("names the table the running OpenCode reads when the row landed in another one", async () => {
    const cwd = tempDir("herder-convert-cwd-");
    const globalDb = join(tempDir("herder-convert-global-"), "opencode.db");
    // The converter writes the `session` table; the running v2 server reads `session_v2`.
    opencodeDb(globalDb, ["session_v2", "session"], { session: ["ses_legacy"] });
    process.env.OPENCODE_DB_PATH = globalDb;
    await withServer("s7", detailsFor("s7", cwd), async () => ({
      success: true,
      targetSessionId: "ses_legacy",
      targetPath: globalDb,
      messageCount: 9,
    }), never, async (origin) => {
      const receipt = await (await post(origin, "codex", "s7", { to: "opencode" })).json() as ConvertReceipt;
      expect(receipt.visibleInOpenCode).toBe(false);
      expect(receipt.visibilityCause).toBe("table-mismatch");
      expect(receipt.visibilityNote).toContain("`session`");
      expect(receipt.visibilityNote).toContain("`session_v2`");
    });
  });

  it("names the project-local database when the row landed outside the one the server reads", async () => {
    const cwd = tempDir("herder-convert-cwd-");
    const globalDb = join(tempDir("herder-convert-global-"), "opencode.db");
    opencodeDb(globalDb, ["session_v2"], {});
    const projectDir = join(cwd, ".opencode");
    mkdirSync(projectDir, { recursive: true });
    const projectDb = join(projectDir, "opencode.db");
    opencodeDb(projectDb, ["sessions"], { sessions: ["ses_project"] });
    process.env.OPENCODE_DB_PATH = globalDb;
    await withServer("s8", detailsFor("s8", cwd), async () => ({
      success: true,
      targetSessionId: "ses_project",
      targetPath: projectDb,
      messageCount: 5,
    }), never, async (origin) => {
      const receipt = await (await post(origin, "codex", "s8", { to: "opencode" })).json() as ConvertReceipt;
      expect(receipt.visibleInOpenCode).toBe(false);
      expect(receipt.visibilityCause).toBe("database-mismatch");
      expect(receipt.visibilityNote).toContain(projectDb);
      expect(receipt.visibilityNote).toContain(globalDb);
    });
  });

  it("says the running OpenCode did not answer instead of guessing", async () => {
    const cwd = tempDir("herder-convert-cwd-");
    const globalDb = join(tempDir("herder-convert-global-"), "opencode.db");
    opencodeDb(globalDb, ["session_v2"], {});
    process.env.OPENCODE_DB_PATH = globalDb;
    await withServer("s9", detailsFor("s9", cwd), async () => ({
      success: true,
      targetSessionId: "ses_unreachable",
      targetPath: globalDb,
      messageCount: 3,
    }), async () => { throw new Error("connection refused"); }, async (origin) => {
      const receipt = await (await post(origin, "codex", "s9", { to: "opencode" })).json() as ConvertReceipt;
      expect(receipt.visibleInOpenCode).toBe(false);
      expect(receipt.visibilityCause).toBe("server-unreachable");
      expect(receipt.visibilityNote).toContain("connection refused");
    });
  });

  it("refuses a target other than OpenCode", async () => {
    await withServer("s2", detailsFor("s2", tempDir("herder-convert-cwd-")), async () => ({ success: true }), never, async (origin) => {
      const response = await post(origin, "codex", "s2", { to: "claude" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("OpenCode");
    });
  });

  it("refuses a session that is not Codex", async () => {
    await withServer("s3", detailsFor("s3", tempDir("herder-convert-cwd-")), async () => ({ success: true }), never, async (origin) => {
      const response = await post(origin, "opencode", "s3", { to: "opencode" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("Codex");
    });
  });

  it("explains a failed conversion in the owner's words", async () => {
    await withServer("s4", detailsFor("s4", tempDir("herder-convert-cwd-")), async () => ({ success: false, error: "no transcript found" }), never, async (origin) => {
      const response = await post(origin, "codex", "s4", { to: "opencode" });
      expect(response.status).toBe(502);
      const receipt = await response.json() as ConvertReceipt;
      expect(receipt.ok).toBe(false);
      expect(receipt.error).toContain("no transcript found");
    });
  });

  it("refuses a session it cannot see", async () => {
    await withServer("s5", detailsFor("s5", tempDir("herder-convert-cwd-")), async () => ({ success: true }), never, async (origin) => {
      const response = await post(origin, "codex", "missing", { to: "opencode" });
      expect(response.status).toBe(404);
    });
  });
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(statePath, { force: true });
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});
