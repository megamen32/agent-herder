import type { IncomingMessage, ServerResponse } from "node:http";
import { isMcpConnectionOwnerRequest } from "./fleet-wiring.js";
import {
  CHATGPT_REDIRECT_URI, MCP_OAUTH_AS_METADATA_PATH, MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_CONSENT_PATH, MCP_OAUTH_ISSUER, MCP_OAUTH_PRM_PATH,
  MCP_OAUTH_REGISTER_PATH, MCP_OAUTH_RESOURCE, MCP_OAUTH_REVOKE_PATH,
  MCP_OAUTH_TOKEN_PATH,
} from "../mcp/oauth-constants.js";
import {
  getDefaultMcpOAuthTokenStore, MCP_OAUTH_OFFLINE_SCOPE, MCP_OAUTH_OWNER_SCOPE,
  MCP_OAUTH_SCOPES, type McpOAuthTokenStore,
} from "../mcp/oauth-token-store.js";

const MAX_BODY_BYTES = 12 * 1024;

type OAuthOptions = {
  issuer?: string;
  resource?: string;
  redirectUri?: string;
  store?: McpOAuthTokenStore;
  isOwnerRequest?: (request: IncomingMessage) => Promise<boolean>;
  ownerSubject?: string;
};

/** OAuth authorization server endpoints for the existing owner-authorized MCP resource. */
export async function handleMcpOAuthRequest(request: IncomingMessage, response: ServerResponse, options: OAuthOptions = {}): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const paths = [MCP_OAUTH_PRM_PATH, MCP_OAUTH_AS_METADATA_PATH, MCP_OAUTH_AUTHORIZE_PATH,
    MCP_OAUTH_CONSENT_PATH, MCP_OAUTH_REGISTER_PATH, MCP_OAUTH_TOKEN_PATH, MCP_OAUTH_REVOKE_PATH];
  if (!paths.includes(url.pathname)) return false;
  const issuer = options.issuer ?? MCP_OAUTH_ISSUER;
  const resource = options.resource ?? MCP_OAUTH_RESOURCE;
  const redirectUri = options.redirectUri ?? CHATGPT_REDIRECT_URI;
  const store = options.store ?? getDefaultMcpOAuthTokenStore();
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === MCP_OAUTH_PRM_PATH && request.method === "GET") {
    return json(response, 200, {
      resource,
      authorization_servers: [issuer],
      scopes_supported: [...MCP_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Agent Herder MCP",
    });
  }
  if (url.pathname === MCP_OAUTH_AS_METADATA_PATH && request.method === "GET") {
    return json(response, 200, {
      issuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${issuer}${MCP_OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${issuer}${MCP_OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${issuer}${MCP_OAUTH_REGISTER_PATH}`,
      revocation_endpoint: `${issuer}${MCP_OAUTH_REVOKE_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    });
  }
  if (url.pathname === MCP_OAUTH_AUTHORIZE_PATH && request.method === "GET") {
    return authorize(request, response, url, { issuer, resource, redirectUri, store, isOwnerRequest: options.isOwnerRequest ?? isMcpConnectionOwnerRequest });
  }
  if (url.pathname === MCP_OAUTH_CONSENT_PATH && request.method === "POST") {
    return consent(request, response, { issuer, redirectUri, store, isOwnerRequest: options.isOwnerRequest ?? isMcpConnectionOwnerRequest, ownerSubject: options.ownerSubject ?? "agent-herder-owner" });
  }
  if (url.pathname === MCP_OAUTH_REGISTER_PATH && request.method === "POST") return register(request, response, { store, redirectUri });
  if (url.pathname === MCP_OAUTH_TOKEN_PATH && request.method === "POST") return token(request, response, { issuer, resource, store });
  if (url.pathname === MCP_OAUTH_REVOKE_PATH && request.method === "POST") return revoke(request, response, store);
  response.setHeader("Allow", url.pathname === MCP_OAUTH_AUTHORIZE_PATH || url.pathname === MCP_OAUTH_PRM_PATH || url.pathname === MCP_OAUTH_AS_METADATA_PATH ? "GET" : "POST");
  return json(response, 405, { error: "method_not_allowed" });
}

async function authorize(request: IncomingMessage, response: ServerResponse, url: URL, options: {
  issuer: string; resource: string; redirectUri: string; store: McpOAuthTokenStore; isOwnerRequest: (request: IncomingMessage) => Promise<boolean>;
}): Promise<true> {
  const clientId = one(url.searchParams, "client_id");
  const callback = one(url.searchParams, "redirect_uri");
  const state = one(url.searchParams, "state");
  const client = clientId ? await options.store.getClient(clientId) : undefined;
  if (!client || callback !== options.redirectUri || callback !== client.redirectUri) return json(response, 400, { error: "invalid_client" });
  if (!state || state.length > 2048) return authorizationError(response, options.issuer, callback, "", "invalid_request");
  if (one(url.searchParams, "response_type") !== "code") return authorizationError(response, options.issuer, callback, state, "unsupported_response_type");
  const challenge = one(url.searchParams, "code_challenge");
  if (one(url.searchParams, "code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return authorizationError(response, options.issuer, callback, state, "invalid_request");
  }
  if (one(url.searchParams, "resource") !== options.resource) return authorizationError(response, options.issuer, callback, state, "invalid_target");
  const requested = one(url.searchParams, "scope");
  const scopes = url.searchParams.has("scope") ? (requested ?? "").split(/\s+/).filter(Boolean) : [MCP_OAUTH_OWNER_SCOPE, MCP_OAUTH_OFFLINE_SCOPE];
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !MCP_OAUTH_SCOPES.includes(scope as typeof MCP_OAUTH_SCOPES[number]))
    || !scopes.includes(MCP_OAUTH_OWNER_SCOPE) || !scopes.includes(MCP_OAUTH_OFFLINE_SCOPE)) {
    return authorizationError(response, options.issuer, callback, state, "invalid_scope");
  }
  if (!await options.isOwnerRequest(request)) return json(response, 401, { error: "owner_sso_required" });
  try {
    const transaction = await options.store.createAuthorizationTransaction({
      clientId: client.clientId, redirectUri: callback, codeChallenge: challenge,
      resource: options.resource, scopes, state,
    });
    return html(response, 200, consentPage({ clientName: client.clientName, clientId: client.clientId, callback, state, transaction, scopes }));
  } catch {
    return json(response, 503, { error: "oauth_authorization_unavailable" });
  }
}

async function consent(request: IncomingMessage, response: ServerResponse, options: {
  issuer: string; redirectUri: string; store: McpOAuthTokenStore; isOwnerRequest: (request: IncomingMessage) => Promise<boolean>; ownerSubject: string;
}): Promise<true> {
  if (!await options.isOwnerRequest(request)) return json(response, 401, { error: "owner_sso_required" });
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "form_urlencoded_required" });
  let form: URLSearchParams;
  try { form = new URLSearchParams((await readBody(request)).toString("utf8")); }
  catch (error) { return json(response, (error as Error).message === "body_too_large" ? 413 : 400, { error: "invalid_request" }); }
  const transaction = one(form, "transaction");
  const clientId = one(form, "client_id");
  const redirectUri = one(form, "redirect_uri");
  const state = one(form, "state");
  if (!transaction || !clientId || redirectUri !== options.redirectUri || !state) return json(response, 400, { error: "invalid_request" });
  try {
    const code = await options.store.approveAuthorizationTransaction({ transaction, clientId, redirectUri, state, subject: options.ownerSubject });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    callback.searchParams.set("iss", options.issuer);
    response.statusCode = 303;
    response.setHeader("Location", callback.toString());
    response.end();
    return true;
  } catch {
    return json(response, 400, { error: "invalid_authorization_transaction" });
  }
}

