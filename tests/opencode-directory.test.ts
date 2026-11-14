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
      const reply = (data: unknown) => response.end(JSON.stringify({ data }));
      if (url.pathname === "/api/config") return reply({});
      if (url.pathname === "/api/session/active") {
        response.statusCode = statusCode;
        return reply({ ...sessions.get("active"), active: { type: status } });
      }
      if (url.pathname === "/api/permission/request") return reply([]);
      if (url.pathname === "/api/session" && request.method === "GET") return reply(scope === directory ? [sessions.get("active")] : []);
      if (url.pathname === "/api/session" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const parsed = JSON.parse(body) as { location?: { directory?: string } };
          const cwd = parsed.location?.directory;
          const id = cwd === directory ? "created-a" : "created-b";
          const value = { id, location: { directory: cwd }, title: "CI", time: { created, updated: created } };
          sessions.set(id, value);
          reply(value);
        });
        return;
      }
      const id = url.pathname.split("/")[3];
      const session = sessions.get(id);
      if (url.pathname === "/api/session/" + id && session && request.method === "GET") return reply(session);
      if (url.pathname === "/api/session/" + id + "/message" && session && request.method === "GET") {
        const rows = [{ type: "assistant", id: "msg_native-tool", sessionID: id, time: { created: created + 1000 }, info: { time: { created: created + 1000 } }, parts: [{ type: "tool", tool: "edit", state: { input: { filePath: "src/ci.ts" } } }] }];
        if (url.searchParams.get("order") === "asc") return response.end(JSON.stringify({ data: rows, cursor: { next: null } }));
        return reply(rows);
      }
      if (session) {
        if (url.pathname.endsWith("/fork") && request.method === "POST") return reply({ id: "forked", location: { directory: scope } });
        if (url.pathname.endsWith("/interrupt") && request.method === "POST") return reply({ interrupted: true });
        if (url.pathname.endsWith("/prompt") && request.method === "POST") return reply({ id: "msg_prompt", admitted: true });
        if (url.pathname.endsWith("/model") && request.method === "POST") return response.end();
      }
      response.statusCode = 404;
      return reply({ error: "wrong project context" });
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    return new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, protocol: "v2" });
  }

  it("uses the requested directory for discovery and actual busy status", async () => {
    const adapter = await fixture();
    expect(await adapter.listSessions({ cwd: directory })).toMatchObject([
      { id: "active", cwd: directory, status: "running", model: "minimax-coding-plan/MiniMax-M3" },
    ]);
    expect(requests.find((r) => r.path === "/api/session/active")?.directory).toBeNull();
  });

  it("hydrates a cold exact lookup with native activity, tool summary and millisecond time", async () => {
    const adapter = await fixture();
    expect(await adapter.getSession("active")).toMatchObject({
      status: "running", cwd: directory, model: "minimax-coding-plan/MiniMax-M3",
      lastMessage: "Инструмент: edit", lastActivity: new Date(created + 1000).toISOString(),
    });
    expect(requests.filter((r) => r.path.endsWith("/message"))).toEqual([
      { path: "/api/session/active/message", directory: null, method: "GET" },
    ]);
  });

  it("resolves native directory before a cold bounded message or raw transcript read", async () => {
    const adapter = await fixture();
    expect(await adapter.getSessionMessages("active", 3)).toMatchObject([
      { timestamp: new Date(created + 1000).toISOString(), parts: [{ type: "tool_call", name: "edit" }] },
    ]);
    const raw = await adapter.getRawTranscript("active");
    expect(raw?.source.location).toContain("/api/session/active/message");
    expect(requests.filter((r) => r.path.endsWith("/message")).every((r) => r.directory === null)).toBe(true);
  });

  it("keeps two created project contexts isolated for sync and queued delivery/model selection", async () => {
    const adapter = await fixture();
    const a = await adapter.createSession({ name: "a", cwd: directory });
    const b = await adapter.createSession({ name: "b", cwd: "/project/other" });
    expect(await adapter.sendMessage(a.id, { message: "fixture only", queue: true })).toMatchObject({ ok: true, admitted: true, admission: "accepted" });
    expect(await adapter.sendMessage(b.id, { message: "fixture only" })).toMatchObject({ ok: true, admission: "accepted" });
    expect(await adapter.changeModel(b.id, "minimax-coding-plan/MiniMax-M3")).toEqual({ ok: true });
    expect(requests.filter((r) => r.path.includes("created-")).every((r) => r.directory === null)).toBe(true);
  });

  it("carries the native parent directory into parent/children/fork/control endpoints", async () => {
    const adapter = await fixture();
    sessions.set("child", { id: "child", directory, parentID: "active" });
    expect((await adapter.getParent("child"))?.id).toBe("active");
    expect(await adapter.listChildren("active")).toEqual([]);
    expect(await adapter.forkSession("active")).toMatchObject({ ok: true, sessionId: "forked" });
    expect(await adapter.cancelTurn("active")).toMatchObject({ ok: true });
    for (const path of ["/api/session/active/fork", "/api/session/active/interrupt"]) {
      expect(requests.find((r) => r.path === path)?.directory).toBeNull();
    }
  });

  it("preserves retry activity and does not label a failed status read idle", async () => {
    const adapter = await fixture("retry");
    expect((await adapter.getSession("active"))?.status).toBe("running");
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const unavailable = await fixture("busy", 503);
    await expect(unavailable.getSession("active")).resolves.toBeNull();
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
