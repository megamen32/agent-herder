// Run after npm run build. Uses only two loopback servers and a temporary store.
// Supply PLAYWRIGHT_MODULE for an existing playwright-core installation if needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "agent-herder-oauth-browser-"));
for (const [name, file] of Object.entries({
  AGENT_HERDER_DEFERRED_MESSAGES: "deferred.json",
  AGENT_HERDER_INDEXING_SETTINGS: "indexing.json",
  AGENT_HERDER_HUMAN_STOP_STORE: "stops.json",
  AGENT_HERDER_COORDINATION_NOTES: "coordination.json",
  AGENT_HERDER_NATIVE_STOCK_CASES_PATH: "stock.json",
  MINIMAX_CODE_RUNTIME_DB: "runtime.sqlite",
  CODEX_HOME: "codex-home",
})) process.env[name] = join(root, file);
process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = root;
process.env.AGENT_HERDER_FLEET_PEERS = "[]";

let browser, issuerServer, callbackServer;
const checks = {};
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
  const dist = pathToFileURL(resolve(process.env.OAUTH_DIST_DIR || "dist") + "/");
  const { handleMcpOAuthRequest } = await import(new URL("web/mcp-oauth-api.js", dist));
  const { McpOAuthTokenStore, pkceS256 } = await import(new URL("mcp/oauth-token-store.js", dist));
  const store = new McpOAuthTokenStore(join(root, "dummy-tokens.json"));
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const state = 'isolated-state-&<"test">';
  let issuer, redirectUri, client, callbackCount = 0, callbackError, refererPresent = false;
  callbackServer = createServer(async (request, response) => {
    const url = new URL(request.url, redirectUri);
    if (url.pathname !== "/connector_platform_oauth_redirect") { response.statusCode = 404; response.end(); return; }
    try {
      callbackCount++;
      refererPresent = Boolean(request.headers.referer);
      assert.equal(url.pathname, "/connector_platform_oauth_redirect");
      assert.equal(url.searchParams.get("state"), state);
      assert.equal(url.searchParams.get("iss"), issuer);
      const args = { clientId: client.clientId, code: url.searchParams.get("code"),
        redirectUri, codeVerifier: verifier, resource: issuer + "/mcp", issuer };
      await assert.rejects(store.exchangeAuthorizationCode({ ...args, codeVerifier: "x".repeat(64) }), /invalid_grant/);
      checks.wrongPkceRejected = true;
      await store.exchangeAuthorizationCode(args);
      checks.validPkceExchanged = true;
      await assert.rejects(store.exchangeAuthorizationCode(args), /invalid_grant/);
      checks.codeReplayRejected = true;
      response.end("Isolated callback completed");
    } catch (error) {
      callbackError = error;
      response.statusCode = 500;
      response.end("Fixture callback failed");
    }
  });
  issuerServer = createServer(async (request, response) => {
    if (!await handleMcpOAuthRequest(request, response, {
      store, issuer, resource: issuer + "/mcp", redirectUri,
    })) { response.statusCode = 404; response.end(); }
  });
  await Promise.all([issuerServer, callbackServer].map(server =>
    new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  issuer = "http://127.0.0.1:" + issuerServer.address().port;
  redirectUri = "http://127.0.0.1:" + callbackServer.address().port + "/connector_platform_oauth_redirect";
  client = await store.registerClient("Isolated dummy browser client", redirectUri);
  browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  let cspErrors = 0;
  page.on("console", message => { if (message.text().includes("Content Security Policy")) cspErrors++; });
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri,
    response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256",
    resource: issuer + "/mcp", scope: "agent-herder:owner", state });
  const authorization = await page.goto(issuer + "/oauth/authorize?" + params);
  const strictCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  assert.equal(authorization.headers()["content-security-policy"], strictCsp);
  const fields = await page.locator("form input").evaluateAll(inputs => inputs.map(input => [input.name, input.value]));
  const form = new URLSearchParams(fields);
  for (const [field, value] of [["state", "wrong-state"], ["redirect_uri", "https://attacker.invalid/"], ["transaction", "wrong-transaction"]]) {
    const invalid = new URLSearchParams(form); invalid.set(field, value);
    const response = await fetch(issuer + "/oauth/consent", { method: "POST", redirect: "manual",
      headers: { Origin: issuer, "Content-Type": "application/x-www-form-urlencoded" }, body: invalid });
    assert.equal(response.status, 400); assert.equal(response.headers.get("location"), null);
  }
  checks.wrongStateRedirectTransactionRejected = true;
  for (const origin of [undefined, "https://attacker.invalid"]) {
    const response = await fetch(issuer + "/oauth/consent", { method: "POST", redirect: "manual",
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    assert.equal(response.status, 401);
  }
  checks.csrfOriginsRejected = true;
  const consentResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/oauth/consent" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Разрешить подключение" }).click();
  const consent = await consentResponse;
  assert.equal(consent.status(), 200);
  assert.equal(consent.headers()["content-security-policy"], strictCsp);
  assert.equal(consent.headers()["cache-control"], "no-store, private");
  assert.equal(consent.headers()["referrer-policy"], "no-referrer");
  assert.equal(consent.headers().location, undefined);
  assert.equal(callbackCount, 0);
  const link = page.getByRole("link", { name: "Вернуться в ChatGPT" });
  assert.equal(await link.getAttribute("rel"), "noreferrer");
  const href = new URL(await link.getAttribute("href"));
  assert.equal(href.origin + href.pathname, redirectUri);
  assert.equal(href.searchParams.get("state"), state);
  checks.strictCspAndEscapedLink = true;
  const replay = await fetch(issuer + "/oauth/consent", { method: "POST",
    headers: { Origin: issuer, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_authorization_transaction");
  checks.consentReplayRejected = true;
  await Promise.all([page.waitForURL(url => url.origin + url.pathname === redirectUri), link.click()]);
  assert.equal(await page.locator("body").innerText(), "Isolated callback completed");
  if (callbackError) throw callbackError;
  assert.equal(callbackCount, 1); assert.equal(refererPresent, false); assert.equal(cspErrors, 0);
  checks.callbackReachedOnceWithoutReferrer = true;
  console.log(JSON.stringify({ result: "PASS", browser: browser.version(), checks }));
} finally {
  if (browser) await browser.close();
  for (const server of [issuerServer, callbackServer]) if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
