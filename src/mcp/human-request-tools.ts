import { acceptedContent, inputRequired, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HumanRequestRegistry } from "../human-request/index.js";
import { resolveMcpClientFeatures } from "../mcp-client-features.js";
import { structuredResult } from "./results.js";

const humanRequestSchema = z.object({
  requestId: z.string(), kind: z.enum(["user", "secret"]),
  target: z.object({
    agent: z.string().optional(), harness: z.string().optional(), sessionId: z.string(), cwd: z.string().optional(), marker: z.string().optional(),
    locator: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  contextRef: z.string().optional(), status: z.enum(["pending", "resuming", "resumed", "resume_failed"]), continuation: z.literal("resume"),
  resolutionRef: z.string().optional(), resultRef: z.string().optional(), attemptId: z.string().optional(), receipt: z.string().optional(),
  createdAt: z.string(), resolvedAt: z.string().optional(), notify: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export function registerHumanRequestTools(server: McpServer, humanRequests: HumanRequestRegistry): void {
  server.registerTool("human_request_create", {
    description: "Create an opaque Ask User or Ask Secret request bound to an existing harness session. Hermes requires its immutable hermes.locator.v2 locator; Agent Herder never discovers a replacement session. Notification routing is explicit.",
    inputSchema: z.object({
      kind: z.enum(["user", "secret"]), harness: z.string().min(1), sessionId: z.string().min(1), cwd: z.string().min(1).optional(), marker: z.string().min(1).optional(),
      locator: z.record(z.string(), z.unknown()).optional(), contextRef: z.string().optional(),
      notify: z.object({ project: z.string().min(1), recipient: z.string().min(1), kind: z.string().min(1), severity: z.string().min(1), title: z.string().min(1) }).optional(),
    }),
    outputSchema: z.object({ request: humanRequestSchema }),
  }, async (args) => {
    if (args.harness === "hermes" && !args.locator) throw new Error("Hermes human request requires an immutable hermes.locator.v2 locator");
    const request = await humanRequests.create({
      kind: args.kind,
      target: { harness: args.harness, sessionId: args.sessionId, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.marker ? { marker: args.marker } : {}), ...(args.locator ? { locator: args.locator } : {}) },
      contextRef: args.contextRef, notify: args.notify,
    });
    return structuredResult({ request });
  });

  server.registerTool("human_request_resolve", {
    description: "Resolve a Human Request with only an opaque provider result reference and return continuation intent.",
    inputSchema: z.object({ requestId: z.string().uuid(), resolutionRef: z.string().optional() }),
    outputSchema: z.object({ request: humanRequestSchema }),
  }, async (args) => structuredResult({ request: await humanRequests.resolve(args.requestId, { continuation: "resume", resolutionRef: args.resolutionRef }) }));

  server.registerTool("human_request_resolve_interactive", {
    description: "Resolve a Human Request through MCP 2026-07-28 native input-required elicitation. The client supplies only an opaque provider result reference; older clients can keep using human_request_resolve/Web UI.",
    inputSchema: z.object({ requestId: z.string().uuid(), resolutionRef: z.string().min(1).max(512).optional() }),
  }, async (args, ctx) => {
    const schema = z.object({ resolutionRef: z.string().min(1).max(512).describe("Opaque provider-owned result reference; never paste a secret or answer payload") });
    const elicited = acceptedContent(ctx.mcpReq.inputResponses, "resolution", schema);
    const resolutionRef = args.resolutionRef ?? elicited?.resolutionRef;
    if (!resolutionRef) {
      const features = resolveMcpClientFeatures(server);
      if (!features.inputRequired) {
        return structuredResult({
          status: "input_required", requestId: args.requestId,
          fallback: "Use human_request_resolve with resolutionRef or resolve through the Agent Herder Web UI.",
          protocolVersion: features.protocolVersion,
        });
      }
      return inputRequired({
        inputRequests: { resolution: inputRequired.elicit({ message: `Human Request ${args.requestId} is waiting for an opaque resolution reference.`, requestedSchema: schema }) },
      });
    }
    return structuredResult({ request: await humanRequests.resolve(args.requestId, { continuation: "resume", resolutionRef }) });
  });

  server.registerTool("human_request_get", {
    description: "Read opaque Human Request lifecycle and routing metadata.",
    inputSchema: z.object({ requestId: z.string().uuid() }),
    outputSchema: z.object({ request: humanRequestSchema.nullable() }),
  }, async (args) => structuredResult({ request: await humanRequests.get(args.requestId) }));

  server.registerTool("human_request_bind_notify_incident", {
    description: "Persist the opaque incident identifier returned by Notify for a Human Request with explicit notification routing.",
    inputSchema: z.object({ requestId: z.string().uuid(), incidentId: z.string().min(1) }),
    outputSchema: z.object({ request: humanRequestSchema }),
  }, async (args) => structuredResult({ request: await humanRequests.bindNotifyIncident(args.requestId, args.incidentId) }));
}