async function register(request: IncomingMessage, response: ServerResponse, options: { store: McpOAuthTokenStore; redirectUri: string }): Promise<true> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "application_json_required" });
  let body: Record<string, unknown>;
  try { body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }
  catch (error) { return json(response, (error as Error).message === "body_too_large" ? 413 : 400, { error: "invalid_client_metadata" }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.redirect_uris)
    || body.redirect_uris.length !== 1 || body.redirect_uris[0] !== options.redirectUri
    || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")
    || (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.length !== 2
      || !body.grant_types.includes("authorization_code") || !body.grant_types.includes("refresh_token")))
    || (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code"))
    || (body.application_type !== undefined && body.application_type !== "web")) {
    return json(response, 400, { error: "invalid_client_metadata" });
  }
  const requestedName = typeof body.client_name === "string" ? body.client_name.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : "";
  const clientName = requestedName || "ChatGPT custom MCP";
  try {
    const client = await options.store.registerClient(clientName, options.redirectUri);
    return json(response, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.clientName,
      redirect_uris: [client.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } catch {
    return json(response, 503, { error: "client_registration_unavailable" });
  }
}

async function token(request: IncomingMessage, response: ServerResponse, options: { issuer: string; resource: string; store: McpOAuthTokenStore }): Promise<true> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "form_urlencoded_required" });
  let form: URLSearchParams;
  try { form = new URLSearchParams((await readBody(request)).toString("utf8")); }
  catch (error) { return json(response, (error as Error).message === "body_too_large" ? 413 : 400, { error: "invalid_request" }); }
  const grantType = one(form, "grant_type");
  const clientId = one(form, "client_id");
  const resource = one(form, "resource");
  const requestedScope = form.has("scope") ? one(form, "scope") : undefined;
  if (!clientId || resource !== options.resource || form.has("client_secret") || form.has("client_assertion")
    || (form.has("scope") && requestedScope === undefined)) return json(response, 400, { error: "invalid_request" });
  try {
    const client = await options.store.getClient(clientId);
    if (!client) return json(response, 400, { error: "invalid_client" });
    if (grantType === "authorization_code") {
      const code = one(form, "code");
      const redirectUri = one(form, "redirect_uri");
      const codeVerifier = one(form, "code_verifier");
      if (!code || redirectUri !== client.redirectUri || !codeVerifier) return json(response, 400, { error: "invalid_grant" });
      return tokenResponse(response, await options.store.exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier, resource, issuer: options.issuer, ...(requestedScope !== undefined ? { scope: requestedScope } : {}) }));
    }
    if (grantType === "refresh_token") {
      const refreshToken = one(form, "refresh_token");
      if (!refreshToken) return json(response, 400, { error: "invalid_grant" });
      return tokenResponse(response, await options.store.refresh({ clientId, refreshToken, resource, issuer: options.issuer, ...(requestedScope !== undefined ? { scope: requestedScope } : {}) }));
    }
    return json(response, 400, { error: "unsupported_grant_type" });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "invalid_grant") return json(response, 400, { error: "invalid_grant" });
    return json(response, 503, { error: "token_service_unavailable" });
  }
}

