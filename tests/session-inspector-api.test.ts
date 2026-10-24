import { hostname } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter, SessionDetails } from "../src/types/index.js";

// Focused integration: the inspector route of the web surface, no native turns.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-session-inspector-api-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();

type Facts = {
  model: { native?: string };
  lastAction: { label: string; tool?: string; at?: string } | null;
  files: { path: string; operation: string }[];
  worktreeFiles: string[];
  subagents: { count: number; items: { id: string; name: string; named: boolean; role?: string; status: string }[] };
  history: { source: string; complete: boolean };
};

async function withServer(sessionId: string, details: SessionDetails, run: (origin: string) => Promise<void>): Promise<void> {
  const live: AgentSession = {
    id: sessionId,
    harness: "codex",
    status: "running",
    title: sessionId,
    cwd: "/launch/dir",
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
      getSession: async (harness: string, id: string) => (harness === "codex" && id === live.id ? live : null),
      getSessionDetails: async (harness: string, id: string) => (harness === "codex" && id === live.id ? details : null),
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

function detailsFor(sessionId: string, overrides: Partial<SessionDetails> = {}): SessionDetails {
  return {
    session: { id: sessionId, harness: "codex", title: sessionId, status: "running", cwd: "/launch/dir", hostId: localHost, lastActivity: "", model: "gpt-6.1-sol" },
    lineage: { kind: "root" },
    children: [],
    messages: [],
    history: { source: "acp-load", complete: true },
    ...overrides,
  } as SessionDetails;
}

describe("GET /api/sessions/:harness/:id/inspect", () => {
  it("answers what the agent did last and which files it changed", async () => {
    await withServer("s1", detailsFor("s1", {
      messages: [{
        id: "m1", role: "assistant", timestamp: "2026-10-23T10:00:00Z",
        parts: [{ type: "tool_call", name: "write", input: { command: "apply_patch src/web/server.ts" } }],
      }],
    }), async (origin) => {
      const response = await fetch(`${origin}/api/sessions/codex/s1/inspect`);
      expect(response.status).toBe(200);
      const facts = await response.json() as Facts;
      expect(facts.model.native).toBe("gpt-6.1-sol");
      expect(facts.lastAction?.label).toBe("Изменение файлов");
      expect(facts.files.map((file) => file.path)).toContain("src/web/server.ts");
    });
  });

  it("says plainly that nothing was recorded", async () => {
    await withServer("s2", detailsFor("s2"), async (origin) => {
      const facts = await (await fetch(`${origin}/api/sessions/codex/s2/inspect`)).json() as Facts;
      expect(facts.lastAction).toBeNull();
      expect(facts.files).toEqual([]);
      expect(facts.subagents.count).toBe(0);
    });
  });

  it("names the child sessions instead of showing a placeholder", async () => {
    await withServer("s3", detailsFor("s3", {
      children: [
        { id: "c1", harness: "codex", title: "Untitled session", status: "running", cwd: "", lastActivity: "", meta: { task: "Собрать отчёт" } },
      ],
    }), async (origin) => {
      const facts = await (await fetch(`${origin}/api/sessions/codex/s3/inspect`)).json() as Facts;
      expect(facts.subagents.count).toBe(1);
      expect(facts.subagents.items[0].name).toBe("Собрать отчёт");
      expect(facts.subagents.items[0].named).toBe(true);
    });
  });

  it("refuses a session it cannot see", async () => {
    await withServer("s4", detailsFor("s4"), async (origin) => {
      const response = await fetch(`${origin}/api/sessions/codex/missing/inspect`);
      expect(response.status).toBe(404);
    });
  });
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(statePath, { force: true });
});
