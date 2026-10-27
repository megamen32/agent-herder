import type { IncomingMessage, ServerResponse } from "node:http";
import { getDefaultMcpClientTokenStore } from "../mcp/client-token-store.js";
import { isMcpConnectionOwnerRequest, managedMcpConnectionUrl } from "./fleet-wiring.js";

const MAX_BODY_BYTES = 8 * 1024;
const NAME_LIMIT = 64;
const INPUT_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export async function handleMcpConnectionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: { configured: boolean; enabled: boolean },
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path !== "/api/mcp-connection") return false;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Vary", "Cookie, Origin");
  if (!await isMcpConnectionOwnerRequest(request)) return send(response, 401, { error: "owner_required" });
  if (request.method === "GET") {
    try {
      const url = managedMcpConnectionUrl();
      if (!url) return send(response, 503, { error: "managed_mcp_url_unavailable" });
      return send(response, 200, {
        url,
        configured: options.configured,
        enabled: options.enabled,
        tokens: await getDefaultMcpClientTokenStore().list(),
      });
    } catch {
      return send(response, 503, { error: "token_registry_unavailable" });
    }
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return send(response, 405, { error: "method_not_allowed" });
  }
  if (!isSameOriginPost(request)) return send(response, 403, { error: "same_origin_required" });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "application_json_required" });
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return send(response, message === "body_too_large" ? 413 : 400, { error: message });
  }
  const store = getDefaultMcpClientTokenStore();
  try {
    if (body.action === "issue") {
      if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > NAME_LIMIT
        || /[\u0000-\u001f\u007f]/.test(body.name)
        || typeof body.inputId !== "string" || !INPUT_ID_PATTERN.test(body.inputId)) {
        return send(response, 400, { error: "invalid_issue_request" });
      }
      const issued = await store.issue(body.name.trim(), body.inputId);
      return send(response, 201, { ...issued, inputId: body.inputId });
    }
    if (body.action === "revoke") {
      if (typeof body.id !== "string" || body.id.length > 64) return send(response, 400, { error: "invalid_revoke_request" });
      const record = await store.revoke(body.id);
      return record ? send(response, 200, { record }) : send(response, 404, { error: "token_not_found" });
    }
    return send(response, 400, { error: "unsupported_action" });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "issue_already_attempted") return send(response, 409, { error: code, record: (error as { record?: unknown }).record });
    if (code === "token_registry_full") return send(response, 409, { error: code });
    return send(response, 503, { error: "token_registry_unavailable" });
  }
}

function isSameOriginPost(request: IncomingMessage): boolean {
  try {
    const origin = new URL(request.headers.origin ?? "");
    const host = request.headers.host;
    return !!host && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash
      && origin.host.toLowerCase() === host.toLowerCase()
      && (origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)));
  } catch {
    return false;
  }
}

async function readBoundedJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) throw new Error("invalid_json");
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.end(JSON.stringify(body));
  return true;
}
