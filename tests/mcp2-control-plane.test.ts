import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});

async function connect(options: Parameters<typeof createAgentHerderMcpServer>[1] = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer(undefined, options);
  const client = new Client({ name: "mcp2-control-plane-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

describe("MCP2 control-plane surface", () => {
  it("advertises granular resources and templates", async () => {
    const client = await connect();
    const resources = (await client.listResources()).resources.map((item) => item.uri);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((item) => item.uriTemplate);
    expect(resources).toEqual(expect.arrayContaining(["herder://sessions", "herder://coordination", "herder://human-requests", "herder://jobs", "herder://events", "herder://adapters"]));
    expect(templates).toEqual(expect.arrayContaining([
      "herder://sessions/{harness}/{sessionId}",
      "herder://sessions/{harness}/{sessionId}/messages",
      "herder://coordination/notes/{noteId}",
      "herder://coordination/workspaces/{cwd}",
      "herder://human-requests/{requestId}",
      "herder://jobs/{jobId}",
      "herder://events/after/{sequence}",
      "herder://adapters/{harness}",
      "herder://presence/{sessionId}",
      "herder://presence/workspaces/{cwd}",
    ]));
  });

  it("runs conversion as a Herder-owned job and exposes it as a resource", async () => {
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events);
    const client = await connect({
      events, jobs,
      sessionConverter: { async convert(input) { return { success: true, targetSessionId: `${input.sessionId}-converted`, targetPath: "/tmp/out", messageCount: 3 }; } },
    });
    const started = await client.callTool({ name: "session_convert_async", arguments: { sessionId: "s1", from: "claude", to: "codex" } });
    const startedPayload = started.structuredContent as { job?: { id: string } } | undefined;
    const job = startedPayload?.job ?? JSON.parse(started.content[0]?.type === "text" ? started.content[0].text : "{}").job;
    expect(job.id).toMatch(/^job_/);
    for (let i = 0; i < 20 && jobs.get(job.id)?.state !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(jobs.get(job.id)).toMatchObject({ state: "completed", result: { success: true, targetSessionId: "s1-converted" } });
    const resource = await client.readResource({ uri: `herder://jobs/${job.id}` });
    expect(JSON.parse(resource.contents[0]?.text ?? "{}")).toMatchObject({ id: job.id, state: "completed" });
  });

  it("replays event cursors and exposes resource revision metadata", async () => {
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events);
    const client = await connect({ events, jobs });
    events.publish({ kind: "jobs", uri: "herder://jobs", action: "changed", source: "test" });
    events.publish({ kind: "jobs", uri: "herder://jobs/journal-fixture", action: "changed", source: "test" });

    const replay = await client.readResource({ uri: "herder://events/after/0" });
    const payload = JSON.parse(replay.contents[0]?.text ?? "{}");
    expect(payload.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    const jobRoot = await client.readResource({ uri: "herder://jobs" });
    expect(jobRoot.contents[0]?._meta).toMatchObject({ "herder/revision": 1, "herder/sequence": 2 });
    const toolReplay = await client.callTool({ name: "event_list", arguments: { afterSequence: 1 } });
    const toolPayload = toolReplay.structuredContent as { events?: Array<{ sequence: number; revision: number }> } | undefined;
    expect(toolPayload?.events).toHaveLength(1);
    expect(toolPayload?.events?.[0]).toMatchObject({ sequence: 2, revision: 1 });
    const advertised = (await client.listTools()).tools.find((tool) => tool.name === "event_list");
    expect(advertised?.outputSchema).toMatchObject({ type: "object" });
  });

  it("returns structured control-plane results", async () => {
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events);
    const client = await connect({ events, jobs });
    const result = await client.callTool({ name: "job_list", arguments: { limit: 10 } });
    expect(result.structuredContent).toEqual({ jobs: [] });
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "job_list");
    expect(tool?.outputSchema).toMatchObject({ type: "object" });
  });

  it("returns a stable fallback instead of input_required when the client lacks elicitation", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "human_request_resolve_interactive", arguments: { requestId: "11111111-1111-4111-8111-111111111111" } });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("input_required");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("human_request_resolve");
  });
});
