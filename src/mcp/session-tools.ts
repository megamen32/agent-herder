import type { McpServer } from "@modelcontextprotocol/server";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HarnessAdapter } from "../types/index.js";
import { sessionIdentity } from "../session-identity.js";
import type { HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import { UserMessageDelivery } from "../user-message-delivery.js";
import { captureDeliveryResponseBaseline, nativeDeliveryResponseComplete, nativeDeliveryResponseCompleteByInput, waitForDeliveryResponse, type DeliveryResponseBaseline, type DeliveryResponseResult, type DeliveryResponseTarget } from "../session-delivery-response.js";
import { callerSessionFromMcpContext } from "./caller-session.js";
import type { SendMessageResult } from "../types/index.js";
import { trustedMeshIngressFromMcpAuthInfo } from "../mesh/authenticated-ingress.js";
import {
  SendMessageSchema,
  CreateSessionSchema,
  NewOrResumeSchema,
  DeliverSchema,
  ResumeAgentSchema,
  SetSessionTargetSchema,
  SetSessionTargetResultSchema,
} from "../mcp-tools/definitions.js";
import {
  listAgentsResult,
  formatListAgentsResult,
  agentInfoResult,
  findParentResult,
  findSession,
  listChildrenResult,
  listModelsResult,
  formatSession,
  formatFindParentResult,
  formatListChildrenResult,
  formatListModelsResult,
  handleExportTranscript,
  handleSendMessage,
  handleCreateSession,
  handleNewOrResume,
  handleDeliver,
  handleStopAgent,
  handleRespondPermission,
  handleSetPermissions,
  handleResumeAgent,
  handleChangeModel,
  handleListModels,
  handleAuditWorktrees,
} from "../mcp-tools/handlers.js";
import { startJobResult } from "./results.js";
import { readModelQuotas } from "../model-quota.js";
import type { IntegratorFleetRuntime } from "../integrator-fleet-runtime.js";
import { coordinationNotes, normalizeHostId, type CoordinationNoteStore } from "../coordination-notes.js";
import type { GptAdminTransport } from "../mesh/gptadmin.js";
import { unwrapResult, type MeshAddress } from "../mesh/protocol.js";
import { FleetDirectTransport, fleetPeers, type DirectPeer } from "../mesh/fleet-direct-transport.js";
import { composeSessionTitle, mergeSessionLabel, writeSessionLabel } from "../session-labels.js";
import { assertModelAllowedForDirectory, assertModelAllowedForDirectoryWithPolicy, policyRestrictsModels, type ProjectModelPolicyProvider } from "../project-model-gate.js";
import { checkDeliveryModel, resolveSessionWorkDirectory, type ProjectModelPolicyStateProvider } from "../project-model-delivery-gate.js";
import { applySessionTarget } from "../session-target.js";
import type {SessionQueueControlGateway} from "../session-queue-control-gateway.js";

const harnessSchema = z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code"]);

const sessionSchema = z.object({
  id: z.string(), harness: harnessSchema, status: z.enum(["running", "idle", "needs_input", "stopped", "error"]), title: z.string(), cwd: z.string(), hostId: z.string(), launchCwd: z.string().optional(), lastActivity: z.string(),
  model: z.string().optional(), needsPermission: z.boolean(), permissionDetails: z.object({ id: z.string(), type: z.string(), description: z.string(), toolName: z.string().optional(), details: z.string().optional() }).optional(),
  messageCount: z.number().optional(), costUsd: z.number().optional(), durationSec: z.number().optional(), lastMessage: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(),
});

/** Work target of a live session: the machine it works on and the directory it works in. */
export interface SessionWorkTarget { hostId: string; cwd: string }

/** Router that can retarget a session living on another machine of the fleet. */
export interface FleetSessionTargetRouter {
  setSessionTarget(address: MeshAddress, target: { hostId: string; cwd?: string }): Promise<{
    state: "updated" | "unchanged" | "unreachable" | "unsupported";
    hostId: string;
    cwd: string;
    reason?: string;
  }>;
}

export function registerSessionTools(server: McpServer, deps: {
  adapters: Map<string, HarnessAdapter>;
  jobs: HerderJobRegistry;
  events: HerderEventBus;
  integratorRuntime?: Pick<IntegratorFleetRuntime, "adapterForSession">;
  /** Session work target store. Defaults to the process-wide coordination store. */
  coordination?: CoordinationNoteStore;
  /** Peer transport used to verify a work directory on another machine. */
  transport?: GptAdminTransport;
  /** Peers this process may call. Defaults to the fleet; a unit test narrows it to nobody. */
  routingPeers?: readonly DirectPeer[];
  /** Fleet router used to retarget a session that lives on another machine. */
  fleet?: FleetSessionTargetRouter;
  /** Reads the current launch policy for the per-project model gate. */
  launchPolicy?: ProjectModelPolicyProvider;
  /** Reads the current launch policy state for the per-project model gate of a delivery. */
  deliveryPolicy?: ProjectModelPolicyStateProvider;
  /** Shared durable queue for public human delivery into native sessions. */
  userMessageDelivery?: UserMessageDelivery;
  /** Owner-routed explicit ZCode queue processing, backed by its native owner's durable job registry. */
  sessionQueueControl?: SessionQueueControlGateway;
}): void {
  const { adapters, jobs, events } = deps;
  const userMessageDelivery = deps.userMessageDelivery ?? new UserMessageDelivery(adapters, {
    sendMessage: async (harness, sessionId, options) => {
      const adapter = adapters.get(harness);
      return adapter ? adapter.sendMessage(sessionId, options) : { ok: false, notSubmitted: true, error: "Адаптер отправки недоступен" };
    },
  }, jobs);
  const observeExistingUserDelivery = async (harness: string, sessionId: string, inputId: string, target: DeliveryResponseTarget | undefined): Promise<DeliveryResponseResult | undefined> => {
    const receipt = userMessageDelivery.get(harness, sessionId, inputId);
    const job = receipt?.job;
    const adapter = adapters.get(harness);
    if (!job || !adapter?.getSession || !target) return undefined;
    const deadline = Date.now() + 30_000;
    let baseline: DeliveryResponseBaseline | undefined;
    while (!baseline && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = userMessageDelivery.readDeliveryResponseBaseline(job.id, inputId, target);
      const timedOut = Symbol("response-baseline-deadline");
      try {
        const value = await Promise.race([
          read,
          new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), remaining); }),
        ]);
        if (value === timedOut) break;
        baseline = value;
      }
      catch {
        const latest = jobs.get<SendMessageResult>(job.id);
        if (!latest || ["failed", "cancelled", "interrupted", "completed"].includes(latest.state)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!baseline) {
      baseline=await captureDeliveryResponseBaseline({jobId:job.id,inputId,target,readMessages:async()=>({messages:null,complete:false})});
    }
    return await waitForDeliveryResponse({
      jobId: job.id, inputId, target, baseline,
      readJob: (id) => jobs.get<SendMessageResult>(id),
      readHistory: async (requested, limit) => {
        const current = await adapter.getSession(requested.sessionId);
        if (!current || current.id !== requested.sessionId || current.harness !== requested.harness || current.hostId !== requested.hostId) return { messages: null };
        const page = adapter.getSessionMessagesPage
          ? await adapter.getSessionMessagesPage(requested.sessionId, limit)
          : undefined;
        if (adapter.getSessionMessagesPage && (!page || page.sessionId !== requested.sessionId || page.source !== "native-db")) return { messages: null };
        if (!adapter.getSessionMessagesPage && !adapter.getSessionMessages) return { messages: null };
        const messages = page?.messages ?? (page === undefined ? await adapter.getSessionMessages!(requested.sessionId, limit) : null);
        if (!messages) return { messages: null };
        const fresh = await adapter.getSession(requested.sessionId);
        if (!fresh || fresh.id !== requested.sessionId || fresh.harness !== requested.harness || fresh.hostId !== requested.hostId) return { messages: null };
        const latestJob = jobs.get<SendMessageResult>(job.id);
        const nativeInputMessageId=latestJob?.result?.nativeInputMessageId;
        const inputTailComplete=requested.harness==='opencode'&&typeof nativeInputMessageId==='string'
          &&messages.filter(message=>message.id===nativeInputMessageId&&message.role==='user').length===1;
        const history={messages,complete:page?.complete===true,inputTailComplete};
        const exactCompletion=nativeDeliveryResponseCompleteByInput({target:requested,inputId,job:latestJob,before:current,after:fresh,history});
        return { ...history, turnComplete: (nativeDeliveryResponseComplete(current, latestJob) && nativeDeliveryResponseComplete(fresh, latestJob))||exactCompletion };
      },
      recordResponseReceipt: (id, value) => jobs.recordDeliveryResponseReceipt(id, value),
      waitMs: Math.max(0, deadline - Date.now()),
      returnOnVisibleText: true,
    });
  };
  const coordination = deps.coordination ?? coordinationNotes;
  let peerTransport: GptAdminTransport | undefined = deps.transport;
  /**
   * The peer that owns the named machine, if this process may call it. A machine
   * that is not callable is not an error here: the caller decides what it means
   * (a browse has no sessions of it, a message has no route to it).
   */
  function selectedRemotePeer(hostId?: string): DirectPeer | undefined {
    const requested = normalizeHostId(hostId, hostname());
    if (requested.toLowerCase() === hostname().toLowerCase()) return undefined;
    return (deps.routingPeers ?? fleetPeers()).find(candidate => candidate.hostId.toLowerCase() === requested.toLowerCase());
  }
  /**
   * Override the work machine and/or work directory of a live session.
   * The declaration is the existing workspace mechanism, so the mesh projection
   * and the coordination roster observe the new target without a second truth.
   * The web surface calls the same implementation, so both answer alike.
   */
  async function setSessionTarget(args: { sessionId: string; harness?: string; hostId?: string; cwd?: string }) {
    return await applySessionTarget({
      adapters,
      coordination,
      ...(peerTransport ? { transport: peerTransport } : {}),
    }, args);
  }

  /**
   * Rename one native session of another machine through the fleet peer.
   *
   * The native title lives in the harness of the machine that owns the
   * session, so the rename runs there. The address is checked against the
   * machine the call really reaches, and an unproven rename is reported as
   * such instead of being replayed.
   */
  async function renameRemoteSession(
    args: { sessionId: string; harness?: string; title?: string; project?: string; goal?: string; stage?: string },
    hostId: string,
    transport?: GptAdminTransport,
  ) {
    const fail = (error: string) => ({
      content: [{ type: "text" as const, text: error }],
      structuredContent: { ok: false, supported: false, sessionId: args.sessionId, hostId, error },
    });
    if (!args.harness) {
      return fail(`Session '${args.sessionId}' lives on host '${hostId}': name its harness to rename it there.`);
    }
    const peer = transport ?? new FleetDirectTransport(fleetPeers().filter((candidate) => candidate.hostId !== "MacBook-Pro-User.local"));
    let reply: Record<string, unknown>;
    try {
      reply = unwrapResult(await peer.call(`mcp:shell:${hostId}:AgentHerder`, "mesh_rename_session", {
        target: { hostId, harness: args.harness, nativeSessionId: args.sessionId },
        ...(args.title ? { title: args.title } : {}),
        ...(args.project ? { project: args.project } : {}),
        ...(args.goal ? { goal: args.goal } : {}),
        ...(args.stage ? { stage: args.stage } : {}),
      }));
    } catch (error) {
      return fail(`Failed to rename [${args.harness}] ${args.sessionId} on host '${hostId}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = String(reply.state ?? "");
    const reason = typeof reply.reason === "string" && reply.reason ? `: ${reply.reason}` : "";
    const label = (reply.label ?? {}) as { project?: string; goal?: string; stage?: string };
    // The peer that owns the session stores the metadata and tells the two
    // outcomes apart with renamed: the native name changed, or it did not
    // change and the receipt says why.
    if (reply.renamed === false) {
      const renameError = typeof reply.renameError === "string" && reply.renameError
        ? reply.renameError
        : (typeof reply.reason === "string" && reply.reason ? reply.reason : "у среды нет нативного канала переименования.");
      publishSessionsChanged();
      const structured = {
        ok: true,
        supported: true,
        sessionId: args.sessionId,
        harness: args.harness,
        hostId,
        renamed: false,
        previousTitle: typeof reply.previousTitle === "string" ? reply.previousTitle : null,
        title: typeof reply.title === "string" ? reply.title : undefined,
        renameError,
        label,
      };
      return {
        content: [{ type: "text" as const, text: `Метка сохранена. Имя сессии не изменилось — ${renameError}` }],
        structuredContent: structured,
      };
    }
    if (state === "renamed") {
      publishSessionsChanged();
      const nativeTitle = typeof reply.nativeTitle === "string"
        ? reply.nativeTitle
        : (typeof reply.title === "string" ? reply.title : undefined);
      const structured = {
        ok: true,
        supported: true,
        sessionId: args.sessionId,
        harness: args.harness,
        hostId,
        renamed: true,
        previousTitle: typeof reply.previousTitle === "string" ? reply.previousTitle : null,
        title: typeof reply.title === "string" ? reply.title : undefined,
        ...(nativeTitle !== undefined ? { nativeTitle } : {}),
        label,
      };
      return {
        content: [{ type: "text" as const, text: `Сохранено. Название сессии: «${nativeTitle ?? ""}».` }],
        structuredContent: structured,
      };
    }
    // An older peer does not report renamed: its honest refusals stay refusals.
    if (state === "unsupported") {
      return fail(`Host '${hostId}' cannot rename a [${args.harness}] session${reason}`);
    }
    if (state === "not_found") {
      return fail(`Session '${args.sessionId}' was not found on host '${hostId}'${reason}`);
    }
    return fail(`The rename of [${args.harness}] ${args.sessionId} on host '${hostId}' is unproven and must not be replayed${reason}`);
  }
  async function sessionRoute<T extends { sessionId?: string; harness?: string; hostId?: string }>(args: T) {
    if (!args.sessionId || !deps.integratorRuntime) return { adapters, args, denied: false, hostTargetUnavailable: undefined as string | undefined };
    const hostId = normalizeHostId(args.hostId, hostname());
    const resolution = await deps.integratorRuntime.adapterForSession({ hostId, harness: "codex", nativeSessionId: args.sessionId });
    if (resolution.kind === "deny") return { adapters, args, denied: true, hostTargetUnavailable: undefined as string | undefined };
    if (resolution.kind === "ordinary") {
      // Another machine has no adapter in this process. Say so instead of
      // reporting a missing local session.
      const unavailable = hostId === hostname() ? undefined : hostId;
      return { adapters, args, denied: false, hostTargetUnavailable: unavailable };
    }
    if (args.harness && args.harness !== "codex") return { adapters, args, denied: true, hostTargetUnavailable: undefined as string | undefined };
    const routed = new Map(adapters);
    routed.set("codex", resolution.adapter);
    return { adapters: routed, args: { ...args, harness: "codex" } as T, denied: false, hostTargetUnavailable: undefined as string | undefined };
  }
  const publishSessionsChanged = () => events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed" });

  /**
   * The per-project model gate of one delivery.
   *
   * A session that was born outside herder's tools never passed through the
   * tool gate, so the delivery checks the model the session would run on
   * itself. The project is the work place of the session: its declared work
   * place first, then its own working directory.
   */
  async function assertDeliveryModelAllowed(
    sessionAdapters: Map<string, HarnessAdapter>,
    target: { sessionId?: string; harness?: string; cwd?: string; model?: string },
  ): Promise<void> {
    if (!deps.deliveryPolicy) return;
    const state = await deps.deliveryPolicy();
    const directory = target.cwd?.trim() || null;
    if (directory) {
      checkDeliveryModel(state, { directory, harness: target.harness ?? "", model: target.model });
      return;
    }
    if (!target.sessionId) return;
    const session = await findSessionForGate(sessionAdapters, target.sessionId, target.harness);
    // A session that does not exist starts no work, so there is nothing to guard.
    if (!session) return;
    const declared = await coordination.activeWorkspaceObservation(target.sessionId).catch(() => undefined);
    checkDeliveryModel(state, {
      directory: resolveSessionWorkDirectory(session, declared?.cwd),
      harness: session.harness,
      model: target.model,
    });
  }

  /** The session behind a delivery target, when it exists. */
  async function findSessionForGate(
    sessionAdapters: Map<string, HarnessAdapter>,
    sessionId: string,
    harness?: string,
  ): Promise<{ id: string; harness: string; cwd: string; meta?: Record<string, unknown> } | null> {
    const candidates = harness
      ? [sessionAdapters.get(harness)].filter(Boolean) as HarnessAdapter[]
      : [...sessionAdapters.values()];
    for (const adapter of candidates) {
      try {
        const session = await adapter.getSession(sessionId);
        if (session) return session as { id: string; harness: string; cwd: string; meta?: Record<string, unknown> };
      } catch {
        // A session that cannot be read is a session that cannot be guarded.
      }
    }
    return null;
  }

  /** The working directory of one session, or undefined when it cannot be read. */
  async function sessionCwd(
    sessionAdapters: Map<string, HarnessAdapter>,
    sessionId: string,
    harness?: string,
  ): Promise<string | undefined> {
    const candidates = harness
      ? [sessionAdapters.get(harness)].filter(Boolean) as HarnessAdapter[]
      : [...sessionAdapters.values()];
    for (const adapter of candidates) {
      try {
        const session = await adapter.getSession(sessionId);
        if (session?.cwd) return session.cwd;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  server.registerTool("list_agents", { description: "Historical/session browsing. For a current global active inventory with actual code work hosts, multiple paths and freshness use list_active_sessions. List coding agent sessions, including ZCode. Filter by harness, status, age (maxAge seconds), folder (CWD prefix like ~/apps) or machine (hostId). Omitted hostId lists sessions of every machine. Can show last message preview.", inputSchema: z.object({
    harness: z.enum(["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code"]).optional().default("all"),
    status: z.enum(["all", "running", "idle", "needs_input", "stopped", "error"]).optional().default("all"),
    limit: z.number().int().min(1).max(100).optional().default(20), maxAge: z.number().int().min(0).optional(), folder: z.string().optional(),
    hostId: z.string().trim().min(1).max(512).optional().describe("Filter by machine. Omitted lists sessions of every machine."),
    includeLastMessage: z.boolean().optional().default(false),
  }), outputSchema: z.object({
    complete: z.boolean(), unavailable: z.array(z.object({harness:z.string(),error:z.string()})),
    sessions: z.array(sessionSchema), total: z.number().int().min(0), limited: z.boolean(),
    filters: z.object({ harness: z.string(), status: z.string(), maxAge: z.number().optional(), folder: z.string().optional(), hostId: z.string().optional(), includeLastMessage: z.boolean() }),
  }) }, async (args) => {
    const peer = selectedRemotePeer(args.hostId);
    if (peer) {
      const {hostId: _hostId, ...ownerArgs} = args;
      const result = unwrapResult(await (peerTransport ?? new FleetDirectTransport([peer])).call(`mcp:shell:${peer.hostId}:AgentHerder`, "list_agents", ownerArgs));
      const sessions = z.array(sessionSchema).parse(result.sessions);
      if (sessions.some(session => session.hostId !== peer.hostId)) throw new Error("remote_session_identity_mismatch");
      for (const session of sessions) {
        const scope = await deps.integratorRuntime?.adapterForSession({hostId:peer.hostId,harness:session.harness,nativeSessionId:session.id});
        if (scope && scope.kind !== "ordinary") throw new Error("project_session_scope_unavailable");
      }
      if (typeof result.complete !== "boolean" || !Array.isArray(result.unavailable) || !Number.isInteger(result.total) || typeof result.limited !== "boolean") throw new Error("remote_session_list_invalid");
      const remote = {complete:result.complete,unavailable:z.array(z.object({harness:z.string(),error:z.string()})).parse(result.unavailable),total:Number(result.total),limited:result.limited,sessions,filters:{...args,hostId:peer.hostId}};
      return {content:[{type:"text" as const,text:formatListAgentsResult(remote)}],structuredContent:remote};
    }
    const result = await listAgentsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListAgentsResult(result) }], structuredContent: result };
  });

  server.registerTool("audit_worktrees", { description: "Read-only Git worktree audit: dirty files, lock/PID state, and Claude/Codex/OpenCode/ZCode processes whose cwd is inside each worktree.", inputSchema: z.object({ repoPath: z.string(), includeClean: z.boolean().optional().default(false) }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleAuditWorktrees(args) }] }));
  server.registerTool("model_quotas", {
    description: "Read current GLM Coding Plan, MiniMax Token Plan and local Codex usage allowances. Returns unknown when credentials or official account usage are unavailable; never guesses quota values.",
    inputSchema: z.object({}),
  }, async () => {
    const result = await readModelQuotas();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("agent_info", { description: "Get detailed info about a specific session. Always shows model and last message. Select hostId and harness to read an existing session on another machine.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), hostId: z.string().trim().min(1).max(512).optional() }), outputSchema: z.object({ session: sessionSchema.nullable() }) }, async (args) => {
    const requestedHost = normalizeHostId(args.hostId, hostname());
    if (requestedHost.toLowerCase() !== hostname().toLowerCase()) {
      const peer = (deps.routingPeers ?? fleetPeers()).find(candidate => candidate.hostId.toLowerCase() === requestedHost.toLowerCase());
      if (!peer || !args.harness) throw new Error("remote_session_host_and_harness_required");
      const scope = await deps.integratorRuntime?.adapterForSession({ hostId: peer.hostId, harness: args.harness, nativeSessionId: args.sessionId });
      if (scope?.kind === "deny") throw new Error("project_session_scope_unavailable");
      // Scoped sessions must remain on their configured adapter; the ordinary
      // native peer must never become a second way around that boundary.
      if (scope?.kind === "scoped") {
        const session = await agentInfoResult(new Map([[args.harness, scope.adapter]]), args);
        return { content: [{ type: "text" as const, text: session ? formatSession(session, true) : `Session '${args.sessionId}' not found.` }], structuredContent: { session } };
      }
      // A personal Mac is selected explicitly here; this does not enroll it
      // into the default mesh or grant any delivery/activation capability.
      const transport = peerTransport ?? new FleetDirectTransport([peer]);
      if (!transport.readSession) throw new Error("remote_session_read_unavailable");
      const result = unwrapResult(await transport.readSession(`mcp:shell:${peer.hostId}:AgentHerder`, args.harness, args.sessionId));
      const details = result.details as { session?: unknown } | undefined;
      const parsed = sessionSchema.safeParse(details?.session);
      if (result.hostId !== peer.hostId || !parsed.success || parsed.data.hostId !== peer.hostId || parsed.data.id !== args.sessionId || parsed.data.harness !== args.harness) throw new Error("remote_session_identity_mismatch");
      return { content: [{ type: "text" as const, text: formatSession(parsed.data, true) }], structuredContent: { session: parsed.data } };
    }
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const session = await agentInfoResult(route.adapters, route.args);
    return { content: [{ type: "text" as const, text: session ? formatSession(session, true) : `Session '${args.sessionId}' not found.` }], structuredContent: { session } };
  });
  server.registerTool("session_identity", {
    description:
      "Read your own session identity (name, native id, harness and workspace) when sessionId is omitted, using native caller metadata supplied by the MCP client. " +
      "Pass sessionId explicitly to inspect another session. Never guess your own ID from a session list. If native caller metadata is absent, an explicit sessionId is required. " +
      "With announce=true the identity is published into the session's own instructions so an OpenCode 2 agent can answer 'who am I' from its next turn.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1).optional(),
      harness: harnessSchema.optional(),
      name: z.string().trim().min(1).max(128).optional().describe("Name to publish; defaults to the native title."),
      announce: z.boolean().optional().default(false).describe("Publish the identity into the session itself."),
    }),
    outputSchema: z.object({
      sessionId: z.string(), harness: z.string(), name: z.string(), cwd: z.string(),
      status: z.string().optional(), announced: z.boolean().optional(), reason: z.string().optional(),
    }).nullable(),
  }, async (rawArgs, ctx) => {
    const caller = rawArgs.sessionId ? null : callerSessionFromMcpContext(ctx);
    if (!rawArgs.sessionId && !caller) throw new Error("caller_session_unavailable: MCP не передал ID текущей сессии; укажите подтверждённый sessionId явно.");
    if (!rawArgs.sessionId && rawArgs.harness && rawArgs.harness !== caller!.harness) throw new Error("caller_session_harness_mismatch");
    const args = { ...rawArgs, sessionId: rawArgs.sessionId ?? caller!.sessionId, harness: rawArgs.harness ?? caller?.harness };
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const harness = route.args.harness ? [route.args.harness] : [...route.adapters.keys()];
    let owned: HarnessAdapter | undefined;
    for (const name of harness) {
      const adapter = route.adapters.get(name);
      if (!adapter) continue;
      if (await adapter.getSession(args.sessionId).catch(() => null)) { owned = adapter; break; }
    }
    if (!owned) return { content: [{ type: "text" as const, text: `Session '${args.sessionId}' not found.` }], structuredContent: null };
    const identity = await sessionIdentity(owned, {
      sessionId: args.sessionId,
      ...(args.name ? { name: args.name } : {}),
      announce: args.announce === true,
    });
    const text = identity
      ? [
          `Session ${identity.sessionId} [${identity.harness}] is named "${identity.name}" and works in ${identity.cwd}.`,
          ...(identity.announced === true ? ["The identity was published into the session's own instructions."] : []),
          ...(identity.reason ? [`Not published: ${identity.reason}`] : []),
        ].join("\n")
      : `Session '${args.sessionId}' not found.`;
    return { content: [{ type: "text" as const, text }], structuredContent: identity };
  });

  server.registerTool("rename_session", {
    description:
      "Rename one existing session in place: the native title of the same session changes. " +
      "No session is created, no model turn starts and no active turn is interrupted. " +
      "Without a title the name is composed as 'goal | short project name' from stored Herder metadata; stage is omitted. " +
      "The metadata of the session is stored first and on its own; the native name is an optional operation of the harness. " +
      "The answer tells the two outcomes apart with renamed: the name changed, or it did not change and says why.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1).max(512),
      harness: harnessSchema.optional(),
      hostId: z.string().trim().min(1).max(512).optional()
        .describe("Machine that owns the session. Omitted renames a session of this machine."),
      title: z.string().trim().min(1).max(4096).optional()
        .describe("Exact new title. If omitted, Herder composes 'goal | short project name' and omits stage."),
      project: z.string().trim().min(1).max(512).optional().describe("The constant project of the session."),
      goal: z.string().trim().min(1).max(2048).optional().describe("The current business goal of the session."),
      stage: z.string().trim().min(1).max(2048).optional().describe("The current stage of the plan."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      supported: z.boolean().optional(),
      sessionId: z.string().optional(),
      harness: z.string().optional(),
      hostId: z.string().optional(),
      renamed: z.boolean().optional(),
      previousTitle: z.string().nullable().optional(),
      title: z.string().optional(),
      nativeTitle: z.string().optional(),
      renameError: z.string().optional(),
      label: z.object({ project: z.string().optional(), goal: z.string().optional(), stage: z.string().optional() }).optional(),
      error: z.string().optional(),
    }),
  }, async (args) => {
    const owner = args.hostId ? normalizeHostId(args.hostId, hostname()) : hostname();
    // Another machine owns its own native session, so the rename runs there.
    if (owner !== hostname()) return renameRemoteSession(args, owner, peerTransport);
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const found = await findSession(route.adapters, args.sessionId, route.args.harness);
    if (!found) {
      const error = `Session '${args.sessionId}' was not found.`;
      return { content: [{ type: "text" as const, text: error }], structuredContent: { ok: false, supported: false, error } };
    }
    const adapter = found.adapter;
    const patch = { project: args.project, goal: args.goal, stage: args.stage };
    const hasFields = args.project !== undefined || args.goal !== undefined || args.stage !== undefined;
    // The composed title uses the stored fields and the new ones together, so
    // a single-field update never empties the other two.
    const merged = hasFields
      ? await mergeSessionLabel(found.session.harness, found.session.id, patch)
      : await mergeSessionLabel(found.session.harness, found.session.id, {});
    const title = args.title?.trim() || composeSessionTitle(merged);
    if (!title) {
      const error = "A session title is required: give a title, a project name, or a task goal.";
      return { content: [{ type: "text" as const, text: error }], structuredContent: { ok: false, supported: true, sessionId: args.sessionId, harness: found.session.harness, hostId: owner, error } };
    }
    // The metadata is written first and on its own: it belongs to Herder and
    // does not depend on what the harness can or cannot do with a name.
    const label = hasFields
      ? await writeSessionLabel(found.session.harness, found.session.id, patch)
      : merged;
    // The native name is an optional operation of the harness. The answer tells
    // the two outcomes apart: the name changed, or it did not change and says
    // why. A failed rename never takes the stored metadata away.
    let renamed = false;
    let previousTitle: string | null = null;
    let nativeTitle: string | undefined;
    let renameError: string | undefined;
    if (typeof adapter.renameSession !== "function") {
      renameError = `У среды '${found.session.harness}' нет нативного канала переименования: имя сессии осталось прежним.`;
    } else {
      const result = await adapter.renameSession(found.session.id, { title });
      previousTitle = result.previousTitle ?? null;
      if (result.ok) {
        renamed = true;
        nativeTitle = result.title ?? title;
      } else {
        renameError = result.error || "Нативное переименование не удалось.";
      }
    }
    publishSessionsChanged();
    const structured = {
      ok: true,
      supported: true,
      sessionId: args.sessionId,
      harness: found.session.harness,
      hostId: owner,
      renamed,
      previousTitle,
      title,
      ...(nativeTitle !== undefined ? { nativeTitle } : {}),
      ...(renameError !== undefined ? { renameError } : {}),
      label,
    };
    return {
      content: [{ type: "text" as const, text: renamed
        ? `Сохранено. Название сессии: «${nativeTitle ?? title}».`
        : `Метка сохранена. Имя сессии не изменилось — ${renameError}` }],
      structuredContent: structured,
    };
  });

  server.registerTool("find_parent", { description: "Find the native parent session of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), parent: sessionSchema.nullable(), supported: z.boolean(), error: z.string().optional() }) }, async (args) => {
    const result = await findParentResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatFindParentResult(args.sessionId, result) }], structuredContent: result };
  });
  server.registerTool("list_children", { description: "List the native child sessions of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), children: z.array(sessionSchema), supported: z.boolean(), error: z.string().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const result = await listChildrenResult(route.adapters, route.args);
    return { content: [{ type: "text" as const, text: formatListChildrenResult(args.sessionId, result) }], structuredContent: result };
  });

  server.registerTool("export_transcript", { description: "Export the raw adapter-owned transcript and return a filesystem navigation card.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    return { content: [{ type: "text" as const, text: await handleExportTranscript(route.adapters, route.args) }] };
  });
  server.registerTool("export_transcript_async", { description: "Export a raw adapter-owned transcript as a Herder background job.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), ownerSessionId: z.string().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    return startJobResult(jobs, "transcript-export", async (signal, progress) => {
      progress(0.1, "Exporting transcript");
      return handleExportTranscript(route.adapters, route.args, undefined, signal);
    }, args.ownerSessionId);
  });

  server.registerTool("set_session_target", {
    description:
      "Override the work machine and/or work directory of an already live session. " +
      "hostId and cwd are both optional, but at least one of them must be given; an omitted one keeps the current value. " +
      "A machine that cannot be reached is reported as unreachable and never applied locally.",
    inputSchema: SetSessionTargetSchema,
    outputSchema: SetSessionTargetResultSchema,
  }, async (args) => {
    const result = await setSessionTarget(args);
    publishSessionsChanged();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool("send_message", { description: "Send a message to an agent and wait up to 30 seconds for new visible assistant text. The result includes the existing delivery job reference and a read-only response resource; reading it never resends the message. Ordinary coordination defaults to mode:\"steer\" for the current active turn. Explicit queue and sync use the shared durable delivery and may start work according to the harness. Agent sends require authenticated owner-MCP ingress; sender fields are attribution only. Explicit humanRequested=true marks a human new task/send/resume. inputId deduplicates retries for 24 hours. Active coordination notes are injected automatically. fromSessionId/fromHarness add verified reply attribution, do not authenticate the caller. queue is intentional deferred work and may wait for current work to finish; it is not an immediate exchange. sync is a delivery mode and does not change the bounded response wait.", inputSchema: SendMessageSchema }, async (args, ctx) => {
    const peer = selectedRemotePeer(args.hostId);
    if (peer) {
      if (!args.harness) throw new Error("remote_session_host_and_harness_required");
      const scope = await deps.integratorRuntime?.adapterForSession({hostId:peer.hostId,harness:args.harness,nativeSessionId:args.sessionId});
      if (scope?.kind === "deny") throw new Error("project_session_scope_unavailable");
      if (!scope || scope.kind === "ordinary") {
        const {hostId: _hostId, ...ownerArgs} = args;
        // The owner applies its model/active-turn gates. Never retry an uncertain call.
        try {
          return await (peerTransport ?? new FleetDirectTransport([peer])).call(`mcp:shell:${peer.hostId}:AgentHerder`, "send_message", ownerArgs) as {content:Array<{type:"text";text:string}>};
        } catch {
          return {content:[{type:"text" as const,text:JSON.stringify({ok:false,delivery:"unknown",inputId:args.inputId,admissionUnknown:true,nonRetryable:true,error:"remote_delivery_outcome_unknown"})}]};
        }
      }
    }
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    await assertDeliveryModelAllowed(route.adapters, { sessionId: args.sessionId, harness: args.harness });
    const found = await findSession(route.adapters, args.sessionId, args.harness);
    const harness = found?.session.harness ?? route.args.harness ?? args.harness;
    const inputId = args.inputId ?? (found ? createHash("sha256").update(JSON.stringify({
      hostId: found.session.hostId ?? "unknown", harness: found.session.harness, sessionId: found.session.id,
      mode: args.mode, message: args.message, humanRequested: args.humanRequested === true,
    })).digest("hex") : undefined);
    const requestArgs = { ...route.args, ...(harness ? { harness } : {}), ...(inputId ? { inputId } : {}) };
    let resolvedTarget: DeliveryResponseTarget | undefined;
    const result = await handleSendMessage(route.adapters, requestArgs,
      userMessageDelivery, trustedMeshIngressFromMcpAuthInfo(ctx.http?.authInfo), (session) => {
        if (session.hostId) resolvedTarget = { hostId: session.hostId, harness: session.harness as DeliveryResponseTarget["harness"], sessionId: session.id };
      });
    const response = harness && inputId ? await observeExistingUserDelivery(harness, args.sessionId, inputId, resolvedTarget) : undefined;
    const receipt = harness && inputId ? userMessageDelivery.get(harness, args.sessionId, inputId) : null;
    const job = receipt?.job;
    const terminalWithoutReceipt = Boolean(job && ["failed", "cancelled", "interrupted"].includes(job.state) && !job.result);
    const delivery = job?.result?.notSubmitted
      ? JSON.stringify({ ok: false, delivery: "not_attempted", inputId, notSubmitted: true, nonRetryable: true,
        error: typeof job.result.error === "string" ? job.result.error : "Delivery stopped before native admission." })
      : terminalWithoutReceipt
        ? JSON.stringify({ ok: false, delivery: "admission_unknown", inputId, admissionUnknown: true, nonRetryable: true,
          error: "Delivery job ended without a native receipt; inspect the existing job before retrying." })
        : result;
    publishSessionsChanged();
    return { content: [{ type: "text" as const, text: response
      ? JSON.stringify({ delivery, response })
      : delivery }] };
  });
  server.registerTool("create_session", { description: "Create one named OpenCode, Codex, ZCode, or Fast Agent session in an absolute canonical working directory. Codex serviceTier defaults to normal; serviceTier is rejected for other harnesses.", inputSchema: CreateSessionSchema }, async (args) => {
    await assertModelAllowedForDirectoryWithPolicy(deps.launchPolicy, args.cwd, args.model, args.harness);
    const result = await handleCreateSession(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("new_or_resume", { description: "Reuse the exact named session for harness+CWD or create it, then deliver one message. Codex serviceTier applies only when this call creates a new session; existing named sessions are never changed. OpenCode GLM 5.3 Flash uses MiniMax M3.1 Flash as its default fallback after a pre-admission HTTP 429 or provider quota rejection; fallbackModels overrides that route. Unknown/accepted delivery and manual stops never trigger fallback. Call model_quotas to inspect current provider allowances.", inputSchema: NewOrResumeSchema }, async (args) => {
    await assertModelAllowedForDirectoryWithPolicy(deps.launchPolicy, args.cwd, args.model, args.harness);
    // A fallback model is a model the project would run on, so the project
    // rules apply to it as well.
    for (const fallback of args.fallbackModels ?? []) {
      await assertModelAllowedForDirectoryWithPolicy(deps.launchPolicy, args.cwd, fallback, args.harness);
    }
    const result = await handleNewOrResume(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("deliver", { description: "Deliver a message to an agent. Existing targets default to current-turn-only delivery; idle/completed targets are skipped without deferred debt. Newly created named targets receive their initial task. inputId deduplicates retries for 24 hours. Target by sessionId or harness+name+cwd. create=if_missing creates a missing named session; create=never does not. activation=always may wake/start; if_running returns skipped_inactive for inactive threads; defer stores deduplicated input without waking an inactive thread. Herder checks native activity at delivery time; no list_agents pre-check is needed.", inputSchema: DeliverSchema }, async(args)=>{ const route=await sessionRoute(args);if(route.denied)throw new Error("project_session_scope_unavailable");if(route.hostTargetUnavailable)throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);await assertDeliveryModelAllowed(route.adapters,{sessionId:args.sessionId,harness:args.harness,cwd:args.cwd,model:args.model});const result=await handleDeliver(route.adapters,route.args);publishSessionsChanged();return {content:[{type:"text" as const,text:result}]}; });
  server.registerTool("stop_agent", { description: "Stop / abort a running agent session. A session of another machine is stopped there, through its own native session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), hostId: z.string().trim().min(1).max(512).optional().describe("Machine that owns the session. Omitted stops a session of this machine.") }) }, async (args) => {
    const owner = typeof args.hostId === "string" ? normalizeHostId(args.hostId, hostname()) : hostname();
    // Another machine owns its own native session, so the stop runs there.
    if (owner !== hostname()) {
      const result = await handleStopAgent(deps.adapters, args, { transport: peerTransport, localHostId: hostname() });
      publishSessionsChanged();
      return { content: [{ type: "text" as const, text: result }] };
    }
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const result = await handleStopAgent(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("respond_permission", { description: "Respond to a pending permission request (allow/deny). OpenCode, Claude SDK, and ZCode support this.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), permissionId: z.string(), response: z.enum(["allow", "deny"]), remember: z.boolean().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    return { content: [{ type: "text" as const, text: await handleRespondPermission(route.adapters, route.args) }] };
  });
  server.registerTool("set_permissions", { description: "Set permissions for an agent. Claude/Codex set these at launch time.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), allowedTools: z.string().optional(), mode: z.string().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    return { content: [{ type: "text" as const, text: await handleSetPermissions(route.adapters, route.args) }] };
  });
  server.registerTool("resume_agent", { description: "Resume a stopped agent session. Optionally provide a message.", inputSchema: ResumeAgentSchema }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    const result = await handleResumeAgent(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("change_model", { description: "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex/Qoder/ZCode: per-session where supported by the harness.", inputSchema: z.object({ sessionId: z.string().optional(), harness: harnessSchema, model: z.string() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    if (route.hostTargetUnavailable) throw new Error(`host_target_unavailable:${route.hostTargetUnavailable}`);
    // A per-session change is bound to the project of that session: the
    // working directory decides, not the harness the session happens to run on.
    // The session is only looked up when the policy actually restricts models.
    if (args.sessionId && deps.launchPolicy) {
      const policy = await deps.launchPolicy();
      if (policyRestrictsModels(policy)) {
        const cwd = await sessionCwd(route.adapters, args.sessionId, args.harness);
        if (cwd) assertModelAllowedForDirectory(policy, cwd, args.model);
      }
    }
    const result = await handleChangeModel(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("list_models", { description: "List available AI models for each harness.", inputSchema: z.object({ harness: harnessSchema.optional() }), outputSchema: z.object({ harnesses: z.array(z.object({ harness: z.string(), name: z.string(), models: z.array(z.string()), defaultModel: z.string().optional() })) }) }, async (args) => {
    const harnesses = await listModelsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListModelsResult(harnesses) }], structuredContent: { harnesses } };
  });

  const queueTargetSchema=z.object({hostId:z.string().trim().min(1).max(512),harness:z.literal("zcode"),sessionId:z.string().trim().min(1).max(512)});
  const queueStateSchema=z.object({autoDrain:z.boolean(),baseRevision:z.number().int().nonnegative(),pendingCount:z.number().int().nonnegative(),oldestQueueItemId:z.string().nullable(),nativeState:z.string(),loaded:z.literal(true),capability:z.literal("setAutoDrain")}).nullable();
  const queueViewSchema=z.object({target:queueTargetSchema,state:queueStateSchema,canResume:z.boolean(),humanStopHeld:z.boolean(),error:z.string().optional()});
  const queueUnavailableSchema=z.object({available:z.literal(false),target:queueTargetSchema,error:z.string()});
  server.registerTool("session_queue_processing_get",{
    description:"Read the exact native ZCode queue state on its owner. This read does not resume, load, or send a message.",
    inputSchema:queueTargetSchema,
    outputSchema:z.union([queueViewSchema,queueUnavailableSchema]),
  },async(args)=>{
    const value=deps.sessionQueueControl?await deps.sessionQueueControl.read(args):{available:false as const,target:args,error:"Native queue control is unavailable."};
    return {content:[{type:"text" as const,text:JSON.stringify(value)}],structuredContent:value};
  });
  const queueSubmitSchema=z.object({hostId:z.string().trim().min(1).max(512),harness:z.literal("zcode"),sessionId:z.string().trim().min(1).max(512),inputId:z.string().trim().min(1).max(512),expectedRevision:z.number().int().nonnegative()});
  const queueJobSchema=z.object({id:z.string(),state:z.string(),resultRef:z.string()});
  const queueSubmitResultSchema=z.object({target:queueTargetSchema,inputId:z.string(),state:z.enum(["queued","unknown","not_attempted"]),nonRetryable:z.boolean(),job:queueJobSchema.optional(),error:z.string().optional()});
  server.registerTool("session_queue_processing_resume",{
    description:"Explicitly resume processing an already accepted native ZCode queue after exact owner, queue revision, HumanStop, permission, and automation-hold checks. Accepted means the native queue-processing preference was confirmed; it does not claim a queued input has started. Unknown is terminal and must not be retried.",
    inputSchema:queueSubmitSchema,
    outputSchema:queueSubmitResultSchema,
  },async(args)=>{
    const value=deps.sessionQueueControl?await deps.sessionQueueControl.submit(args):{target:{hostId:args.hostId,harness:args.harness,sessionId:args.sessionId},inputId:args.inputId,state:"not_attempted" as const,nonRetryable:true,error:"Native queue control is unavailable."};
    return {content:[{type:"text" as const,text:JSON.stringify(value)}],structuredContent:value};
  });
}
