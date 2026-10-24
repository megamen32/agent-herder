import { hostname } from "node:os";
import { z } from "zod";
import type { AgentSession, HarnessAdapter } from "./types/index.js";
import { normalizeHostId, type CoordinationNoteStore } from "./coordination-notes.js";
import { SetSessionTargetSchema } from "./mcp-tools/definitions.js";
import type { GptAdminTransport } from "./mesh/gptadmin.js";
import { FleetDirectTransport, fleetPeers, type DirectPeer } from "./mesh/fleet-direct-transport.js";
import { unwrapResult } from "./mesh/protocol.js";

/** The four states a work-target operation can end in. */
export type SessionTargetState = "updated" | "unchanged" | "unreachable" | "unsupported";

/** Receipt of one work-target operation. An unreachable machine is never reported as applied. */
export interface SessionTargetReceipt {
  sessionId: string;
  harness: string;
  hostId: string;
  cwd: string;
  previous: { hostId: string; cwd: string };
  state: SessionTargetState;
  reason?: string;
}

/** Input of one work-target operation. */
export interface SessionTargetInput {
  sessionId: string;
  harness?: string;
  hostId?: string;
  cwd?: string;
}

/** Everything the shared implementation needs to reach a live session. */
export interface SessionTargetContext {
  /** Adapters of this process; they find a session when no harness is named. */
  adapters: Map<string, HarnessAdapter>;
  /** Store of the declared work places of the sessions. */
  coordination: CoordinationNoteStore;
  /** Peer transport used to verify a work directory on another machine. */
  transport?: GptAdminTransport;
  /** The known machines of the fleet. Defaults to the fleet of this process. */
  peers?: readonly DirectPeer[];
  /** Resolves one named harness of this process; the web surface uses its own session route. */
  resolveSession?: (harness: string, sessionId: string) => Promise<AgentSession | null | undefined>;
}

/** A declared work target stays valid for one day and can be re-declared at any time. */
const WORK_TARGET_TTL_SECONDS = 24 * 60 * 60;

let defaultPeerTransport: GptAdminTransport | undefined;

/** Peer transport of the fleet; the same one the MCP tool works with. */
function peerTransport(context: SessionTargetContext): GptAdminTransport {
  if (context.transport) return context.transport;
  if (!defaultPeerTransport) {
    defaultPeerTransport = new FleetDirectTransport(fleetPeers().filter((peer) => peer.hostId !== "MacBook-Pro-User.local"));
  }
  return defaultPeerTransport;
}

/** Canonical spelling of a machine, so one machine always has one name. */
function canonicalPeer(context: SessionTargetContext, hostId: string) {
  return (context.peers ?? fleetPeers()).find((peer) => peer.hostId.toLowerCase() === hostId.toLowerCase());
}

/** Finds a live session by its native ID, optionally narrowed to one harness. */
export async function findLiveSession(adapters: Map<string, HarnessAdapter>, sessionId: string, harness?: string): Promise<AgentSession | undefined> {
  const names = harness ? [harness] : [...adapters.keys()];
  for (const name of names) {
    const adapter = adapters.get(name);
    if (!adapter) continue;
    const found = await adapter.getSession(sessionId).catch(() => null);
    if (found) return found;
  }
  return undefined;
}

/** Finds the live session the operation is about; the named harness wins over the adapter scan. */
async function resolveSession(context: SessionTargetContext, sessionId: string, harness?: string): Promise<AgentSession | undefined> {
  if (harness && context.resolveSession) {
    const session = await context.resolveSession(harness, sessionId);
    return session ?? undefined;
  }
  return await findLiveSession(context.adapters, sessionId, harness);
}

/** Reads the effective work target of a live session without changing it. */
export async function readSessionTarget(context: SessionTargetContext, args: { sessionId: string; harness?: string }): Promise<SessionTargetReceipt> {
  const session = await resolveSession(context, args.sessionId, args.harness);
  if (!session) throw new Error(`session_not_found:${args.sessionId}`);
  const declared = await context.coordination.activeWorkspaceObservation(args.sessionId);
  const hostId = declared?.hostId ?? session.hostId;
  const cwd = declared?.cwd ?? session.cwd;
  return { sessionId: args.sessionId, harness: session.harness, hostId, cwd, previous: { hostId, cwd }, state: "unchanged" };
}

/**
 * Override the work machine and/or work directory of a live session.
 * The declaration is the existing workspace mechanism, so the mesh projection
 * and the coordination roster observe the new target without a second truth.
 */
