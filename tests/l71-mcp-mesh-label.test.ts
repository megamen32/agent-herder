import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSessionTools } from "../src/mcp/session-tools.js";
import { LocalHarnessMesh } from "../src/mesh/local.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { readSessionLabel, resetSessionLabelCache } from "../src/session-labels.js";
import type { GptAdminTransport } from "../src/mesh/gptadmin.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

/**
 * The metadata of a session and the native name of the same session.
 *
 * The metadata belongs to Herder and is stored by Herder itself. The native
 * name is an operation of the harness and only some harnesses have it. The
 * metadata is stored in both cases, and the answer tells the owner which of
 * the two outcomes happened.
 *
 * The words are the words of the panel (L69/L70): a stored label with an
 * unchanged name is a success, not a failure.
 */

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-l71-label-"));
  roots.push(root);
  // The label store of Herder itself, in a scratch file: the test never
  // touches the metadata of a live session.
  vi.stubEnv("AGENT_HERDER_SESSION_LABELS", join(root, "session-labels.json"));
  resetSessionLabelCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetSessionLabelCache();
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixtureSession(id: string, harness = "minimax-code"): AgentSession {
  return {
    id, harness, status: "idle", title: `Session ${id}`, cwd: "/repo", hostId: "host100",
    lastActivity: "2026-10-25T00:00:00.000Z", needsPermission: false, messageCount: 0,
  } as unknown as AgentSession;
}

