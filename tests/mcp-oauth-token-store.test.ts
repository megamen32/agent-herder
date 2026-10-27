import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuthTokenStore, MCP_OAUTH_OFFLINE_SCOPE, MCP_OAUTH_OWNER_SCOPE, pkceS256 } from "../src/mcp/oauth-token-store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-oauth-"));
  roots.push(root);
  let now = 1_798_000_000_000;
  const store = new McpOAuthTokenStore(join(root, "tokens.json"), () => now);
  const client = await store.registerClient("ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect");
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const state = "state-value-bound-to-the-callback";
  const transaction = await store.createAuthorizationTransaction({
    clientId: client.clientId, redirectUri: client.redirectUri, codeChallenge: pkceS256(verifier),
    resource: "https://agent.bezrabotnyi.com/mcp", scopes: [MCP_OAUTH_OWNER_SCOPE, MCP_OAUTH_OFFLINE_SCOPE], state,
  });
  const code = await store.approveAuthorizationTransaction({
    transaction, clientId: client.clientId, redirectUri: client.redirectUri, state, subject: "owner-fixture",
  });
  return { root, store, client, verifier, code, resource: "https://agent.bezrabotnyi.com/mcp", issuer: "https://agent.bezrabotnyi.com", setNow: (value: number) => { now = value; } };
}

describe("MCP OAuth token store", () => {
  it("binds code exchange to client, redirect, resource, and PKCE, then rotates refresh tokens", async () => {
    const value = await fixture();
    await expect(value.store.exchangeAuthorizationCode({ clientId: value.client.clientId, code: value.code, redirectUri: value.client.redirectUri, codeVerifier: "wrong-verifier-that-is-long-enough-0123456789", resource: value.resource, issuer: value.issuer })).rejects.toThrow("invalid_grant");
    const initial = await value.store.exchangeAuthorizationCode({ clientId: value.client.clientId, code: value.code, redirectUri: value.client.redirectUri, codeVerifier: value.verifier, resource: value.resource, issuer: value.issuer });
    expect(await value.store.verifyAccessToken(initial.accessToken, { issuer: value.issuer, audience: value.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toMatchObject({ clientId: value.client.clientId, subject: "owner-fixture" });
    expect(await value.store.verifyAccessToken(initial.accessToken, { issuer: value.issuer, audience: "https://other.example/mcp", requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeUndefined();
    expect(await value.store.verifyAccessToken(initial.accessToken, { issuer: "https://other.example", audience: value.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeUndefined();
    expect(await value.store.verifyAccessToken(initial.accessToken, { issuer: value.issuer, audience: value.resource, requiredScope: "agent-herder:admin" })).toBeUndefined();

    const renewed = await value.store.refresh({ clientId: value.client.clientId, refreshToken: initial.refreshToken, resource: value.resource, issuer: value.issuer });
    expect(renewed.refreshToken).not.toBe(initial.refreshToken);
    expect(await value.store.verifyAccessToken(renewed.accessToken, { issuer: value.issuer, audience: value.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeDefined();
    await expect(value.store.refresh({ clientId: value.client.clientId, refreshToken: initial.refreshToken, resource: value.resource, issuer: value.issuer })).rejects.toThrow("invalid_grant");
    expect(await value.store.verifyAccessToken(renewed.accessToken, { issuer: value.issuer, audience: value.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeUndefined();
  });

  it("revokes a grant through its refresh token and expires access tokens", async () => {
    const value = await fixture();
    const initial = await value.store.exchangeAuthorizationCode({ clientId: value.client.clientId, code: value.code, redirectUri: value.client.redirectUri, codeVerifier: value.verifier, resource: value.resource, issuer: value.issuer });
    await value.store.revoke({ clientId: value.client.clientId, token: initial.refreshToken });
    expect(await value.store.verifyAccessToken(initial.accessToken, { issuer: value.issuer, audience: value.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeUndefined();

    const second = await fixture();
    const tokens = await second.store.exchangeAuthorizationCode({ clientId: second.client.clientId, code: second.code, redirectUri: second.client.redirectUri, codeVerifier: second.verifier, resource: second.resource, issuer: second.issuer });
    second.setNow(1_798_000_000_000 + 15 * 60 * 1000);
    expect(await second.store.verifyAccessToken(tokens.accessToken, { issuer: second.issuer, audience: second.resource, requiredScope: MCP_OAUTH_OWNER_SCOPE })).toBeUndefined();
  });

  it("persists only token hashes with owner-only file permissions", async () => {
    const value = await fixture();
    const tokens = await value.store.exchangeAuthorizationCode({ clientId: value.client.clientId, code: value.code, redirectUri: value.client.redirectUri, codeVerifier: value.verifier, resource: value.resource, issuer: value.issuer });
    const contents = await readFile(join(value.root, "tokens.json"), "utf8");
    const metadata = await stat(join(value.root, "tokens.json"));
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(contents).not.toContain(tokens.accessToken);
    expect(contents).not.toContain(tokens.refreshToken);
    expect(contents).not.toContain(value.code);
    expect(contents).not.toContain(value.verifier);
    expect(contents).not.toContain("state-value-bound-to-the-callback");
  });
});
