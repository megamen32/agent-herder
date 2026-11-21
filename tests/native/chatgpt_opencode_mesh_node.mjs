// One public Herder MCP node inside the pair stand's isolated UTS namespace.
import assert from "node:assert/strict";
import { hostname, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { canonicalFixture } from "../helpers/canonical-herder-fixture.ts";
import { createCanonicalAutomationClient, unwrapCanonicalResult } from "../../dist/canonical-herder.js";
import { OpenCodeAdapter } from "../../dist/adapters/opencode.js";
import { HerderEventBus } from "../../dist/herder-events.js";
import { HerderJobRegistry } from "../../dist/herder-jobs.js";
import { coordinationNotes } from "../../dist/coordination-notes.js";
import { registerControlPlaneTools } from "../../dist/mcp/control-plane-tools.js";
import { registerSessionTools } from "../../dist/mcp/session-tools.js";
import { withToolConsolidation } from "../../dist/mcp/tool-consolidation.js";
import { FleetDirectTransport } from "../../dist/mesh/fleet-direct-transport.js";
import { FleetGptAdminTransport } from "../../dist/mesh/fleet-gptadmin-transport.js";
import { registerFleetNodeTools } from "../../dist/mesh/fleet-node.js";

const [browserHost, openCodeHost, relayUrl, openCodeUrl] = process.argv.slice(2);
assert.ok(browserHost !== openCodeHost && [browserHost, openCodeHost].includes(hostname()));
for (const url of [relayUrl, openCodeUrl]) assert.equal(new URL(url).hostname, "127.0.0.1");
const other = hostname() === browserHost ? openCodeHost : browserHost;
const peers = [{ hostId: other, sshHost: "127.0.0.1", nativeUser: userInfo().username, port: 0, python: "/usr/bin/python3" }];
const facade = { endpoint: relayUrl, headersProvider: () => ({}), readDeadlineMs: 25000 };
const transport = new FleetDirectTransport(peers, 25000, new FleetGptAdminTransport(facade));

const fixture = await canonicalFixture();
fixture.config.authority = `mcp:shell:${browserHost}:AgentHerder`;
await fixture.writeConfig();
const native = new FleetGptAdminTransport({
  ...facade, nativeHerderAuthority: fixture.config.authority, unwrapResponse: unwrapCanonicalResult,
});
const canonicalClient = await createCanonicalAutomationClient({
  env: fixture.env, transportFactory: async () => native,
});
const adapters = new Map();
if (hostname() === openCodeHost) {
  const adapter = new OpenCodeAdapter({ baseUrl: openCodeUrl, protocol: "v2", password: "fixture-only" });
  await adapter.init();
  adapters.set("opencode", adapter);
}
const events = new HerderEventBus();
const jobs = new HerderJobRegistry(events, { persistencePath: join(homedir(), "jobs.json") });
await serveStdio(() => {
  const server = new McpServer({ name: "herder-pair-" + hostname(), version: "1" });
  withToolConsolidation(server, () => {
    registerFleetNodeTools(server, { adapters, browserInlineAttachments: Boolean(canonicalClient), fleetPeers: [] });
    registerSessionTools(server, { adapters, events, jobs, transport, routingPeers: peers, canonicalClient });
    registerControlPlaneTools(server, { events, jobs, coordination: coordinationNotes });
  }, new Set());
  return server;
});
