import type { Tool } from "@modelcontextprotocol/server";
import { HumanRequestRegistry, type HumanRequestRecord } from "../human-request/index.js";

export interface HumanRequestToolRegistration {
  (definition: Tool, handler: (args: unknown) => Promise<string>): void;
}

export const humanRequestToolDefinitions: Tool[] = [
  {
    name: "human_request_create",
    description: "Create an opaque Ask User or Ask Secret request bound to an existing harness session.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["user", "secret"] },
      harness: { type: "string" }, sessionId: { type: "string" }, contextRef: { type: "string" },
      notify: { type: "object", description: "Explicit Notify event tuple; no policy defaults are applied.", properties: {
        project: { type: "string" }, recipient: { type: "string" }, kind: { type: "string" }, severity: { type: "string" }, title: { type: "string" },
      }, required: ["project", "recipient", "kind", "severity", "title"] },
    }, required: ["kind", "harness", "sessionId"] },
  },
  {
    name: "human_request_resolve",
    description: "Mark a human request resolved using an opaque provider reference and return routing intent.",
    inputSchema: { type: "object", properties: {
      requestId: { type: "string" }, continuation: { type: "string", enum: ["resume"] }, resolutionRef: { type: "string" },
    }, required: ["requestId", "continuation"] },
  },
  {
    name: "human_request_get",
    description: "Read the routing metadata and lifecycle state for an opaque human request.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] },
  },
  {
    name: "human_request_bind_notify_incident",
    description: "Persist the incident_id returned by Notify for an explicitly configured human request.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" }, incidentId: { type: "string" } }, required: ["requestId", "incidentId"] },
  },
];

export function registerHumanRequestTools(
  registry: HumanRequestRegistry,
  register: HumanRequestToolRegistration,
): void {
  register(humanRequestToolDefinitions[0], async (args) => {
    const input = requireObject(args);
    const record = await registry.create({
      kind: input.kind as "user" | "secret",
      target: { harness: requiredString(input.harness, "harness"), sessionId: requiredString(input.sessionId, "sessionId") },
      ...(input.contextRef === undefined ? {} : { contextRef: requiredString(input.contextRef, "contextRef") }),
      ...(input.notify === undefined ? {} : { notify: input.notify as never }),
    });
    return safeJson(record);
  });
  register(humanRequestToolDefinitions[1], async (args) => {
    const input = requireObject(args);
    const record = await registry.resolve(requiredString(input.requestId, "requestId"), {
      continuation: input.continuation as "resume",
      ...(input.resolutionRef === undefined ? {} : { resolutionRef: requiredString(input.resolutionRef, "resolutionRef") }),
    });
    return safeJson(record);
  });
  register(humanRequestToolDefinitions[2], async (args) => {
    const record = await registry.get(requiredString(requireObject(args).requestId, "requestId"));
    return safeJson(record);
  });
  register(humanRequestToolDefinitions[3], async (args) => {
    const input = requireObject(args);
    const record = await registry.bindNotifyIncident(
      requiredString(input.requestId, "requestId"),
      requiredString(input.incidentId, "incidentId"),
    );
    return safeJson(record);
  });
}

function requireObject(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  return args as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function safeJson(record: HumanRequestRecord | null): string {
  return JSON.stringify(record);
}
