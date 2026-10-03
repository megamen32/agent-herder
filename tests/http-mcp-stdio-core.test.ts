import { describe, expect, it } from "vitest";
import { decodeMcpHttpPayload } from "../src/http-mcp-stdio-core.js";

describe("HTTP MCP to stdio framing", () => {
  it("extracts JSON-RPC data from an SSE response", () => {
    const payload = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      "",
    ].join("\n");
    expect(decodeMcpHttpPayload("text/event-stream; charset=utf-8", payload)).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}',
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
    ]);
  });

  it("normalizes a JSON response and ignores empty bodies", () => {
    expect(decodeMcpHttpPayload("application/json", ' { "jsonrpc": "2.0", "id": 2, "result": {} } '))
      .toEqual(['{"jsonrpc":"2.0","id":2,"result":{}}']);
    expect(decodeMcpHttpPayload(null, "   ")).toEqual([]);
  });
});
