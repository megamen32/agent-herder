import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { HarnessAdapter } from "../types/index.js";
import type { CoordinationNoteStore } from "../coordination-notes.js";
import type { HumanRequestRegistry } from "../human-request/index.js";
import type { HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import type { HarnessEventHealthRegistry } from "../harness-event-health.js";
import { handleListAgents } from "../mcp-tools/handlers.js";

function resourceMeta(events: HerderEventBus, uri: string): Record<string, unknown> {
  return {
    "herder/revision": uri.startsWith("herder://events") ? events.latestSequence() : events.revision(uri),
    "herder/sequence": events.latestSequence(),
  };
}

function jsonContent(events: HerderEventBus, uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, text: JSON.stringify(value, null, 2), mimeType: "application/json", _meta: resourceMeta(events, uri.href) }] };
}

export function registerHerderResources(server: McpServer, deps: {
  adapters: Map<string, HarnessAdapter>;
  coordination: CoordinationNoteStore;
  humanRequests: HumanRequestRegistry;
  jobs: HerderJobRegistry;
  events: HerderEventBus;
  eventHealth: HarnessEventHealthRegistry;
}): void {
  const { adapters, coordination, humanRequests, jobs, events, eventHealth } = deps;

  server.registerResource("sessions", "herder://sessions", { title: "Agent sessions", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, text: await handleListAgents(adapters, { harness: "all", status: "all", limit: 100, includeLastMessage: true }), _meta: resourceMeta(events, uri.href) }],
  }));
  server.registerResource("session", new ResourceTemplate("herder://sessions/{harness}/{sessionId}", { list: undefined, complete: { harness: () => [...adapters.keys()] } }), { title: "Agent session", mimeType: "application/json" }, async (uri, variables) =>
    jsonContent(events, uri, await adapters.get(String(variables.harness))?.getSession(String(variables.sessionId)) ?? null));
  server.registerResource("session-messages", new ResourceTemplate("herder://sessions/{harness}/{sessionId}/messages", { list: undefined, complete: { harness: () => [...adapters.keys()] } }), { title: "Agent session messages", mimeType: "application/json" }, async (uri, variables) => {
    const adapter = adapters.get(String(variables.harness));
    return jsonContent(events, uri, adapter?.getSessionMessages ? await adapter.getSessionMessages(String(variables.sessionId), 100) : []);
  });

  server.registerResource("coordination", "herder://coordination", { title: "Active coordination notes", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, await coordination.list()));
  server.registerResource("coordination-note", new ResourceTemplate("herder://coordination/notes/{noteId}", { list: undefined }), { title: "Coordination note", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, await coordination.get(String(variables.noteId))));
  server.registerResource("coordination-workspace", new ResourceTemplate("herder://coordination/workspaces/{cwd}", { list: undefined }), { title: "Workspace coordination notes", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, await coordination.list({ cwd: decodeURIComponent(String(variables.cwd)) })));

  server.registerResource("presence", "herder://presence", { title: "Agent workspace presence", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, coordination.presenceSnapshot()));
  server.registerResource("presence-session", new ResourceTemplate("herder://presence/{sessionId}", { list: undefined }), { title: "Agent presence", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, coordination.presenceForSession(decodeURIComponent(String(variables.sessionId)))));
  server.registerResource("presence-workspace", new ResourceTemplate("herder://presence/workspaces/{cwd}", { list: undefined }), { title: "Workspace presence", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, coordination.presenceForWorkspace(decodeURIComponent(String(variables.cwd)))));

  server.registerResource("adapters", "herder://adapters", { title: "Harness native event sources", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, eventHealth.list()));
  server.registerResource("adapter", new ResourceTemplate("herder://adapters/{harness}", { list: undefined, complete: { harness: () => [...adapters.keys()] } }), { title: "Harness native event source", mimeType: "application/json" }, async (uri, variables) => {
    const harness = decodeURIComponent(String(variables.harness));
    return jsonContent(events, uri, { harness, ...eventHealth.get(harness) });
  });

  server.registerResource("human-requests", "herder://human-requests", { title: "Human Request registry", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, await humanRequests.list()));
  server.registerResource("human-request", new ResourceTemplate("herder://human-requests/{requestId}", { list: undefined }), { title: "Human Request", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, await humanRequests.get(String(variables.requestId))));
  server.registerResource("jobs", "herder://jobs", { title: "Agent Herder jobs", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, jobs.list()));
  server.registerResource("job", new ResourceTemplate("herder://jobs/{jobId}", { list: undefined }), { title: "Agent Herder job", mimeType: "application/json" }, async (uri, variables) => jsonContent(events, uri, jobs.get(String(variables.jobId))));

  server.registerResource("events", "herder://events", { title: "Agent Herder event journal", mimeType: "application/json" }, async (uri) => jsonContent(events, uri, { latestSequence: events.latestSequence(), oldestSequence: events.oldestSequence(), events: events.listAfter(Math.max(0, events.latestSequence() - 100), 100) }));
  server.registerResource("events-after", new ResourceTemplate("herder://events/after/{sequence}", { list: undefined }), { title: "Agent Herder event replay cursor", mimeType: "application/json" }, async (uri, variables) => {
    const afterSequence = Math.max(0, Number.parseInt(String(variables.sequence), 10) || 0);
    const oldestSequence = events.oldestSequence();
    return jsonContent(events, uri, { afterSequence, latestSequence: events.latestSequence(), oldestSequence, truncated: oldestSequence !== null && afterSequence < oldestSequence - 1, events: events.listAfter(afterSequence, 500) });
  });
}
