import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWebServer } from "../src/web/server.js";
import { McpOAuthTokenStore, MCP_OAUTH_OWNER_SCOPE, pkceS256 } from "../src/mcp/oauth-token-store.js";
import { CHATGPT_REDIRECT_URI, MCP_OAUTH_AS_METADATA_PATH, MCP_OAUTH_ISSUER, MCP_OAUTH_PRM_PATH, MCP_OAUTH_PRM_URL, MCP_OAUTH_RESOURCE } from "../src/mcp/oauth-constants.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createWebServer>> = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ChatGPT MCP OAuth HTTP flow", () => {
  it("serves metadata, requires consent, exchanges and renews tokens, then calls the owner MCP resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-oauth-http-"));
    roots.push(root);
    const store = new McpOAuthTokenStore(join(root, "tokens.json"));
    const authContexts: unknown[] = [];
    const server = createWebServer({
      adapters: new Map(), converter: {} as never, mcpOAuthTokenStore: store, sessionObservationManagedExternally: true,
      mcpServerFactory: (context) => {
        authContexts.push(context?.authInfo);
        const mcp = new McpServer({ name: "owner-session-read-fixture", version: "1" });
        mcp.registerTool("session_read", { description: "Read a harmless test session", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "fixture-session-read" }] }));
        return mcp;
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const challenge = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(`resource_metadata="${MCP_OAUTH_PRM_URL}"`);

    const prm = await fetch(`${origin}${MCP_OAUTH_PRM_PATH}`);
    expect(prm.status).toBe(200);
    expect(prm.headers.get("content-type")).toContain("application/json");
    expect(await prm.json()).toMatchObject({ resource: MCP_OAUTH_RESOURCE, authorization_servers: [MCP_OAUTH_ISSUER], scopes_supported: [MCP_OAUTH_OWNER_SCOPE, "offline_access"] });
    const asMetadata = await fetch(`${origin}${MCP_OAUTH_AS_METADATA_PATH}`);
    expect(asMetadata.status).toBe(200);
    expect(await asMetadata.json()).toMatchObject({ issuer: MCP_OAUTH_ISSUER, registration_endpoint: `${MCP_OAUTH_ISSUER}/oauth/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });

    const registration = await fetch(`${origin}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT custom MCP", redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };
    const rejectedRegistration = await fetch(`${origin}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }),
    });
    expect(rejectedRegistration.status).toBe(400);

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const emptyScope = new URLSearchParams({
      client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT_URI, response_type: "code",
      code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: MCP_OAUTH_RESOURCE,
      scope: "", state: "empty-scope-state",
    });
    const emptyScopeResponse = await fetch(`${origin}/oauth/authorize?${emptyScope}`, { redirect: "manual" });
    const emptyScopeCallback = new URL(emptyScopeResponse.headers.get("location")!);
    expect(emptyScopeResponse.status).toBe(302);
    expect(emptyScopeCallback.searchParams.get("error")).toBe("invalid_scope");
    expect(emptyScopeCallback.searchParams.get("iss")).toBe(MCP_OAUTH_ISSUER);

    const state = "chatgpt-state-binding-274c";
    const params = new URLSearchParams({
      client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT_URI, response_type: "code",
      code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: MCP_OAUTH_RESOURCE,
      scope: "agent-herder:owner offline_access", state,
    });
    const authorization = await fetch(`${origin}/oauth/authorize?${params}`, { redirect: "manual" });
    expect(authorization.status).toBe(200);
    const page = await authorization.text();
    expect(page).toContain("полные текущие права владельца MCP");
    expect(page).toContain("ChatGPT custom MCP");
    const transaction = page.match(/name="transaction" value="([^"]+)"/)?.[1];
    expect(transaction).toBeTruthy();

    const form = new URLSearchParams({ transaction: transaction!, client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT_URI, state });
    const consent = await fetch(`${origin}/oauth/consent`, { method: "POST", redirect: "manual", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    expect(consent.status).toBe(303);
    const callback = new URL(consent.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(MCP_OAUTH_ISSUER);
    const code = callback.searchParams.get("code")!;

    const exchange = await fetch(`${origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: CHATGPT_REDIRECT_URI, code_verifier: verifier, resource: MCP_OAUTH_RESOURCE }),
    });
    expect(exchange.status).toBe(200);
    const initial = await exchange.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(initial.token_type).toBe("Bearer");

    const callMcp = async (accessToken: string) => {
      const mcpClient = new Client({ name: "chatgpt-oauth-test", version: "1" });
      clients.push(mcpClient);
      await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => accessToken } }));
      const result = await mcpClient.callTool({ name: "session_read", arguments: {} });
      return result.content;
    };
    expect(await callMcp(initial.access_token)).toEqual([{ type: "text", text: "fixture-session-read" }]);
    expect(authContexts.some((value) => (value as { clientId?: string })?.clientId === "agent-herder-owner-mcp")).toBe(true);

    const refresh = await fetch(`${origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: initial.refresh_token, resource: MCP_OAUTH_RESOURCE }),
    });
    expect(refresh.status).toBe(200);
    const renewed = await refresh.json() as { access_token: string; refresh_token: string };
    expect(renewed.refresh_token).not.toBe(initial.refresh_token);
    expect(await callMcp(renewed.access_token)).toEqual([{ type: "text", text: "fixture-session-read" }]);

    const revoke = await fetch(`${origin}/oauth/revoke`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, token: renewed.refresh_token, token_type_hint: "refresh_token" }),
    });
    expect(revoke.status).toBe(200);
    const denied = await fetch(`${origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${renewed.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }) });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("does not redirect an unsafe OAuth error callback or accept duplicate authorization fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-oauth-errors-"));
    roots.push(root);
    const store = new McpOAuthTokenStore(join(root, "tokens.json"));
    const server = createWebServer({ adapters: new Map(), converter: {} as never, mcpOAuthTokenStore: store, sessionObservationManagedExternally: true });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const badRedirect = await fetch(`${origin}/oauth/authorize?client_id=unknown&redirect_uri=https%3A%2F%2Fattacker.example%2F&state=x`, { redirect: "manual" });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.get("location")).toBeNull();
    const duplicate = await fetch(`${origin}/oauth/authorize?client_id=a&client_id=b`, { redirect: "manual" });
    expect(duplicate.status).toBe(400);
    expect(duplicate.headers.get("location")).toBeNull();
  });

  it("rejects OAuth bearer tokens with the wrong audience or a missing owner scope at the MCP boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-oauth-audience-"));
    roots.push(root);
    const path = join(root, "tokens.json");
    const store = new McpOAuthTokenStore(path);
    const client = await store.registerClient("ChatGPT", CHATGPT_REDIRECT_URI);
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const authorize = async (resource: string, state: string) => {
      const transaction = await store.createAuthorizationTransaction({
        clientId: client.clientId, redirectUri: CHATGPT_REDIRECT_URI, codeChallenge: pkceS256(verifier),
        resource, scopes: ["agent-herder:owner", "offline_access"], state,
      });
      const code = await store.approveAuthorizationTransaction({ transaction, clientId: client.clientId, redirectUri: CHATGPT_REDIRECT_URI, state, subject: "owner-fixture" });
      return store.exchangeAuthorizationCode({ clientId: client.clientId, code, redirectUri: CHATGPT_REDIRECT_URI, codeVerifier: verifier, resource, issuer: MCP_OAUTH_ISSUER });
    };
    const wrongAudience = await authorize("https://wrong.example/mcp", "audience-state");
    const firstServer = createWebServer({ adapters: new Map(), converter: {} as never, mcpOAuthTokenStore: store, sessionObservationManagedExternally: true });
    servers.push(firstServer);
    await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
    const firstOrigin = `http://127.0.0.1:${(firstServer.address() as { port: number }).port}`;
    const audienceDenied = await fetch(`${firstOrigin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${wrongAudience.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(audienceDenied.status).toBe(401);
    expect(audienceDenied.headers.get("www-authenticate")).toContain(MCP_OAUTH_PRM_URL);

    const wrongScope = await authorize(MCP_OAUTH_RESOURCE, "scope-state");
    const saved = JSON.parse(await readFile(path, "utf8")) as { grants: Array<{ id: string; audience: string; scopes: string[] }> };
    const wrongGrant = saved.grants.find((grant) => grant.audience === MCP_OAUTH_RESOURCE && grant.scopes.includes(MCP_OAUTH_OWNER_SCOPE));
    expect(wrongGrant).toBeTruthy();
    wrongGrant!.scopes = ["offline_access"];
    await writeFile(path, `${JSON.stringify(saved)}\n`);
    const reloadedStore = new McpOAuthTokenStore(path);
    const secondServer = createWebServer({ adapters: new Map(), converter: {} as never, mcpOAuthTokenStore: reloadedStore, sessionObservationManagedExternally: true });
    servers.push(secondServer);
    await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    const secondOrigin = `http://127.0.0.1:${(secondServer.address() as { port: number }).port}`;
    const scopeDenied = await fetch(`${secondOrigin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${wrongScope.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }) });
    expect(scopeDenied.status).toBe(401);
    expect(scopeDenied.headers.get("www-authenticate")).toContain(MCP_OAUTH_PRM_URL);
  });
});