/** A harness whose runtime has no native rename channel at all. */
function harnessWithoutRename(session: AgentSession): HarnessAdapter {
  return {
    type: "minimax-code", name: "MiniMax Code Fixture",
    async init() {}, async listSessions() { return [session]; },
    async getSession(id: string) { return id === session.id ? session : null; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  } as unknown as HarnessAdapter;
}

/** A harness with a native rename channel, the way Codex has one. */
function harnessWithRename(session: AgentSession, renames: string[], failure?: string): HarnessAdapter {
  return {
    type: "codex", name: "Codex Fixture",
    async init() {}, async listSessions() { return [session]; },
    async getSession(id: string) { return id === session.id ? session : null; },
    renameSession: async (id: string, options: { title: string }) => {
      renames.push(`${id} -> ${options.title}`);
      if (failure) return { ok: false, error: failure, previousTitle: "было" };
      return { ok: true, sessionId: id, previousTitle: "было", title: options.title };
    },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  } as unknown as HarnessAdapter;
}

interface RenameAnswer {
  ok?: boolean;
  supported?: boolean;
  sessionId?: string;
  harness?: string;
  hostId?: string;
  renamed?: boolean;
  previousTitle?: string | null;
  title?: string;
  nativeTitle?: string;
  renameError?: string;
  error?: string;
  label?: { project?: string; goal?: string; stage?: string };
}

async function connectMcp(adapters: Map<string, HarnessAdapter>, transport?: GptAdminTransport): Promise<Client> {
  const events = new HerderEventBus();
  const server = new McpServer({ name: "l71-mcp-label", version: "1" });
  registerSessionTools(server, { adapters, jobs: new HerderJobRegistry(events), events, ...(transport ? { transport } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l71-mcp-label-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

async function callRename(client: Client, args: Record<string, unknown>): Promise<{ answer: RenameAnswer; text: string }> {
  const result = await client.callTool({ name: "rename_session", arguments: args });
  const text = result.content.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n");
  return { answer: result.structuredContent as RenameAnswer, text };
}

function meshOf(adapters: Map<string, HarnessAdapter>, hostId = "host100"): LocalHarnessMesh {
  return new LocalHarnessMesh({ hostId, adapters, ledgerPath: join(roots[roots.length - 1] ?? tmpdir(), "mesh-receipts.json") });
}

describe("the MCP rename of a harness without a native rename channel", () => {
  it("stores the metadata and says plainly that the name did not change", async () => {
    const session = fixtureSession("mvs-1");
    const client = await connectMcp(new Map([["minimax-code", harnessWithoutRename(session)]]));
    const { answer, text } = await callRename(client, {
      sessionId: "mvs-1", harness: "minimax-code",
      project: "Herder", goal: "починить панель", stage: "приёмка",
    });
    // The metadata is saved: the write does not depend on the rename.
    expect(answer.ok).toBe(true);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.goal).toBe("починить панель");
    expect(answer.label?.stage).toBe("приёмка");
    // The answer does not pretend that a rename happened.
    expect(answer.renamed).toBe(false);
    expect(answer.renameError).toContain("нет нативного канала переименования");
    expect(answer.nativeTitle).toBeUndefined();
    expect(answer.error).toBeUndefined();
    // The name that was composed is still the name that was asked for.
    expect(answer.title).toBe("починить панель | Herder");
    // The words are the words of the panel.
    expect(text).toContain("Метка сохранена. Имя сессии не изменилось");
    // The metadata is really stored, not only reported.
    expect(await readSessionLabel("minimax-code", "mvs-1")).toMatchObject({
      project: "Herder", goal: "починить панель", stage: "приёмка",
    });
  });

  it("keeps the stored metadata when the native rename of the harness fails", async () => {
    const renames: string[] = [];
    const session = fixtureSession("mvs-2", "codex");
    const client = await connectMcp(new Map([["codex", harnessWithRename(session, renames, "канал переименования занят")]]));
    const { answer, text } = await callRename(client, {
      sessionId: "mvs-2", harness: "codex", project: "Herder", stage: "диагностика",
    });
    // The metadata is not lost because the rename failed.
    expect(answer.ok).toBe(true);
    expect(answer.label?.project).toBe("Herder");
    expect(answer.label?.stage).toBe("диагностика");
    expect(answer.renamed).toBe(false);
    expect(answer.renameError).toBe("канал переименования занят");
    expect(answer.nativeTitle).toBeUndefined();
    expect(text).toContain("Метка сохранена. Имя сессии не изменилось");
    expect(renames).toHaveLength(1);
    expect(await readSessionLabel("codex", "mvs-2")).toMatchObject({ project: "Herder", stage: "диагностика" });
  });
});

describe("the MCP rename of a harness with a native rename channel", () => {
  it("renames the session and stores the metadata", async () => {
    const renames: string[] = [];
    const session = fixtureSession("s-10", "codex");
    const client = await connectMcp(new Map([["codex", harnessWithRename(session, renames)]]));
    const { answer, text } = await callRename(client, {
      sessionId: "s-10", harness: "codex",
      project: "Herder", goal: "починить панель", stage: "приёмка",
    });
    expect(answer.ok).toBe(true);
    expect(answer.renamed).toBe(true);
    expect(answer.renameError).toBeUndefined();
    expect(answer.nativeTitle).toBe("починить панель | Herder");
    expect(answer.title).toBe("починить панель | Herder");
    expect(answer.previousTitle).toBe("было");
    expect(text).toContain("Сохранено. Название сессии");
    // The native path of the harness wrote the name.
    expect(renames).toEqual(["s-10 -> починить панель | Herder"]);
    expect(await readSessionLabel("codex", "s-10")).toMatchObject({
      project: "Herder", goal: "починить панель", stage: "приёмка",
    });
  });
});

describe("the honest refusals of the MCP rename", () => {
  it("refuses a harness that is not on this node and stores nothing", async () => {
    const session = fixtureSession("s-11");
    const client = await connectMcp(new Map([["minimax-code", harnessWithoutRename(session)]]));
    const { answer } = await callRename(client, { sessionId: "s-11", harness: "claude", project: "Herder" });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("was not found");
    expect(answer.renamed).toBeUndefined();
    // Nothing was stored for a session that is not here.
    expect(await readSessionLabel("claude", "s-11")).toEqual({});
  });

  it("refuses a request that carries no name at all", async () => {
    const renames: string[] = [];
    const session = fixtureSession("s-12", "codex");
    const client = await connectMcp(new Map([["codex", harnessWithRename(session, renames)]]));
    const { answer } = await callRename(client, { sessionId: "s-12", harness: "codex" });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("title is required");
    expect(renames).toEqual([]);
  });
});

describe("the MCP rename of a session of another machine", () => {
  const peer = (reply: unknown): GptAdminTransport => ({
    async discover() { return {}; },
    async schema() { return {}; },
    async call() { return { content: [{ type: "text", text: JSON.stringify(reply) }] }; },
  } as unknown as GptAdminTransport);

  it("keeps the stored metadata of a peer without a native rename channel", async () => {
    const session = fixtureSession("mvs-remote");
    const client = await connectMcp(new Map([["minimax-code", harnessWithoutRename(session)]]), peer({
      state: "unsupported", renamed: false, hostId: "peer-44", harness: "minimax-code", nativeSessionId: "mvs-remote",
      previousTitle: null, title: "Herder | приёмка",
      renameError: "У среды 'minimax-code' нет нативного канала переименования: имя сессии осталось прежним.",
      label: { project: "Herder", stage: "приёмка" },
    }));
    const { answer, text } = await callRename(client, { sessionId: "mvs-remote", harness: "minimax-code", hostId: "peer-44", project: "Herder", stage: "приёмка" });
    expect(answer.ok).toBe(true);
    expect(answer.renamed).toBe(false);
    expect(answer.renameError).toContain("нет нативного канала переименования");
    expect(answer.label?.project).toBe("Herder");
    expect(text).toContain("Метка сохранена. Имя сессии не изменилось");
  });

  it("keeps the honest refusal of an older peer that cannot rename", async () => {
    const session = fixtureSession("mvs-old");
    const client = await connectMcp(new Map([["minimax-code", harnessWithoutRename(session)]]), peer({
      state: "unsupported", hostId: "peer-44", harness: "minimax-code", nativeSessionId: "mvs-old",
      reason: "native_rename_unsupported",
    }));
    const { answer } = await callRename(client, { sessionId: "mvs-old", harness: "minimax-code", hostId: "peer-44", project: "Herder" });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("cannot rename");
    expect(answer.renamed).toBeUndefined();
  });
});

describe("the mesh rename of a harness without a native rename channel", () => {
  it("stores the metadata and says plainly that the name did not change", async () => {
    const session = fixtureSession("mvs-mesh-1");
    const mesh = meshOf(new Map([["minimax-code", harnessWithoutRename(session)]]));
    const receipt = await mesh.rename({
      target: { hostId: "host100", harness: "minimax-code", nativeSessionId: "mvs-mesh-1" },
      project: "Herder", goal: "починить метку", stage: "приёмка",
    });
    expect(receipt.renamed).toBe(false);
    expect(receipt.renameError).toContain("нет нативного канала переименования");
    expect(receipt.label).toMatchObject({ project: "Herder", goal: "починить метку", stage: "приёмка" });
    expect(receipt.title).toBe("починить метку | Herder");
    // The words are the words of the panel.
    expect(receipt.message).toContain("Метка сохранена. Имя сессии не изменилось");
    expect(await readSessionLabel("minimax-code", "mvs-mesh-1")).toMatchObject({ project: "Herder" });
  });

  it("keeps the stored metadata when the native rename fails", async () => {
    const renames: string[] = [];
    const session = fixtureSession("mvs-mesh-2", "codex");
    const mesh = meshOf(new Map([["codex", harnessWithRename(session, renames, "канал переименования занят")]]));
    const receipt = await mesh.rename({
      target: { hostId: "host100", harness: "codex", nativeSessionId: "mvs-mesh-2" },
      project: "Herder", stage: "диагностика",
    });
    expect(receipt.renamed).toBe(false);
    expect(receipt.renameError).toBe("канал переименования занят");
    expect(receipt.label).toMatchObject({ project: "Herder", stage: "диагностика" });
    expect(receipt.previousTitle).toBe("было");
    expect(receipt.message).toContain("Метка сохранена. Имя сессии не изменилось");
    expect(await readSessionLabel("codex", "mvs-mesh-2")).toMatchObject({ project: "Herder" });
  });

  it("renames the session and stores the metadata", async () => {
    const renames: string[] = [];
    const session = fixtureSession("mvs-mesh-3", "codex");
    const mesh = meshOf(new Map([["codex", harnessWithRename(session, renames)]]));
    const receipt = await mesh.rename({
      target: { hostId: "host100", harness: "codex", nativeSessionId: "mvs-mesh-3" },
      project: "Herder", goal: "починить метку", stage: "приёмка",
    });
    expect(receipt.renamed).toBe(true);
    expect(receipt.state).toBe("renamed");
    expect(receipt.renameError).toBeUndefined();
    expect(receipt.nativeTitle).toBe("починить метку | Herder");
    expect(receipt.previousTitle).toBe("было");
    expect(receipt.message).toContain("Сохранено. Название сессии");
    expect(renames).toEqual(["mvs-mesh-3 -> починить метку | Herder"]);
    expect(await readSessionLabel("codex", "mvs-mesh-3")).toMatchObject({ project: "Herder" });
  });
});

describe("the honest refusals of the mesh rename", () => {
  it("refuses a session of another machine", async () => {
    const session = fixtureSession("mvs-mesh-4");
    const mesh = meshOf(new Map([["minimax-code", harnessWithoutRename(session)]]));
    const receipt = await mesh.rename({
      target: { hostId: "host88", harness: "minimax-code", nativeSessionId: "mvs-mesh-4" },
      project: "Herder",
    });
    expect(receipt.state).toBe("not_attempted");
    expect(receipt.reason).toBe("native_host_identity_mismatch");
    expect(receipt.renamed).toBeUndefined();
    expect(await readSessionLabel("minimax-code", "mvs-mesh-4")).toEqual({});
  });

  it("refuses a harness that is not registered", async () => {
    const mesh = meshOf(new Map());
    const receipt = await mesh.rename({
      target: { hostId: "host100", harness: "minimax-code", nativeSessionId: "mvs-mesh-5" },
      project: "Herder",
    });
    expect(receipt.state).toBe("not_attempted");
    expect(receipt.reason).toBe("adapter_not_registered");
    expect(receipt.renamed).toBeUndefined();
  });

  it("refuses a session that is not there", async () => {
    const session = fixtureSession("mvs-mesh-6");
    const mesh = meshOf(new Map([["minimax-code", harnessWithoutRename(session)]]));
    const receipt = await mesh.rename({
      target: { hostId: "host100", harness: "minimax-code", nativeSessionId: "absent" },
      project: "Herder",
    });
    expect(receipt.state).toBe("not_found");
    expect(receipt.reason).toBe("native_session_not_found");
    expect(receipt.renamed).toBeUndefined();
    expect(await readSessionLabel("minimax-code", "absent")).toEqual({});
  });
});
