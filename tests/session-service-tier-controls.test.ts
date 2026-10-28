import { hostname } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createWebServer } from "../src/web/server.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { HarnessAdapter, SessionServiceTierState } from "../src/types/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  let tier: "normal" | "fast" | undefined;
  const getServiceTier = vi.fn(async (sessionId: string): Promise<SessionServiceTierState> => ({ sessionId, serviceTier: tier, scope: "session", canSet: true, appliesTo: "subsequent-turns" }));
  const setServiceTier = vi.fn(async (sessionId: string, serviceTier: "normal" | "fast") => { tier = serviceTier; return { ok: true, sessionId, serviceTier, appliesTo: "subsequent-turns" as const }; });
  const adapter = { type: "codex", name: "Codex", getServiceTier, setServiceTier, listSessions: async () => [], getSession: async () => null } as unknown as HarnessAdapter;
  return { adapter, getServiceTier, setServiceTier };
}
async function web(adapter: HarnessAdapter) {
  const server = createWebServer({ adapters: new Map([["codex", adapter]]), converter: {} as any, sessionObservationManagedExternally: true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/codex/exact-id/service-tier`;
}
it("reads unknown honestly, changes only the exact session tier and reads confirmed Fast", async () => {
  const f = fixture(); const path = await web(f.adapter);
  const before = await (await fetch(`${path}?hostId=${hostname()}`)).json();
  expect(before).toMatchObject({ sessionId: "exact-id", canSet: true, appliesTo: "subsequent-turns" });
  expect(before.serviceTier).toBeUndefined();
  const set = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: hostname(), serviceTier: "fast" }) });
  expect(await set.json()).toMatchObject({ ok: true, sessionId: "exact-id", serviceTier: "fast", appliesTo: "subsequent-turns" });
  expect(f.setServiceTier).toHaveBeenCalledExactlyOnceWith("exact-id", "fast");
  expect(await (await fetch(`${path}?hostId=${hostname()}`)).json()).toMatchObject({ serviceTier: "fast" });
});
it("rejects missing or wrong host and invalid tiers before touching the adapter", async () => {
  const f = fixture(); const path = await web(f.adapter);
  expect((await fetch(path)).status).toBe(400);
  expect((await fetch(`${path}?hostId=other-host`)).status).toBe(409);
  for (const body of [{ hostId: "other-host", serviceTier: "fast" }, { hostId: hostname(), serviceTier: "priority" }]) {
    expect((await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBeGreaterThanOrEqual(400);
  }
  expect(f.getServiceTier).not.toHaveBeenCalled(); expect(f.setServiceTier).not.toHaveBeenCalled();
});
it("exposes exact-session get/set through real MCP registration", async () => {
  const f = fixture(); const events = new HerderEventBus();
  const server = new McpServer({ name: "tier-test", version: "1" });
  registerSessionTools(server, { adapters: new Map([["codex", f.adapter]]), events, jobs: new HerderJobRegistry(events) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tier-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st); await client.connect(ct);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const read = await client.callTool({ name: "get_service_tier", arguments: { sessionId: "mcp-exact" } });
  expect(JSON.stringify(read)).toContain("subsequent-turns");
  const result = await client.callTool({ name: "set_service_tier", arguments: { sessionId: "mcp-exact", serviceTier: "normal" } });
  expect(JSON.stringify(result)).toContain('normal');
  expect(f.setServiceTier).toHaveBeenCalledExactlyOnceWith("mcp-exact", "normal");
  const wrong = await client.callTool({ name: "set_service_tier", arguments: { sessionId: "mcp-exact", hostId: "unknown-tier-host", serviceTier: "fast" } });
  expect(wrong.isError).toBe(true); expect(f.setServiceTier).toHaveBeenCalledTimes(1);
});
