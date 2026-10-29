import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientTokenStore } from "../src/mcp/client-token-store.js";

const dirs: string[] = [];
async function registryPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herder-client-tokens-"));
  dirs.push(dir);
  return join(dir, "mcp-client-tokens.json");
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("McpClientTokenStore shared registry", () => {
  it("accepts a token issued by another process without a restart", async () => {
    const path = await registryPath();
    const server = new McpClientTokenStore(path);
    const first = await new McpClientTokenStore(path).issue("first", "input-1");
    expect(await server.verifyToken(first.token)).toMatchObject({ name: "first" });
    const later = await new McpClientTokenStore(path).issue("later", "input-2");
    expect(await server.verifyToken(later.token)).toMatchObject({ name: "later" });
  });

  it("stops accepting a token revoked by another process", async () => {
    const path = await registryPath();
    const server = new McpClientTokenStore(path);
    const issued = await new McpClientTokenStore(path).issue("revoked", "input-3");
    expect(await server.verifyToken(issued.token)).toBeDefined();
    await new McpClientTokenStore(path).revoke(issued.record.id);
    expect(await server.verifyToken(issued.token)).toBeUndefined();
  });
});
