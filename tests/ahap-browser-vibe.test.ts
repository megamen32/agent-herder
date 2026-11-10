import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";
import { readProtectedBrowserMcpToken, validateBrowserMcpUrl } from "../src/adapters/browser-mcp-profile.js";

const scope = "a".repeat(64);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("disabled legacy Vibe MCP route", () => {
  it("refuses a browser MCP route before it can adopt a tab", () => {
    expect(() => makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt", AHAP_BROWSER_TRANSPORT: "vibe-mcp", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    })).toThrow("Vibe is not permitted");
  });

  it("requires the exact owner supplied endpoint when validating a profile", () => {
    const endpoint = "https://example.invalid/server/fixture/mcp";
    expect(validateBrowserMcpUrl(endpoint, endpoint)).toBe(endpoint);
    expect(() => validateBrowserMcpUrl(endpoint, "https://example.invalid/server/other/mcp"))
      .toThrow("endpoint_not_configured");
  });
});

describe("protected browser MCP credentials", () => {
  it("rejects public, symlinked, and malformed credential files without echoing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-profile-fixture-")); temporary.push(root);
    const path = join(root, "credential.json");
    await writeFile(path, JSON.stringify({ authorization: "Bearer fixture-token" }), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(readProtectedBrowserMcpToken(path)).rejects.toThrow("protected_profile_unavailable");
    await chmod(path, 0o600);
    const link = join(root, "linked.json"); await symlink(path, link);
    await expect(readProtectedBrowserMcpToken(link)).rejects.toThrow("protected_profile_unavailable");
    await writeFile(path, JSON.stringify({ authorization: "Bearer fixture-token\nbad" }), { mode: 0o600 });
    await expect(readProtectedBrowserMcpToken(path)).rejects.toThrow("authorization_unavailable");
  });
});
