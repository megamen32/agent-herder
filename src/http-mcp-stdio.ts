#!/usr/bin/env node

/** stdio MCP shim: every harness process forwards to the singleton Herder HTTP server. */
const baseUrl = (process.env.AGENT_HERDER_HTTP_URL || "http://127.0.0.1:18787/mcp").replace(/\/$/, "");
const token = process.env.AGENT_HERDER_HTTP_TOKEN || "";
let sessionId: string | undefined;

process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (line) void forward(line);
  }
});

async function forward(line: string): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  try {
    const response = await fetch(baseUrl, { method: "POST", headers, body: line });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    if (response.status === 204) return;
    const payload = await response.text();
    if (payload) process.stdout.write(`${payload}\n`);
  } catch (error) {
    const request = JSON.parse(line) as { id?: string | number | null };
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32001, message: String(error) }})}\n`);
  }
}
