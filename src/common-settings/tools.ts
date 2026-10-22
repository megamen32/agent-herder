/**
 * The tools of the common settings on a node of the fleet.
 *
 * The tools are the mouth of the node: the owner of the document asks a node
 * what it holds, tells it that the document moved, and asks it to take the
 * common settings or to put its own values back. The tools never write a file
 * of another node and they never start an executor.
 *
 * The authority of a call is the identity of the native owner: the transport
 * of the fleet reaches the node over the owner-authorized SSH and the node
 * checks that the caller is the owner of the machine. The panel of the node
 * has its own owner check, the same one the other settings have.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CommonSettingsNodeService } from "./node-service.js";

/** The answer of a tool of the common settings. */
function answer(payload: Record<string, unknown>): {
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
} {
  return { structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** The refusal of a tool of the common settings. */
function refuse(service: CommonSettingsNodeService, code: string, reason: string): ReturnType<typeof answer> {
  return answer({ ok: false, hostId: service.hostId, code, reason });
}

/**
 * The tools of the common settings.
 *
 * A node that has no common settings configured answers every tool with the
 * fact that it has none: it never claims a document it does not hold.
 */
export function registerCommonSettingsTools(server: McpServer, deps: { service: CommonSettingsNodeService }): void {
  const service = deps.service;

  server.registerTool("common_settings_read", {
    description: "Read the document of the common settings that this node holds. The node that owns the document answers with the current document of the fleet; a member answers with the document it holds and with nothing when it holds none.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}).strict(),
  }, async () => {
    const document = await service.document();
    const status = await service.status();
    return answer({
      ok: true,
      hostId: service.hostId,
      role: status.role,
      optIn: status.optIn,
      appliedRevision: status.appliedRevision,
      appliedAt: status.appliedAt,
      document: document ?? null,
    });
  });

  server.registerTool("common_settings_status", {
    description: "Read the state of the common settings of this node: whether it takes them, the revision it holds, when it applied it and the deviations it holds. The node never claims a revision it does not hold.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}).strict(),
  }, async () => {
    const status = await service.status();
    return answer({ ok: true, ...status });
  });

  server.registerTool("common_settings_notice", {
    description: "Tell this node that the document of the common settings moved. The node takes the document from the owner of the document and applies it to the files of its own machine, and answers with the revision it holds now and with the deviations it found.",
    inputSchema: z.object({ revision: z.string().min(1).max(128).optional() }).strict(),
  }, async (request) => {
    const result = await service.notice(request.revision ?? "");
    return answer({
      ok: result.ok,
      hostId: result.hostId,
      appliedRevision: result.appliedRevision,
      appliedAt: result.appliedAt,
      changed: result.changed,
      conflicts: result.conflicts,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });

  server.registerTool("common_settings_opt_in", {
    description: "Set whether this node takes the common settings of the owner of the document. The node itself declares it: a node that did not declare it is never written to.",
    inputSchema: z.object({ enabled: z.boolean() }).strict(),
  }, async (request) => {
    const status = await service.setOptIn(request.enabled);
    return answer({ ok: true, ...status });
  });

  server.registerTool("common_settings_restore", {
    description: "Put the local values of this node back after the common document replaced them. The common value wins again at the next round: the policy of the resolution is the same on every node.",
    inputSchema: z.object({}).strict(),
  }, async () => {
    const result = await service.restore();
    return answer({
      ok: result.ok,
      hostId: result.hostId,
      appliedRevision: result.appliedRevision,
      appliedAt: result.appliedAt,
      changed: result.changed,
      conflicts: result.conflicts,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });
}