async function revoke(request: IncomingMessage, response: ServerResponse, store: McpOAuthTokenStore): Promise<true> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "form_urlencoded_required" });
  let form: URLSearchParams;
  try { form = new URLSearchParams((await readBody(request)).toString("utf8")); }
  catch (error) { return json(response, (error as Error).message === "body_too_large" ? 413 : 400, { error: "invalid_request" }); }
  const clientId = one(form, "client_id");
  const tokenValue = one(form, "token");
  if (!clientId || !tokenValue || form.has("client_secret") || form.has("client_assertion")) return json(response, 400, { error: "invalid_request" });
  try { await store.revoke({ clientId, token: tokenValue }); }
  catch { return json(response, 503, { error: "revocation_service_unavailable" }); }
  response.statusCode = 200;
  response.end();
  return true;
}

function tokenResponse(response: ServerResponse, tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }): true {
  return json(response, 200, {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  });
}

function authorizationError(response: ServerResponse, issuer: string, redirectUri: string, state: string, error: string): true {
  const callback = new URL(redirectUri);
  callback.searchParams.set("error", error);
  if (state) callback.searchParams.set("state", state);
  callback.searchParams.set("iss", issuer);
  response.statusCode = 302;
  response.setHeader("Location", callback.toString());
  response.end();
  return true;
}

function consentPage(input: { clientName: string; clientId: string; callback: string; state: string; transaction: string; scopes: string[] }): string {
  const name = escapeHtml(input.clientName);
  const fields = ["transaction", "client_id", "redirect_uri", "state"].map((key) => {
    const value = key === "transaction" ? input.transaction : key === "client_id" ? input.clientId : key === "redirect_uri" ? input.callback : input.state;
    return `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`;
  }).join("");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Доступ к Agent Herder MCP</title><body><main><h1>Подключить Agent Herder</h1><p><strong>${name}</strong> запрашивает доступ к Agent Herder MCP.</p><p>Подключение получит полные текущие права владельца MCP — тот же набор операций, что у существующих owner Bearer клиентов, включая чтение сессий. Access token истекает через 15 минут; refresh token действует 30 дней и меняется при каждом обновлении. Доступ можно отозвать.</p><p>Запрошено: <code>${escapeHtml(input.scopes.join(" "))}</code></p><form method="post" action="${MCP_OAUTH_CONSENT_PATH}">${fields}<button type="submit">Разрешить подключение</button></form><p>Если вы не начинали подключение, закройте эту страницу.</p></main></body></html>`;
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  return values.length === 1 && values[0]!.length <= 4096 ? values[0]! : undefined;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): true {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
  return true;
}

function html(response: ServerResponse, status: number, value: string): true {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.end(value);
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}
