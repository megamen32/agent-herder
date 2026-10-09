import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { listAgentsResult } from "../src/mcp-tools/handlers.js";
import type { HarnessAdapter } from "../src/types/index.js";

describe("OpenCode project directory readback", () => {
  const directory = "/project/active";
  const created = Date.UTC(2026, 9, 9, 11);
  let server: Server | undefined;
  const requests: Array<{ path: string; directory: string | null; method: string }> = [];
  const sessions = new Map<string, Record<string, unknown>>();

  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    requests.length = 0;
    sessions.clear();
  });

  async function fixture(status = "busy", statusCode = 200) {
    sessions.set("active", { id: "active", directory, title: "CI", model: { providerID: "minimax-coding-plan", id: "MiniMax-M3" }, time: { created, updated: created } });
    server = createServer((request, response) => {
      const url = new URL(request.url!, "http://fixture");
      const scope = url.searchParams.get("directory");
      requests.push({ path: url.pathname, directory: scope, method: request.method! });
      response.setHeader("content-type", "application/json");
      const reply = (data: unknown) => response.end(JSON.stringify(data));
      if (url.pathname === "/session/status") {
        response.statusCode = statusCode;
        return reply(scope === directory ? { active: { type: status } } : {});
      }
      if (url.pathname === "/session" && request.method === "GET") return reply(scope === directory ? [sessions.get("active")] : []);
      if (url.pathname === "/session" && request.method === "POST") {
        const id = scope === directory ? "created-a" : "created-b";
        const value = { id, directory: scope };
        sessions.set(id, value);
        return reply(value);
      }
      const id = url.pathname.split("/")[url.pathname.startsWith("/api/") ? 3 : 2];
      const session = sessions.get(id);
      if (url.pathname === `/session/${id}` && session) return reply(session);
      if (session && scope === session.directory) {
        if (url.pathname.endsWith("/message") && request.method === "GET") return reply([
          { info: { id: "native-tool", role: "assistant", time: { created: created + 1000 } }, parts: [{ type: "tool", tool: "edit", state: { input: { filePath: "src/ci.ts" } } }] },
        ]);
        if (url.pathname.endsWith("/children")) return reply([]);
        if (url.pathname.endsWith("/fork")) return reply({ id: "forked", directory: scope });
        if (request.method === "POST") return reply({ accepted: true });
      }
      response.statusCode = 404;
      return reply({ error: "wrong project context" });
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    return new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  }

  it("uses the requested directory for discovery and actual busy status", async () => {
    const adapter = await fixture();
    expect(await adapter.listSessions({ cwd: directory })).toMatchObject([
      { id: "active", cwd: directory, status: "running", model: "minimax-coding-plan/MiniMax-M3" },
    ]);
    expect(requests.find((r) => r.path === "/session/status")?.directory).toBe(directory);
  });

  it("hydrates a cold exact lookup with native activity, tool summary and millisecond time", async () => {
    const adapter = await fixture();
    expect(await adapter.getSession("active")).toMatchObject({
      status: "running", cwd: directory, model: "minimax-coding-plan/MiniMax-M3",
      lastMessage: "Инструмент: edit", lastActivity: new Date(created + 1000).toISOString(),
    });
    expect(requests.filter((r) => r.path.endsWith("/message"))).toEqual([
      { path: "/session/active/message", directory, method: "GET" },
    ]);
  });

  it("resolves native directory before a cold bounded message or raw transcript read", async () => {
    const adapter = await fixture();
    expect(await adapter.getSessionMessages("active", 3)).toMatchObject([
      { timestamp: new Date(created + 1000).toISOString(), parts: [{ type: "tool_call", name: "edit" }] },
    ]);
    const raw = await adapter.getRawTranscript("active");
    expect(raw?.source.location).toContain("/session/active/message");
    expect(requests.filter((r) => r.path.endsWith("/message")).every((r) => r.directory === directory)).toBe(true);
  });

  it("keeps two created project contexts isolated for sync and queued delivery/model selection", async () => {
    const adapter = await fixture();
    const a = await adapter.createSession({ name: "a", cwd: directory });
    const b = await adapter.createSession({ name: "b", cwd: "/project/other" });
    expect(await adapter.sendMessage(a.id, { message: "fixture only", queue: true })).toEqual({ ok: true, error: undefined });
    expect(await adapter.sendMessage(b.id, { message: "fixture only" })).toEqual({ ok: true });
    expect(await adapter.changeModel(b.id, "minimax-coding-plan/MiniMax-M3")).toEqual({ ok: true });
    expect(requests.filter((r) => r.path.includes("created-")).map((r) => r.directory)).toEqual([directory, "/project/other", "/project/other"]);
  });

  it("carries the native parent directory into parent/children/fork/control endpoints", async () => {
    const adapter = await fixture();
    sessions.set("child", { id: "child", directory, parentID: "active" });
    expect((await adapter.getParent("child"))?.id).toBe("active");
    expect(await adapter.listChildren("active")).toEqual([]);
    expect(await adapter.forkSession("active")).toMatchObject({ ok: true, sessionId: "forked" });
    expect(await adapter.cancelTurn("active")).toMatchObject({ ok: true });
    for (const path of ["/session/active/children", "/session/active/fork", "/session/active/interrupt"]) {
      expect(requests.find((r) => r.path === path)?.directory).toBe(directory);
    }
  });

  it("preserves retry activity and does not label a failed status read idle", async () => {
    const adapter = await fixture("retry");
    expect((await adapter.getSession("active"))?.status).toBe("running");
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const unavailable = await fixture("busy", 503);
    await expect(unavailable.getSession("active")).rejects.toThrow("status read failed: HTTP 503");
  });

  it("forwards folder only to OpenCode while preserving bounded discovery", async () => {
    const adapter = await fixture();
    const list = vi.spyOn(adapter, "listSessions");
    const other = { type: "codex", listSessions: vi.fn(async () => []) } as unknown as HarnessAdapter;
    const maps = new Map<string, HarnessAdapter>([["opencode", adapter], ["codex", other]]);
    expect((await listAgentsResult(maps, { harness: "all", folder: directory })).sessions).toMatchObject([{ id: "active", status: "running" }]);
    expect(list).toHaveBeenLastCalledWith({ limit: 20, cwd: directory });
    expect(other.listSessions).toHaveBeenCalledWith({ limit: 20 });
    await listAgentsResult(maps, { harness: "opencode" });
    expect(list).toHaveBeenLastCalledWith({ limit: 20 });
  });
});
