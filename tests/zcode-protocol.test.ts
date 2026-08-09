import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ZcodeAppServerClient } from "../src/adapters/zcode-protocol.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");

describe("ZCode app-server protocol client", () => {
  it("performs the hello handshake and exchanges framed channel RPC", async () => {
    const client = new ZcodeAppServerClient({
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      startupTimeoutMs: 3000,
      requestTimeoutMs: 3000,
    });
    try {
      await client.start();
      const result = await client.call("zcode-agent", "initialize", [{ workspacePath: "/workspace", workspaceIdentity: "/workspace" }]);
      expect(result).toEqual({ available: true, protocolName: "ZCode Protocol", protocolVersion: 1, transportKind: "stdio" });
    } finally {
      await client.close();
    }
  });
});
