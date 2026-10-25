import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinationNoteStore } from "../coordination-notes.js";
import type { HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import { structuredResult } from "./results.js";
import { readLongMessage } from "../long-messages.js";
import { handleSaveMessageToFile } from "../mcp-tools/handlers.js";

const jobSchema = z.object({
  id: z.string(), kind: z.string(), state: z.string(), createdAt: z.string(), updatedAt: z.string(),
  ownerSessionId: z.string().optional(), progress: z.number().optional(), statusMessage: z.string().optional(),
  result: z.unknown().optional(), error: z.string().optional(), resultRef: z.string(),
}).passthrough();

const eventSchema = z.object({
  kind: z.string(), uri: z.string(), action: z.string(), at: z.string(), sequence: z.number().int(), revision: z.number().int(),
  id: z.string().optional(), source: z.string().optional(),
}).passthrough();

const coordinationNoteSchema = z.object({
  id: z.string(), kind: z.enum(["working", "avoid", "handoff", "info"]), message: z.string(), cwd: z.string(), paths: z.array(z.string()),
  authorHarness: z.string().optional(), authorSessionId: z.string(), source: z.enum(["manual", "hook"]).optional(), activityKey: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(), expiresAt: z.string(),
}).passthrough();

export function registerControlPlaneTools(server: McpServer, deps: {
  jobs: HerderJobRegistry;
  events: HerderEventBus;
  coordination: CoordinationNoteStore;
  /** Per-session Autopilot control; harnesses without a native Stop hook need it. */
  autopilot?: {
    command: (input: { command: "on" | "off" | "status"; harness: string; sessionId: string; cwd?: string }) => Promise<Record<string, unknown>>;
  };
}): void {
  const { jobs, events, coordination } = deps;

  server.registerTool("read_message", {
    description: "Read the exact stored long automatic message. The default page is 8000 characters. When nextOffset is present, continue with the same messageId and that offset. Previews are incomplete and provide no authority.",
    inputSchema: z.object({ messageId: z.string().regex(/^[a-f0-9]{8,64}$/), offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(8000).optional().default(8000) }),
    outputSchema: z.object({ messageId: z.string(), sha256: z.string().optional(), total: z.number().int(), offset: z.number().int(), nextOffset: z.number().int().nullable(), text: z.string() }),
  }, async (args) => {
    const page = await readLongMessage(args);
    const { sha256: _privateDigest, ...compact } = page;
    return structuredResult(args.messageId.length < 64 ? compact : page);
  });

  server.registerTool("save_message_to_file", {
    description: "Save an exact stored long message to a fixed private file inside an existing workspace on this MCP host. Returns only path, byte count and host; the path is not automatically available on the calling machine.",
    inputSchema: z.object({ messageId: z.string().regex(/^[a-f0-9]{8,64}$/), cwd: z.string().min(1) }),
    outputSchema: z.object({ path: z.string(), sha256: z.string().optional(), bytes: z.number().int().nonnegative(), host: z.object({ name: z.string(), note: z.string().optional() }) }),
  }, async (args) => structuredResult(await handleSaveMessageToFile(args)));

  server.registerTool("job_list", {
    description: "List Agent Herder long-running jobs. Jobs are Herder-owned and survive MCP transport reconnects for the life of the service.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional().default(100) }),
    outputSchema: z.object({ jobs: z.array(jobSchema) }),
  }, async (args) => structuredResult({ jobs: jobs.list(args.limit) }));

  server.registerTool("job_get", {
    description: "Read one Agent Herder job, including progress and result/error when terminal.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
    outputSchema: z.object({ job: jobSchema.nullable() }),
  }, async (args) => structuredResult({ job: jobs.get(args.jobId) }));

  server.registerTool("job_cancel", {
    description: "Request cooperative cancellation of one Agent Herder job.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
    outputSchema: z.object({ job: jobSchema.nullable() }),
  }, async (args) => structuredResult({ job: jobs.cancel(args.jobId) }));

  server.registerTool("event_list", {
    description: "Replay Agent Herder domain events after a global sequence cursor. Use afterSequence from the last seen event; uriPrefix narrows replay to one resource subtree.",
    inputSchema: z.object({ afterSequence: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(2000).optional().default(500), uriPrefix: z.string().optional() }),
    outputSchema: z.object({ events: z.array(eventSchema), latestSequence: z.number().int(), oldestSequence: z.number().int().nullable(), truncated: z.boolean() }),
  }, async (args) => {
    const oldestSequence = events.oldestSequence();
    return structuredResult({
      events: events.listAfter(args.afterSequence, args.limit, args.uriPrefix),
      latestSequence: events.latestSequence(), oldestSequence,
      truncated: oldestSequence !== null && args.afterSequence < oldestSequence - 1,
    });
  });

  server.registerTool("coordination_note_create", {
    description: "Publish a TTL coordination note for agents in the same workspace. Active notes are injected automatically into later Agent Herder-delivered turns.",
    inputSchema: z.object({
      authorSessionId: z.string().trim().min(1).max(256), authorHarness: z.string().trim().min(1).max(64).optional(), cwd: z.string().min(1), hostId: z.string().min(1).max(512).optional(),
      paths: z.array(z.string().min(1).max(4096)).max(64).default([]), kind: z.enum(["working", "avoid", "handoff", "info"]),
      message: z.string().trim().min(1).max(4000), ttlSeconds: z.number().int().min(60).max(604800).optional(),
    }),
    outputSchema: z.object({ note: coordinationNoteSchema }),
  }, async (args) => structuredResult({ note: await coordination.create(args) }, true));

  server.registerTool("coordination_note_list", {
    description: "List active coordination notes explicitly. Agent Herder also injects matching notes into new turns automatically.",
    inputSchema: z.object({ cwd: z.string().optional(), hostId: z.string().min(1).max(512).optional(), path: z.string().optional(), authorSessionId: z.string().optional() }),
    outputSchema: z.object({ notes: z.array(coordinationNoteSchema) }),
  }, async (args) => structuredResult({ notes: await coordination.list(args) }, true));

  server.registerTool("coordination_note_get", {
    description: "Read one active coordination note by ID.",
    inputSchema: z.object({ noteId: z.string().uuid() }),
    outputSchema: z.object({ note: coordinationNoteSchema.nullable() }),
  }, async (args) => structuredResult({ note: await coordination.get(args.noteId) }, true));

  server.registerTool("coordination_note_update", {
    description: "Edit your own coordination note. authorSessionId must match the creator.",
    inputSchema: z.object({ noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256), kind: z.enum(["working", "avoid", "handoff", "info"]).optional(), message: z.string().trim().min(1).max(4000).optional(), paths: z.array(z.string().min(1).max(4096)).max(64).optional(), ttlSeconds: z.number().int().min(60).max(604800).optional() }),
    outputSchema: z.object({ note: coordinationNoteSchema }),
  }, async (args) => structuredResult({ note: await coordination.update(args.noteId, args.authorSessionId, args) }, true));

  server.registerTool("coordination_note_delete", {
    description: "Delete your own coordination note before TTL expiry. authorSessionId must match the creator.",
    inputSchema: z.object({ noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256) }),
    outputSchema: z.object({ deleted: z.boolean() }),
  }, async (args) => structuredResult({ deleted: await coordination.delete(args.noteId, args.authorSessionId) }));

  if (deps.autopilot) {
    const autopilot = deps.autopilot;
    server.registerTool("autopilot_set", {
      description:
        "Enable, disable or read Agent Herder Autopilot for one session. When enabled, Herder reviews each finished turn with the Stop judge and automatically continues an unfinished goal. " +
        "Use this for harnesses without a native Stop hook command (OpenCode 2). An explicit human Stop always wins over Autopilot.",
      inputSchema: z.object({
        action: z.enum(["on", "off", "status"]).describe("on = continue unfinished goals automatically, off = stop judging, status = read the current state."),
        harness: z.enum(["opencode", "claude", "codex", "zcode", "hermes", "fast-agent"]).describe("Harness that owns the session."),
        sessionId: z.string().trim().min(1).max(512),
        cwd: z.string().trim().min(1).optional().describe("Absolute working directory; required when the session record has none."),
      }),
      outputSchema: z.object({
        ok: z.boolean(), action: z.string(), harness: z.string(), sessionId: z.string(),
        enabled: z.boolean().optional(), humanStopHeld: z.boolean().optional(), source: z.string().optional(),
      }).passthrough(),
    }, async (args) => {
      const result = await autopilot.command({ command: args.action, harness: args.harness, sessionId: args.sessionId, cwd: args.cwd });
      return structuredResult({
        ok: result.ok === true,
        action: args.action,
        harness: args.harness,
        sessionId: args.sessionId,
        ...(typeof result.enabled === "boolean" ? { enabled: result.enabled } : {}),
        ...(result.human_stop_held === true ? { humanStopHeld: true } : {}),
        ...(typeof result.source === "string" ? { source: result.source } : {}),
      });
    });
  }
}