export async function applySessionTarget(context: SessionTargetContext, args: SessionTargetInput): Promise<SessionTargetReceipt> {
  const localHostId = hostname();
  const session = await resolveSession(context, args.sessionId, args.harness);
  if (!session) throw new Error(`session_not_found:${args.sessionId}`);
  const harness = session.harness;
  const declared = await context.coordination.activeWorkspaceObservation(args.sessionId);
  const previous = { hostId: declared?.hostId ?? session.hostId, cwd: declared?.cwd ?? session.cwd };
  const targetHostId = args.hostId ? normalizeHostId(args.hostId, localHostId) : previous.hostId;
  const targetCwd = args.cwd ? args.cwd.trim() : previous.cwd;
  const receipt = (state: SessionTargetState, hostId: string, cwd: string, reason?: string): SessionTargetReceipt => ({
    sessionId: args.sessionId, harness, hostId, cwd, previous, state, ...(reason ? { reason } : {}),
  });
  if (targetHostId.toLowerCase() === previous.hostId.toLowerCase() && targetCwd === previous.cwd) {
    return receipt("unchanged", previous.hostId, previous.cwd);
  }
  if (targetHostId.toLowerCase() === localHostId.toLowerCase()) {
    await context.coordination.declareWorkspace({ sessionId: args.sessionId, harness, hostId: localHostId, cwd: targetCwd, ttlSeconds: WORK_TARGET_TTL_SECONDS });
    return receipt("updated", localHostId, targetCwd);
  }
  // Another machine: the directory must be proven on that machine first.
  const peer = canonicalPeer(context, targetHostId);
  if (!peer) return receipt("unreachable", targetHostId, targetCwd, `host_target_unavailable:${targetHostId}`);
  let verifiedCwd: string;
  try {
    const probed = unwrapResult(await peerTransport(context).call(`mcp:shell:${peer.hostId}:AgentHerder`, "workspace_probe", { cwd: targetCwd }));
    if (probed.hostId !== peer.hostId || typeof probed.cwd !== "string" || !probed.cwd.startsWith("/")) throw new Error("workspace_probe_invalid");
    verifiedCwd = probed.cwd;
  } catch {
    return receipt("unreachable", peer.hostId, targetCwd, `host_target_unavailable:${peer.hostId}`);
  }
  await context.coordination.declareWorkspace({ sessionId: args.sessionId, harness, hostId: peer.hostId, cwd: verifiedCwd, ttlSeconds: WORK_TARGET_TTL_SECONDS });
  return receipt("updated", peer.hostId, verifiedCwd);
}

const sessionTargetQuerySchema = z.object({
  sessionId: z.string().trim().min(1).max(512),
  harness: z.string().trim().min(1).max(64).optional(),
});

/** Human-readable reason of a rejected request. */
function issueMessage(issue: z.ZodIssue): string {
  if (issue.path[0] === "sessionId") return "sessionId обязателен";
  if (issue.message === "Provide hostId or cwd") return "Укажите hostId или cwd";
  return issue.message;
}

/** Validates the body of a work-target operation exactly like the MCP tool does. */
export function parseSessionTargetInput(body: unknown): { ok: true; value: SessionTargetInput } | { ok: false; error: string } {
  const parsed = SetSessionTargetSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: issueMessage(parsed.error.issues[0]!) };
  return { ok: true, value: parsed.data };
}

/** Validates the query of a work-target read: the session alone is enough. */
export function parseSessionTargetQuery(body: unknown): { ok: true; value: { sessionId: string; harness?: string } } | { ok: false; error: string } {
  const parsed = sessionTargetQuerySchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: issueMessage(parsed.error.issues[0]!) };
  return { ok: true, value: parsed.data };
}

/**
 * HTTP-shaped entry of the work target: the same contract and the same receipt
 * as the MCP tool, so the web surface cannot drift away from it.
 */
export async function sessionTargetRequest(
  context: SessionTargetContext,
  input: { method: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const parsed = input.method === "POST" ? parseSessionTargetInput(input.body) : parseSessionTargetQuery(input.body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  try {
    const receipt = input.method === "POST"
      ? await applySessionTarget(context, parsed.value)
      : await readSessionTarget(context, parsed.value);
    return { status: 200, body: receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("session_not_found:")) return { status: 404, body: { error: message } };
    return { status: 502, body: { error: message } };
  }
}
