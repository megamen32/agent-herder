import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { resetSessionLabelCache } from "../src/session-labels.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");
let previousLabelPath: string | undefined;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-rename-tool-"));
  roots.push(root);
  previousLabelPath = process.env.AGENT_HERDER_SESSION_LABELS;
  process.env.AGENT_HERDER_SESSION_LABELS = join(root, "session-labels.json");
  resetSessionLabelCache();
});

afterEach(async () => {
  if (previousLabelPath === undefined) delete process.env.AGENT_HERDER_SESSION_LABELS;
  else process.env.AGENT_HERDER_SESSION_LABELS = previousLabelPath;
  resetSessionLabelCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A harness without a native rename channel. */
function harnessWithoutRename(session: AgentSession): HarnessAdapter {
  return {
    type: "opencode",
    name: "OpenCode Fixture",
    async init() {},
    async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

async function connect(adapters: Map<string, HarnessAdapter>) {
  const events = new HerderEventBus();
  const server = new McpServer({ name: "rename-session-tool-test", version: "1" });
  registerSessionTools(server, { adapters, jobs: new HerderJobRegistry(events), events });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rename-session-tool-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("The rename_session MCP tool", () => {
  it("renames an existing Codex session and proves the new title by a readback", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-rename-tool-codex-"));
    roots.push(codexDir);
    const logPath = join(codexDir, "requests.jsonl");
    const previousLog = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const { client, server } = await connect(new Map([["codex", adapter]]));
    try {
      await adapter.init();
      const renamed = await client.callTool({
        name: "rename_session",
        arguments: { sessionId: "thread-1", harness: "codex", project: "Notice Place", goal: "голосовой секретарь", stage: "координация" },
      });
      expect(renamed.structuredContent).toMatchObject({
        ok: true,
        supported: true,
        sessionId: "thread-1",
        harness: "codex",
        previousTitle: null,
        title: "Notice Place | голосовой секретарь | координация",
        label: { project: "Notice Place", goal: "голосовой секретарь", stage: "координация" },
      });

      // The same session now carries the new title, and its id did not change.
      const info = await client.callTool({ name: "agent_info", arguments: { sessionId: "thread-1", harness: "codex" } });
      expect(info.structuredContent).toMatchObject({
        session: { id: "thread-1", title: "Notice Place | голосовой секретарь | координация" },
      });

      const raw = await readFile(logPath, "utf8");
      const methods = raw.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method);
      expect(methods).toContain("thread/name/set");
      expect(methods).not.toContain("thread/start");
      expect(methods).not.toContain("turn/start");
    } finally {
      await client.close();
      await server.close();
      await adapter.dispose();
      if (previousLog === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLog;
    }
  });

  it("renames with an exact title without touching the stored fields", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-rename-tool-title-"));
    roots.push(codexDir);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const { client, server } = await connect(new Map([["codex", adapter]]));
    try {
      await adapter.init();
      const renamed = await client.callTool({
        name: "rename_session",
        arguments: { sessionId: "thread-1", harness: "codex", title: "LHC | понятные планы | завершение релиза" },
      });
      expect(renamed.structuredContent).toMatchObject({ ok: true, title: "LHC | понятные планы | завершение релиза" });
    } finally {
      await client.close();
      await server.close();
      await adapter.dispose();
    }
  });

  it("reports an unknown session and a harness without a native rename as unsupported", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-rename-tool-unsupported-"));
    roots.push(codexDir);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const other: AgentSession = {
      id: "opencode-session", harness: "opencode", status: "idle", title: "OpenCode Fixture",
      cwd: "/tmp", hostId: "roomhacker-server-100", lastActivity: new Date(0).toISOString(), needsPermission: false,
    };
    const { client, server } = await connect(new Map([["codex", adapter], ["opencode", harnessWithoutRename(other)]]));
    try {
      await adapter.init();
      const unknown = await client.callTool({ name: "rename_session", arguments: { sessionId: "thread-missing", harness: "codex" } });
      expect(unknown.structuredContent).toMatchObject({ ok: false, supported: false });
      expect(String((unknown.structuredContent as { error?: string }).error)).toMatch(/not found/i);

      const unsupported = await client.callTool({ name: "rename_session", arguments: { sessionId: "opencode-session", harness: "opencode", title: "GPT Admin | история запусков | исправление UI" } });
      expect(unsupported.structuredContent).toMatchObject({ ok: false, supported: false });
      expect(String((unsupported.structuredContent as { error?: string }).error)).toMatch(/no native rename channel/i);
    } finally {
      await client.close();
      await server.close();
      await adapter.dispose();
    }
  });

  it("refuses an empty title when no field of the label is known", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-rename-tool-empty-"));
    roots.push(codexDir);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const { client, server } = await connect(new Map([["codex", adapter]]));
    try {
      await adapter.init();
      const refused = await client.callTool({ name: "rename_session", arguments: { sessionId: "thread-1", harness: "codex" } });
      expect(refused.structuredContent).toMatchObject({ ok: false, supported: true });
      expect(String((refused.structuredContent as { error?: string }).error)).toMatch(/title is required/i);
    } finally {
      await client.close();
      await server.close();
      await adapter.dispose();
    }
  });
});
