import { acceptedContent, inputRequired, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { askHuman, type HumanQuestionBinding } from "../human-request/question-binding.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "../human-request/registry.js";
import { resumeHumanRequestOnce, humanRequestResumeTarget } from "../human-request/resume-admission.js";
import { resolveMcpClientFeatures } from "../mcp-client-features.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../resume-transport.js";
import { structuredResult } from "./results.js";

const humanRequestSchema = z.object({
  requestId: z.string(), kind: z.enum(["user", "secret"]),
  target: z.object({
    agent: z.string().optional(), harness: z.string().optional(), sessionId: z.string(), cwd: z.string().optional(), marker: z.string().optional(),
    locator: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  contextRef: z.string().optional(), status: z.enum(["pending", "resuming", "resumed", "resume_failed"]), continuation: z.literal("resume"),
  resolutionRef: z.string().optional(), resultRef: z.string().optional(), attemptId: z.string().optional(),
  idempotencyKey: z.string().optional(), resumeLeaseExpiresAt: z.string().optional(), receipt: z.string().optional(),
  createdAt: z.string(), resolvedAt: z.string().optional(), notify: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const resumeSchema = z.object({
  status: z.enum(["resumed", "resume_failed", "in_flight", "unsupported_target"]),
  requestId: z.string(),
  idempotencyKey: z.string(),
  duplicate: z.boolean(),
  receipt: z.string().optional(),
});

export interface HumanRequestToolOptions {
  /**
   * Bound native resume of one human answer. Required: an answer must either
   * resume its exact session exactly once or fail loudly, never park a request
   * in a resuming state that nothing can complete.
   */
  humanResume: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  /** Reads the durable provider receipt for the same idempotency key without launching the session. */
  queryReceipt?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
}

export function registerHumanRequestTools(
  server: McpServer,
  humanRequests: HumanRequestRegistry,
  options: HumanRequestToolOptions,
): void {
  /**
   * Resolve an answer through the same single durable admission as the internal
   * completion endpoint, so a notice card, a voice answer and a repeat callback
   * resume the exact native session exactly once.
   */
  const resumeOnce = async (requestId: string, resolutionRef: string | undefined): Promise<{
    record: HumanRequestRecord; status: z.infer<typeof resumeSchema>["status"]; idempotencyKey: string; duplicate: boolean; receipt?: string;
  }> => {
    const record = await humanRequests.get(requestId);
    if (!record) throw new Error(`Human request '${requestId}' not found`);
    if (record.status === "resumed" || record.status === "resume_failed") {
      // A terminal request is never resumed again; report its durable receipt.
      return {
        record,
        status: record.status,
        idempotencyKey: record.idempotencyKey ?? `human-request:${record.requestId}:${record.attemptId}`,
        duplicate: true,
        ...(record.status === "resume_failed" ? { receipt: record.receipt ?? "resume-failed" } : {}),
      };
    }
    if (!humanRequestResumeTarget(record)) {
      throw new Error(`Human request '${requestId}' has no resumable native target`);
    }
    const outcome = await resumeHumanRequestOnce({
      registry: humanRequests,
      requestId,
      resultRef: resolutionRef ?? admissionResultRef(record),
      resume: options.humanResume,
      ...(options.queryReceipt ? { queryReceipt: options.queryReceipt } : {}),
      ...(resolutionRef ? { resolutionRef } : {}),
    });
    return { record: outcome.record, status: outcome.status, idempotencyKey: outcome.idempotencyKey, duplicate: outcome.duplicate, ...("receipt" in outcome ? { receipt: outcome.receipt } : {}) };
  };

  server.registerTool("human_request_create", {
    description: "Ask a human a question about an exact existing harness session. Returns one question binding: the request id, the exact native_target, the message and the choices. Notice creates exactly one Ask card from it through POST /v1/human-requests; Agent Herder never sends a second card. Hermes requires its immutable hermes.locator.v2 locator. The answer resumes that exact session once through human_request_resolve.",
    inputSchema: z.object({
      kind: z.enum(["user", "secret"]), harness: z.string().min(1), sessionId: z.string().min(1), cwd: z.string().min(1).optional(), marker: z.string().min(1).optional(),
      locator: z.record(z.string(), z.unknown()).optional(), contextRef: z.string().optional(),
      message: z.string().min(1).max(4096).describe("The human-readable question; never paste a secret value into it"),
      choices: z.array(z.object({ choiceId: z.string().min(1).max(64), label: z.string().min(1).max(512) })).min(2).max(4).optional(),
      notify: z.object({ project: z.string().min(1), recipient: z.string().min(1), kind: z.string().min(1), severity: z.string().min(1), title: z.string().min(1) }).optional(),
    }),
    outputSchema: z.object({ request: humanRequestSchema, binding: z.object({
      request_id: z.string(),
      native_target: z.object({ harness: z.string(), session_id: z.string(), cwd: z.string().optional(), marker: z.string().optional() }),
      dedup_key: z.string(),
      context_ref: z.string().optional(),
      kind: z.enum(["user", "secret"]),
      question: z.object({ message: z.string(), choices: z.array(z.object({ choice_id: z.string(), label: z.string() })).optional() }),
      answer: z.object({ mcp_tool: z.string(), completion_path: z.string() }),
    }) }),
  }, async (args) => {
    if (args.harness === "hermes" && !args.locator) throw new Error("Hermes human request requires an immutable hermes.locator.v2 locator");
    const binding = await askHuman(humanRequests, {
      kind: args.kind,
      target: { harness: args.harness, sessionId: args.sessionId, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.marker ? { marker: args.marker } : {}), ...(args.locator ? { locator: args.locator } : {}) },
      message: args.message,
      ...(args.choices ? { choices: args.choices } : {}),
      contextRef: args.contextRef,
      ...(args.notify ? { contextRef: args.contextRef ?? `noticeplace://human-request/${args.harness}/${args.sessionId}` } : {}),
    });
    const { record, ...question } = binding;
    return structuredResult({ request: record, binding: question });
  });

  server.registerTool("human_request_resolve", {
    description: "Resolve a Human Request with only an opaque provider result reference. The bound native session resumes exactly once under a stable idempotency key; a repeated answer returns the same durable receipt instead of resuming again.",
    inputSchema: z.object({ requestId: z.string().uuid(), resolutionRef: z.string().optional() }),
    outputSchema: z.object({ request: humanRequestSchema, resume: resumeSchema }),
  }, async (args) => {
    const outcome = await resumeOnce(args.requestId, args.resolutionRef);
    return structuredResult({ request: outcome.record, resume: { status: outcome.status, requestId: outcome.record.requestId, idempotencyKey: outcome.idempotencyKey, duplicate: outcome.duplicate, ...(outcome.receipt ? { receipt: outcome.receipt } : {}) } });
  });

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
    const outcome = await resumeOnce(args.requestId, resolutionRef);
    return structuredResult({ request: outcome.record, resume: { status: outcome.status, requestId: outcome.record.requestId, idempotencyKey: outcome.idempotencyKey, duplicate: outcome.duplicate, ...(outcome.receipt ? { receipt: outcome.receipt } : {}) } });
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

/** Keep the durable provider reference when the answer arrives without a distinct one. */
function admissionResultRef(record: HumanRequestRecord): string {
  return record.resultRef ?? record.resolutionRef ?? record.requestId;
}