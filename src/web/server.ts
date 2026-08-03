import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HarnessType } from "session-convert";
import { LineageStore } from "../lineage-store.js";
import { SessionNotFoundError, SessionSupervisor } from "../session-supervisor.js";
import type { AgentSession, HarnessAdapter } from "../types/index.js";
import type { AgentHerderSessionConverter, ConvertSessionInput } from "../session-convert.js";
import { HumanRequestRegistry } from "../human-request/index.js";
import { convertHermesExport } from "../hermes-conversion.js";

export interface WebDependencies {
  adapters: Map<string, HarnessAdapter>;
  converter: Pick<AgentHerderSessionConverter, "convert"> & Partial<Pick<AgentHerderSessionConverter, "read">>;
  lineageStore?: LineageStore;
  humanRequests?: HumanRequestRegistry;
}

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "index.html");

export function createWebServer(dependencies: WebDependencies): Server {
  const supervisor = new SessionSupervisor(dependencies.adapters, dependencies.converter, dependencies.lineageStore);
  return createServer(async (request, response) => {
    try {
      await route(request, response, supervisor, dependencies.humanRequests);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      sendJson(response, 502, { error: (err as Error).message });
    }
  });
}

async function route(request: IncomingMessage, response: ServerResponse, supervisor: SessionSupervisor, humanRequests?: HumanRequestRegistry): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/internal/human-requests/sss-completion") {
    if (!humanRequests) return sendJson(response, 503, { error: "Human Request registry is disabled" });
    const body = await readJson(request);
    if (body.event !== "sss.secret_input.completed" || body.event_version !== 1 || body.status !== "completed" ||
      !isUuid(body.request_id) || !isUuid(body.result_ref)) {
      return sendJson(response, 400, { error: "invalid opaque SSS completion event" });
    }
    const pending = await humanRequests.get(body.request_id);
    if (!pending || pending.kind !== "secret" || pending.status !== "pending") {
      return sendJson(response, 409, { error: "SSS completion is valid only for a pending Ask Secret request" });
    }
    const record = await humanRequests.resolve(body.request_id, { continuation: "resume", resolutionRef: body.result_ref });
    return sendJson(response, 202, { request_id: record.requestId, status: record.status, continuation: record.continuation });
  }
  if (request.method === "GET" && url.pathname === "/") {
    const html = await readFile(htmlPath, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const sessions = await supervisor.listSessions({
      harness: url.searchParams.get("harness") || undefined,
      status: url.searchParams.get("status") || undefined,
      cwd: url.searchParams.get("cwd") || undefined,
    });
    sendJson(response, 200, { sessions });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string") {
      return sendJson(response, 400, { error: "harness, name, and cwd are required" });
    }
    const result = await supervisor.createNamedSession({ harness: body.harness, name: body.name, cwd: body.cwd });
    return sendNamedSessionResult(response, result);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/new-or-resume") {
    const body = await readJson(request);
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string" || typeof body.message !== "string") {
      return sendJson(response, 400, { error: "harness, name, cwd, and message are required" });
    }
    if (body.mode !== undefined && body.mode !== "queue" && body.mode !== "sync") {
      return sendJson(response, 400, { error: "mode must be queue or sync" });
    }
    const result = await supervisor.newOrResumeNamedSession({
      harness: body.harness,
      name: body.name,
      cwd: body.cwd,
      message: body.message,
      mode: body.mode as "queue" | "sync" | undefined,
    });
    return sendNamedSessionResult(response, result);
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    const session = await supervisor.getSession(decodeURIComponent(sessionMatch[1]), decodeURIComponent(sessionMatch[2]));
    if (!session) return sendJson(response, 404, { error: "Session not found" });
    return sendJson(response, 200, { session });
  }
  const detailsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/details$/);
  if (detailsMatch && request.method === "GET") {
    const limitValue = Number(url.searchParams.get("limit") || "3");
    const history = url.searchParams.get("history") as "auto" | "acp" | "files" | null;
    const details = await supervisor.getSessionDetails(
      decodeURIComponent(detailsMatch[1]),
      decodeURIComponent(detailsMatch[2]),
      { limit: Number.isFinite(limitValue) ? limitValue : 3, history: history || "auto" },
    );
    return sendJson(response, 200, details);
  }
  const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/(resume|message|stop|cancel|recover|fork|model|permissions\/([^/]+))$/);
  if (actionMatch && request.method === "POST") {
    const body = await readJson(request);
    const harness = decodeURIComponent(actionMatch[1]);
    const id = decodeURIComponent(actionMatch[2]);
    const action = actionMatch[3];
    if (action === "resume") {
      return sendOperationResult(response, await supervisor.resumeSession(harness, id, optionalString(body.message)));
    }
    if (action === "stop") {
      return sendOperationResult(response, await supervisor.stopSession(harness, id));
    }
    if (action === "cancel") {
      return sendOperationResult(response, await supervisor.cancelTurn(harness, id));
    }
    if (action === "recover") {
      return sendOperationResult(response, await supervisor.recoverSession(harness, id, optionalString(body.message)));
    }
    if (action === "fork") {
      return sendOperationResult(response, await supervisor.forkSession(harness, id, optionalString(body.message)));
    }
    if (action === "model") {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        return sendJson(response, 400, { error: "model must be a non-empty string" });
      }
      return sendOperationResult(response, await supervisor.changeModel(harness, id, body.model));
    }
    if (action.startsWith("permissions/")) {
      if (body.response !== "allow" && body.response !== "deny") {
        return sendJson(response, 400, { error: "response must be allow or deny" });
      }
      return sendOperationResult(response, await supervisor.respondPermission(
        harness,
        id,
        decodeURIComponent(actionMatch[4]),
        body.response,
      ));
    }
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return sendJson(response, 400, { error: "message must be a non-empty string" });
    }
    return sendOperationResult(response, await supervisor.sendMessage(harness, id, {
      message: body.message,
      queue: body.mode === "queue",
      steer: body.mode === "steer",
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/conversions") {
    const body = await readJson(request);
    if (typeof body.sessionId !== "string" || typeof body.from !== "string" || typeof body.to !== "string") {
      return sendJson(response, 400, { error: "sessionId, from, and to are required" });
    }
    const input: ConvertSessionInput = {
      sessionId: body.sessionId,
      from: body.from as HarnessType,
      to: body.to as HarnessType,
      projectPath: optionalString(body.projectPath),
      searchPaths: Array.isArray(body.searchPaths) ? body.searchPaths.filter((path): path is string => typeof path === "string") : undefined,
    };
    const result = await supervisor.convertSession(input);
    return sendJson(response, result.success ? 200 : 502, result);
  }
  if (request.method === "POST" && url.pathname === "/api/conversions/hermes-export") {
    const body = await readJson(request);
    if ((body.target !== "codex" && body.target !== "opencode" && body.target !== "claude") || body.export === undefined) {
      return sendJson(response, 400, { error: "target (codex, opencode, or claude) and export are required" });
    }
    const result = convertHermesExport({ target: body.target, export: body.export });
    return sendJson(response, result.conversation ? 200 : 422, result);
  }

  sendJson(response, 404, { error: "Not found" });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendOperationResult(response: ServerResponse, result: { ok: boolean; error?: string; sessionId?: string }): void {
  sendJson(response, result.ok ? 200 : 502, result);
}

function sendNamedSessionResult(
  response: ServerResponse,
  result: { ok: boolean; error?: string },
): void {
  const conflict = result.error?.startsWith("Ambiguous named session") || result.error?.includes("already exists");
  sendJson(response, result.ok ? 200 : conflict ? 409 : 502, result);
}
