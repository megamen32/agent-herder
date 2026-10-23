/**
 * The transport of the common settings between the nodes of the fleet.
 *
 * The transport is the existing direct transport of the fleet: the same
 * owner-authorized SSH and the same native owner identity that the lever of
 * the owner uses. A node that does not answer throws, and the caller records
 * it as unknown — a node that did not answer never counts as synchronized.
 *
 * The document itself travels from the owner to the node in the answer of the
 * owner, not in the request: a request of the fleet transport is small, and
 * the document of the common settings is not. The document travels as it is:
 * the revision of the owner, the time of its assembly and the content travel
 * together, so the node that takes it keeps the identity of the owner and
 * never a revision of its own files.
 */

import { FleetDirectTransport } from "../mesh/fleet-direct-transport.js";
import { parseCommonSettingsDocument, type CommonSettingsDocument } from "./document.js";
import type { CommonSettingsConflict, CommonSettingsNodeStatus } from "./node-state.js";

/** The tools of the common settings on a node of the fleet. */
export const COMMON_SETTINGS_TOOLS = [
  "common_settings_read",
  "common_settings_status",
  "common_settings_notice",
  "common_settings_opt_in",
  "common_settings_restore",
] as const;

/** The transport that carries the common settings to the nodes of the fleet. */
export interface CommonSettingsTransport {
  /**
   * The document the node holds.
   *
   * The owner answers with the document it owns — the revision, the time of
   * its assembly and the content together. A member answers with the document
   * it took from the owner.
   */
  read(target: string): Promise<CommonSettingsDocument | null>;
  /** The state of the node: opt-in, applied revision and deviations. */
  status(target: string): Promise<CommonSettingsNodeStatus | null>;
  /**
   * Tell the node that the document moved: it takes the document of the owner
   * and applies it.
   *
   * The revision that travels in the signal is the revision of the owner: the
   * node answers with the revision it holds after the application, and the
   * owner compares the two.
   */
  notify(target: string, revision: string): Promise<CommonSettingsNodeStatus | null>;
  /** Set the opt-in flag of the node. */
  setOptIn(target: string, enabled: boolean): Promise<CommonSettingsNodeStatus | null>;
  /** Put the local values of the node back. */
  restore(target: string): Promise<CommonSettingsNodeStatus | null>;
}

/**
 * The transport of the common settings over the direct transport of the fleet.
 *
 * The transport raises when a node does not answer: the caller of the
 * transport decides what an unreachable node means, and it never means
 * agreement.
 */
export class DirectCommonSettingsTransport implements CommonSettingsTransport {
  constructor(private readonly transport: FleetDirectTransport = new FleetDirectTransport()) {}

  /** The document the node holds. */
  async read(target: string): Promise<CommonSettingsDocument | null> {
    const payload = await this.call(target, "common_settings_read", {});
    if (!payload || payload.ok !== true) return null;
    const document = (payload as { document?: unknown }).document;
    if (!document) return null;
    try {
      return parseCommonSettingsDocument(document);
    } catch {
      return null;
    }
  }

  /** The state of the node. */
  async status(target: string): Promise<CommonSettingsNodeStatus | null> {
    const payload = await this.call(target, "common_settings_status", {});
    return payload && payload.ok === true ? readStatus(payload) : null;
  }

  /** Tell the node that the document moved. */
  async notify(target: string, revision: string): Promise<CommonSettingsNodeStatus | null> {
    const payload = await this.call(target, "common_settings_notice", { revision });
    return payload && payload.ok === true ? readStatus(payload) : null;
  }

  /** Set the opt-in flag of the node. */
  async setOptIn(target: string, enabled: boolean): Promise<CommonSettingsNodeStatus | null> {
    const payload = await this.call(target, "common_settings_opt_in", { enabled });
    return payload && payload.ok === true ? readStatus(payload) : null;
  }

  /** Put the local values of the node back. */
  async restore(target: string): Promise<CommonSettingsNodeStatus | null> {
    const payload = await this.call(target, "common_settings_restore", {});
    return payload && payload.ok === true ? readStatus(payload) : null;
  }

  /** One tool of the common settings on a node. */
  private async call(target: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const result = await this.transport.call(target, tool, args);
    return readToolPayload(result);
  }
}

/** The state of a node, as the tool of the node answered it. */
export function readStatus(payload: Record<string, unknown>): CommonSettingsNodeStatus {
  const conflicts = Array.isArray(payload.conflicts)
    ? payload.conflicts.filter((item): item is CommonSettingsConflict => Boolean(item) && typeof item === "object")
    : [];
  return {
    hostId: typeof payload.hostId === "string" ? payload.hostId : "",
    role: payload.role === "owner" || payload.role === "member" ? payload.role : "none",
    optIn: payload.optIn === true,
    appliedRevision: typeof payload.appliedRevision === "string" ? payload.appliedRevision : null,
    appliedAt: typeof payload.appliedAt === "string" ? payload.appliedAt : null,
    conflicts,
  };
}

/** Read the payload of one MCP tool result, from its structured or text form. */
export function readToolPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent as Record<string, unknown>;
  }
  const content = record.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const value = (item as Record<string, unknown>).text;
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}
