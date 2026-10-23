import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWebServer } from "../src/web/server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { AgentHerderSessionConverter } from "../src/session-convert.js";
import type { SessionDetails } from "../src/types/index.js";

/**
 * Live probe of the conversion route: a real transcript goes through the real
 * converter and the real route, and the answer the owner would get is checked
 * for honesty.
 *
 * Everything the probe touches lives inside one throwaway home directory: the
 * transcript, the OpenCode databases, the working directory. The owner's own
 * directories are never read and never written.
 */
const temporaries: string[] = [];

function throwawayHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

/** A Codex rollout with two messages: the shape the converter reads. */
function writeRollout(codexHome: string, sessionId: string, cwd: string): void {
  const dir = join(codexHome, "sessions", "2026", "10", "23");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: "2026-10-23T10:00:00.000Z", type: "session_meta", payload: { id: sessionId, session_id: sessionId, cwd } },
    { timestamp: "2026-10-23T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Проверка перевода сессии" }] } },
    { timestamp: "2026-10-23T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Перевод проверен" }] } },
  ];
  writeFileSync(join(dir, `rollout-2026-10-23T00-00-00-${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("live conversion probe", () => {
  it("carries the conversation over and refuses to call a session the owner cannot see a success", async () => {
    const realHome = process.env.HOME;
    const home = throwawayHome("herder-convert-probe-home-");
    const projectDir = join(home, "project");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "probe-session-1";
    writeRollout(join(home, ".codex"), sessionId, projectDir);

    // The converter reads the transcript from the home it was built with, so
    // the home is switched before anything is constructed.
    const previous = { home: process.env.HOME, dataHome: process.env.XDG_DATA_HOME, db: process.env.OPENCODE_DB_PATH };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = join(home, ".local", "share");
    // The global database a real OpenCode install has: the server reads its
    // `session_v2` table.
    const globalDb = join(home, "global", "opencode.db");
    mkdirSync(join(home, "global"), { recursive: true });
    const globalHandle = new DatabaseSync(globalDb);
    globalHandle.exec("CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY)");
    globalHandle.close();
    process.env.OPENCODE_DB_PATH = globalDb;
    const ownerProjectDb = join(realHome ?? home, ".opencode", "opencode.db");
    const ownerDbBefore = existsSync(ownerProjectDb);

    try {
      const converter = new AgentHerderSessionConverter();
      const real = new SessionSupervisor(new Map(), converter);
      const probeSession = {
        id: sessionId, harness: "codex", title: "probe", status: "running", cwd: projectDir,
        hostId: "probe", lastActivity: new Date().toISOString(), needsPermission: false,
      };
      const details = {
        session: probeSession, lineage: { kind: "root" }, children: [], messages: [],
        history: { source: "acp-load", complete: true },
      } as SessionDetails;
      const server = createWebServer({
        adapters: new Map(),
        converter: {} as never,
        supervisor: {
          getSessionDetails: async (harness: string, id: string) => (harness === "codex" && id === sessionId ? details : null),
          convertSession: (input: unknown) => real.convertSession(input as never),
          // No live OpenCode server in the probe: it cannot serve the session.
          getSession: async () => null,
        } as never,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const response = await fetch(`${origin}/api/sessions/codex/${sessionId}/convert`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "opencode" }),
        });
        const receipt = await response.json() as Record<string, unknown>;
        expect(response.status).toBe(200);
        expect(receipt.ok).toBe(true);
        const transferred = receipt.transferred as { messageCount?: number; targetSessionId?: string; targetPath?: string };
        expect(transferred.messageCount).toBeGreaterThan(0);
        expect(transferred.targetSessionId).toBeTruthy();
        // Everything was written inside the throwaway home.
        expect(transferred.targetPath?.startsWith(home)).toBe(true);

        // The owner is told the truth: the running OpenCode does not show the
        // new session, and the panel says why.
        expect(receipt.visibleInOpenCode).toBe(false);
        expect(receipt.visibilityCause).toBe("database-mismatch");
        const note = String(receipt.visibilityNote);
        expect(note).toContain(projectDir);
        expect(note).toContain("project-local");
        expect(note).toContain("session_v2");

        // The original session stays exactly where it was.
        expect((receipt.stayed as { harness: string }).harness).toBe("codex");

        // The row is really in the project-local database, in the table the
        // converter used — which is not the one the live server reads.
        const db = new DatabaseSync(transferred.targetPath!, { readOnly: true });
        try {
          const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name);
          expect(tables).toContain("sessions");
          expect(tables).not.toContain("session_v2");
          const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(transferred.targetSessionId!);
          expect(row).toBeTruthy();
        } finally {
          db.close();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      process.env.HOME = previous.home;
      if (previous.dataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous.dataHome;
      if (previous.db === undefined) delete process.env.OPENCODE_DB_PATH;
      else process.env.OPENCODE_DB_PATH = previous.db;
    }

    // No trace is left in the owner's own directories.
    expect(existsSync(ownerProjectDb)).toBe(ownerDbBefore);
    expect(existsSync(join(process.cwd(), ".opencode"))).toBe(false);
  }, 60_000);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});
