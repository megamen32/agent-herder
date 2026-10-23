// Prints the exact MCP schema of the rename_session tool as the server
// publishes it, so the schema in the report is the real one.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerSessionTools } from "../../../../src/mcp/session-tools.js";
import { HerderEventBus } from "../../../../src/herder-events.js";
import { HerderJobRegistry } from "../../../../src/herder-jobs.js";

const events = new HerderEventBus();
const server = new McpServer({ name: "schema-dump", version: "1" });
registerSessionTools(server, { adapters: new Map(), jobs: new HerderJobRegistry(events), events });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "schema-dump-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
await server.connect(serverTransport);
await client.connect(clientTransport);
const tools = await client.listTools();
const tool = tools.tools.find((entry) => entry.name === "rename_session");
console.log(JSON.stringify(tool, null, 2));
await client.close();
await server.close();
