import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createWebServer } from "../src/web/server.js";
import { registerResourceOwnershipTools } from "../src/mcp/resource-ownership-tools.js";
import * as ownership from "../src/s21-resource-ownership.js";

describe("S21 readonly consumers (focused integration; expected 2s/max 30s; isolated reader, no phone)", () => {
  it("serves the same exact owner without capabilities through existing HTTP and registered MCP", async () => {
    const value = ownership.parseS21Ownership(JSON.stringify({ status: "held", owner: "Задача APK", purpose: "Проверка", expires_at: "2026-10-12T06:00:00Z", remaining_seconds: 60, lease_id: "private-capability", actor: { type: "agent", harness: "zcode", session_id: "exact-native-session" } }));
    const read = vi.spyOn(ownership, "getS21Ownership").mockResolvedValue(value);
    const http = createWebServer({ supervisor: {} as any, adapters: new Map() });
    const mcp = new McpServer({ name: "s21-isolated", version: "1" });
    registerResourceOwnershipTools(mcp);
    const client = new Client({ name: "s21-consumer", version: "1" });
    try {
      await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
      const port = (http.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/resources/s21-lease`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(value);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await mcp.connect(st); await client.connect(ct);
      const result = await client.callTool({ name: "s21_lease_status", arguments: {} });
      expect(result.structuredContent).toEqual(value);
      expect(JSON.stringify(result)).not.toMatch(/private-capability|lease_id/);
      expect(value.actor?.sessionUrl).toBe("https://agent.bezrabotnyi.com/#/session/zcode%3Aexact-native-session");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore(); await client.close(); await mcp.close();
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
});
