import { HarnessAdapter, AgentSession } from "../types/index.js";
import {
  ListAgentsSchema,
  AgentInfoSchema,
  FindParentSchema,
  ListChildrenSchema,
  ExportTranscriptSchema,
  SendMessageSchema,
  CreateSessionSchema,
  NewOrResumeSchema,
  StopAgentSchema,
  RespondPermissionSchema,
  SetPermissionsSchema,
  ResumeAgentSchema,
  ChangeModelSchema,
  ListModelsSchema,
  AuditWorktreesSchema,
} from "./definitions.js";
import { createNamedSession, newOrResumeNamedSession } from "../named-session.js";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { auditWorktrees } from "../worktree-audit.js";
import { BrowserWakeService } from "../browser-wake.js";
import { coordinationNotes } from "../coordination-notes.js";
import {
  buildTranscriptArchiveCard,
  transcriptArchiveFromEnvironment,
  type ArchivedTranscript,
  type TranscriptArchive,
  type TranscriptArchiveResult,
} from "../transcript-archive.js";

/**
 * Format an agent session for display as MCP tool result text.
 */
export function formatSession(s: AgentSession, verbose = false): string {
  const lines = [
    `[${s.harness}] ${s.id}`,
    `  Status: ${s.status}${s.needsPermission ? " ⚠ NEEDS INPUT" : ""}`,
    `  Title: ${s.title}`,
    `  Model: ${s.model || "unknown"}`,
    `  CWD: ${s.cwd}`,
    `  Last active: ${s.lastActivity}`,
  ];
  if (s.costUsd !== undefined) lines.push(`  Cost: $${s.costUsd.toFixed(4)}`);
  if (s.durationSec !== undefined) lines.push(`  Duration: ${Math.round(s.durationSec)}s`);
  if (s.messageCount !== undefined) lines.push(`  Messages: ${s.messageCount}`);
  if (s.lastMessage) {
    lines.push(`  Last message: ${s.lastMessage}`);
  }
  if (s.needsPermission && s.permissionDetails) {
    lines.push(`  Permission request: [${s.permissionDetails.id}] ${s.permissionDetails.type}: ${s.permissionDetails.description}`);
    if (s.permissionDetails.toolName) lines.push(`    Tool: ${s.permissionDetails.toolName}`);
  }
  if (verbose && s.meta && Object.keys(s.meta).length > 0) {
    lines.push(`  Meta: ${JSON.stringify(s.meta)}`);
  }
  return lines.join("\n");
}

type TranscriptSelection = {
  mode: "latest" | "search";
  query?: string;
  latestMessages: number;
  contextMessages: number;
  maxChars: number;
};

function selectTranscript(transcript: string, options: TranscriptSelection): string {
  const blocks = transcript.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return "(transcript is empty)";
  if (options.mode === "search" && !options.query?.trim()) return "Transcript search requires a query.";

  const selected = new Set<number>();
  const addLatest = (): void => {
    const start = Math.max(0, blocks.length - options.latestMessages);
    for (let index = start; index < blocks.length; index += 1) selected.add(index);
  };

  if (options.mode === "latest") addLatest();

  if (options.mode === "search") {
    const terms = options.query!.toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = blocks
      .map((block, index) => {
        const lower = block.toLowerCase();
        const score = terms.reduce((total, term) => total + (lower.split(term).length - 1), 0);
        return { index, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.index - left.index)
      .slice(0, options.latestMessages);

    for (const match of ranked) {
      const start = Math.max(0, match.index - options.contextMessages);
      const end = Math.min(blocks.length - 1, match.index + options.contextMessages);
      for (let index = start; index <= end; index += 1) selected.add(index);
    }
    if (ranked.length === 0) return `(no transcript messages matched query: ${options.query})`;
  }

  const result = [...selected].sort((left, right) => left - right).map((index) => blocks[index]).join("\n\n");
  if (result.length <= options.maxChars) return result;
  const clipped = options.mode === "latest" ? result.slice(-options.maxChars) : result.slice(0, options.maxChars);
  return `[truncated to ${options.maxChars} characters]\n${clipped}`;
}

/**
 * Expand a path that may contain ~ or environment variables.
 */
function expandPath(p: string): string {
  return resolve(p.replace(/^~/, homedir()));
}

/**
 * Find an adapter and session by session ID.
 */
export async function findSession(
  adapters: Map<string, HarnessAdapter>,
  sessionId: string,
  harness?: string
): Promise<{ adapter: HarnessAdapter; session: AgentSession } | null> {
  const searchAdapters = harness
    ? [adapters.get(harness)].filter(Boolean) as HarnessAdapter[]
    : [...adapters.values()];

  for (const adapter of searchAdapters) {
    try {
      const session = await adapter.getSession(sessionId);
      if (session) return { adapter, session };
    } catch {
      continue;
    }
  }
  return null;
}

async function isInsideWorkspace(workspaceRoot: string, sessionCwd: string): Promise<boolean> {
  let resolvedRoot: string;
  let resolvedCwd: string;
  try {
    [resolvedRoot, resolvedCwd] = await Promise.all([realpath(workspaceRoot), realpath(sessionCwd)]);
  } catch {
    return false;
  }
  const path = relative(resolvedRoot, resolvedCwd);
  return path === "" || (!path.startsWith("..") && !path.includes(`..${sep}`));
}

async function exportRawLineage(
  adapter: HarnessAdapter,
  target: AgentSession,
  archive: TranscriptArchive,
  limit = 50,
): Promise<{ archive: TranscriptArchiveResult; targetRaw: ArchivedTranscript["raw"] } | null> {
  if (!adapter.getRawTranscript || !await isInsideWorkspace(archive.workspaceRoot, target.cwd)) return null;
  const visited = new Set<string>();
  const related: ArchivedTranscript[] = [];
  const excluded: TranscriptArchiveResult["excluded"] = [];

  const capture = async (session: AgentSession, targetSession = false): Promise<ArchivedTranscript | null> => {
    const key = `${session.harness}:${session.id}`;
    if (visited.has(key)) return null;
    visited.add(key);
    if (session.harness !== target.harness) {
      excluded.push({ harness: session.harness, sessionId: session.id, reason: "foreign_harness" });
      return null;
    }
    if (!await isInsideWorkspace(archive.workspaceRoot, session.cwd)) {
      excluded.push({ harness: session.harness, sessionId: session.id, reason: "outside_workspace" });
      return null;
    }
    if (visited.size > limit) {
      excluded.push({ harness: session.harness, sessionId: session.id, reason: "lineage_limit" });
      return null;
    }
    const raw = await adapter.getRawTranscript!(session.id);
    if (!raw) {
      excluded.push({ harness: session.harness, sessionId: session.id, reason: "raw_unavailable" });
      return null;
    }
    const snapshot = { harness: session.harness, sessionId: session.id, cwd: session.cwd, raw };
    if (!targetSession) related.push(snapshot);
    if (adapter.getParent) {
      try {
        const parent = await adapter.getParent(session.id);
        if (parent) await capture(parent);
      } catch { /* archival of the target remains useful */ }
    }
    if (adapter.listChildren) {
      try {
        for (const child of await adapter.listChildren(session.id)) await capture(child);
      } catch { /* archival of the target remains useful */ }
    }
    return snapshot;
  };

  const snapshot = await capture(target, true);
  return snapshot ? { archive: await archive.exportLineage({ target: snapshot, related, excluded }), targetRaw: snapshot.raw } : null;
}

export interface ListAgentsResult {
  sessions: AgentSession[];
  total: number;
  limited: boolean;
  filters: { harness: string; status: string; maxAge?: number; folder?: string; includeLastMessage: boolean };
}

export async function listAgentsResult(
  adapters: Map<string, HarnessAdapter>,
  args: unknown,
): Promise<ListAgentsResult> {
  const parsed = ListAgentsSchema.parse(args);
  const allSessions: AgentSession[] = [];

  const targets =
    parsed.harness === "all"
      ? [...adapters.values()]
      : [adapters.get(parsed.harness)].filter(Boolean) as HarnessAdapter[];

  for (const adapter of targets) {
    if (adapter.lazyStart && !adapter.lazyDiscovery && adapter.isReady && !adapter.isReady()) continue;
    try {
      const sessions = await adapter.listSessions();
      allSessions.push(...sessions);
    } catch (err) {
      allSessions.push({
        id: "error",
        harness: adapter.type,
        status: "error",
        title: `Failed to list sessions: ${(err as Error).message}`,
        cwd: "",
        lastActivity: new Date().toISOString(),
        needsPermission: false,
      });
    }
  }

  // Filter by status
  let filtered = allSessions;
  if (parsed.status !== "all") {
    filtered = filtered.filter((s) => s.status === parsed.status);
  }

  // Filter by maxAge (session age in seconds)
  if (parsed.maxAge !== undefined && parsed.maxAge > 0) {
    const cutoff = Date.now() - parsed.maxAge * 1000;
    filtered = filtered.filter((s) => {
      const lastActive = new Date(s.lastActivity).getTime();
      return lastActive >= cutoff;
    });
  }

  // Filter by folder (CWD prefix)
  if (parsed.folder) {
    const normalizedFolder = expandPath(parsed.folder);
    filtered = filtered.filter((s) => {
      const normalizedCwd = expandPath(s.cwd);
      return normalizedCwd.startsWith(normalizedFolder);
    });
  }

  // Sort by last activity
  filtered.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

  const limited = filtered.slice(0, parsed.limit);

  return {
    sessions: limited,
    total: filtered.length,
    limited: filtered.length > parsed.limit,
    filters: { harness: parsed.harness, status: parsed.status, ...(parsed.maxAge !== undefined ? { maxAge: parsed.maxAge } : {}), ...(parsed.folder ? { folder: parsed.folder } : {}), includeLastMessage: parsed.includeLastMessage },
  };
}

export function formatListAgentsResult(result: ListAgentsResult): string {
  const parsed = result.filters;
  if (result.sessions.length === 0) {
    const filters: string[] = [];
    if (parsed.harness !== "all") filters.push(`harness=${parsed.harness}`);
    if (parsed.status !== "all") filters.push(`status=${parsed.status}`);
    if (parsed.maxAge) filters.push(`maxAge=${parsed.maxAge}s`);
    if (parsed.folder) filters.push(`folder=${parsed.folder}`);
    const filterStr = filters.length > 0 ? ` with filters: ${filters.join(", ")}` : "";
    return `No agent sessions found${filterStr}.`;
  }
  return [
    `Found ${result.total} session(s)${parsed.harness !== "all" ? ` on ${parsed.harness}` : ""}${parsed.status !== "all" ? ` with status '${parsed.status}'` : ""}${parsed.maxAge ? ` from last ${formatDuration(parsed.maxAge)}` : ""}${parsed.folder ? ` under ${parsed.folder}` : ""}:`,
    "",
    ...result.sessions.map((session) => formatSession(session, parsed.includeLastMessage)),
    "",
    result.limited ? `... and ${result.total - result.sessions.length} more (use limit to see more)` : "",
  ].join("\n");
}

export async function handleListAgents(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<string> {
  return formatListAgentsResult(await listAgentsResult(adapters, args));
}

/**
 * Return a human-readable, read-only Git worktree ownership audit.
 */
export async function handleAuditWorktrees(args: unknown): Promise<string> {
  const parsed = AuditWorktreesSchema.parse(args);
  const entries = await auditWorktrees(expandPath(parsed.repoPath), parsed.includeClean);
  if (entries.length === 0) return "No dirty, locked, or actively owned worktrees found.";

  const lines = [`Worktree audit for ${expandPath(parsed.repoPath)}:`, ""];
  for (const entry of entries) {
    const labels = [entry.dirtyFiles.length > 0 ? `dirty=${entry.dirtyFiles.length}` : "clean"];
    if (entry.lock) {
      const pidLabel = entry.lock.pid === undefined ? "no pid" : `pid=${entry.lock.pid} ${entry.lock.pidStatus}`;
      labels.push(`locked (${pidLabel})`);
    }
    lines.push(`${entry.path} [${entry.branch || "detached"}] ${labels.join(", ")}`);
    if (entry.dirtyFiles.length > 0) {
      lines.push(`  Files: ${entry.dirtyFiles.join(", ")}`);
    }
    if (entry.lock?.reason) lines.push(`  Lock reason: ${entry.lock.reason}`);
    if (entry.activeAgents.length === 0) {
      lines.push("  Active harness processes: none");
    } else {
      for (const process of entry.activeAgents) {
        lines.push(`  Active ${process.harness}: pid=${process.pid} cwd=${process.cwd} cmd=${process.command}`);
      }
    }
  }
  return lines.join("\n");
}

export async function agentInfoResult(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<AgentSession | null> {
  const parsed = AgentInfoSchema.parse(args);
  return (await findSession(adapters, parsed.sessionId, parsed.harness))?.session ?? null;
}

export async function handleAgentInfo(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<string> {
  const parsed = AgentInfoSchema.parse(args);
  const session = await agentInfoResult(adapters, parsed);
  return session ? formatSession(session, true) : `Session '${parsed.sessionId}' not found.`;
}

export async function findParentResult(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<{ session: AgentSession | null; parent: AgentSession | null; supported: boolean }> {
  const parsed = FindParentSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return { session: null, parent: null, supported: false };
  if (!found.adapter.getParent) return { session: found.session, parent: null, supported: false };
  return { session: found.session, parent: await found.adapter.getParent(parsed.sessionId), supported: true };
}

export function formatFindParentResult(sessionId: string, result: { session: AgentSession | null; parent: AgentSession | null; supported: boolean }): string {
  if (!result.session) return `Session '${sessionId}' not found.`;
  if (!result.supported) return `Finding a parent is not supported by the ${result.session.harness} adapter.`;
  if (!result.parent) return `No parent found for [${result.session.harness}] ${sessionId}.`;
  return [`Parent of [${result.session.harness}] ${sessionId}:`, "", formatSession(result.parent, true)].join("\n");
}

export async function handleFindParent(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<string> {
  const parsed = FindParentSchema.parse(args);
  const result = await findParentResult(adapters, parsed);
  return formatFindParentResult(parsed.sessionId, result);
}

export async function listChildrenResult(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<{ session: AgentSession | null; children: AgentSession[]; supported: boolean }> {
  const parsed = ListChildrenSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return { session: null, children: [], supported: false };
  if (!found.adapter.listChildren) return { session: found.session, children: [], supported: false };
  return { session: found.session, children: await found.adapter.listChildren(parsed.sessionId), supported: true };
}

export function formatListChildrenResult(sessionId: string, result: { session: AgentSession | null; children: AgentSession[]; supported: boolean }): string {
  if (!result.session) return `Session '${sessionId}' not found.`;
  if (!result.supported) return `Listing children is not supported by the ${result.session.harness} adapter.`;
  if (result.children.length === 0) return `No children found for [${result.session.harness}] ${sessionId}.`;
  return [`Children of [${result.session.harness}] ${sessionId} (${result.children.length}):`, "", ...result.children.map((child) => formatSession(child, true))].join("\n");
}

export async function handleListChildren(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<string> {
  const parsed = ListChildrenSchema.parse(args);
  const result = await listChildrenResult(adapters, parsed);
  return formatListChildrenResult(parsed.sessionId, result);
}

/** Export raw adapter-owned transcript material and return only its navigation card. */
export async function handleExportTranscript(
  adapters: Map<string, HarnessAdapter>,
  args: unknown,
  archive: TranscriptArchive = transcriptArchiveFromEnvironment(),
): Promise<string> {
  const parsed = ExportTranscriptSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;
  if (!found.adapter.getRawTranscript) {
    return `Raw transcript export is not supported by the ${found.adapter.name} adapter.`;
  }
  try {
    const outcome = await exportRawLineage(found.adapter, found.session, archive);
    if (!outcome) return `Raw transcript unavailable for [${found.session.harness}] ${parsed.sessionId} within the MCP process CWD.`;
    const target = outcome.archive.exported.find((entry) => entry.path === outcome.archive.targetPath);
    return buildTranscriptArchiveCard({
      targetPath: outcome.archive.targetPath,
      manifestPath: outcome.archive.manifestPath,
      sessionId: parsed.sessionId,
      complete: target?.complete ?? false,
    });
  } catch (error) {
    return `Raw transcript export failed: ${(error as Error).message}`;
  }
}

export async function handleSendMessage(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = SendMessageSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  // Reply header: the target must know who sent the message and how to
  // answer without hunting for session ids.
  const replyHeader = parsed.fromSessionId
    ? `[Agent Herder delivery] От: ${parsed.fromHarness ?? "agent"}:${parsed.fromSessionId}.\nЧтобы ответить: send_message { sessionId: "${parsed.fromSessionId}", harness: "${parsed.fromHarness ?? "zcode"}", mode: "queue" }.`
    : "";
  const baseMessage = replyHeader ? `${replyHeader}\n\n${parsed.message}` : parsed.message;
  const injectedMessage = await coordinationNotes.inject(found.session, baseMessage);
  const result = await found.adapter.sendMessage(parsed.sessionId, {
    message: injectedMessage,
    queue: parsed.mode === "queue",
    steer: parsed.mode === "steer",
  });

  if (result.ok) {
    const modeLabel = parsed.mode === "queue" ? " (queued)" : parsed.mode === "steer" ? " (steering)" : " (sync)";
    return `Message sent to [${found.session.harness}] ${parsed.sessionId}${modeLabel}.\nMessage: ${parsed.message}`;
  }
  return `Failed to send message: ${result.error}`;
}

export async function handleCreateSession(
  adapters: Map<string, HarnessAdapter>,
  args: unknown,
): Promise<string> {
  const parsed = CreateSessionSchema.parse(args);
  const result = await createNamedSession(adapters, parsed);
  return JSON.stringify(result);
}

export async function handleNewOrResume(
  adapters: Map<string, HarnessAdapter>,
  args: unknown,
): Promise<string> {
  const parsed = NewOrResumeSchema.parse(args);
  const result = await newOrResumeNamedSession(adapters, parsed);
  return JSON.stringify(result);
}

export async function handleStopAgent(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = StopAgentSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  const result = await found.adapter.stopSession(parsed.sessionId);
  if (result.ok) {
    return `Stopped agent [${found.session.harness}] ${parsed.sessionId}.`;
  }
  return `Failed to stop agent: ${result.error}`;
}

export async function handleRespondPermission(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = RespondPermissionSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  const result = await found.adapter.respondPermission(
    parsed.sessionId,
    parsed.permissionId,
    parsed.response,
    parsed.remember
  );

  if (result.ok) {
    return `Permission ${parsed.permissionId} ${parsed.response}ed for [${found.session.harness}] ${parsed.sessionId}.`;
  }
  return `Failed to respond to permission: ${result.error}`;
}

export async function handleSetPermissions(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = SetPermissionsSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  const result = await found.adapter.setPermissions(parsed.sessionId, {
    allowedTools: parsed.allowedTools,
    mode: parsed.mode,
  });

  if (result.ok) {
    return `Permissions updated for [${found.session.harness}] ${parsed.sessionId}.`;
  }
  return `Failed to set permissions: ${result.error}`;
}

export async function handleResumeAgent(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = ResumeAgentSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  if (found.adapter.resumeSession) {
    const resumed = await found.adapter.resumeSession(parsed.sessionId);
    if (!resumed.ok) return `Failed to resume: ${resumed.error}`;
  }

  if (parsed.message) {
    const injectedMessage = await coordinationNotes.inject(found.session, parsed.message);
    const result = await found.adapter.sendMessage(parsed.sessionId, {
      message: injectedMessage,
      queue: false,
    });
    if (result.ok) {
      return `Resumed agent [${found.session.harness}] ${parsed.sessionId} with message.`;
    }
    return `Failed to resume: ${result.error}`;
  }

  return found.adapter.resumeSession
    ? `Resumed agent [${found.session.harness}] ${parsed.sessionId}.`
    : `Agent [${found.session.harness}] ${parsed.sessionId} is ${found.session.status}. To resume, provide a message to send.`;
}

/**
 * Change the AI model for a harness/session.
 */
export async function handleChangeModel(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = ChangeModelSchema.parse(args);
  const adapter = adapters.get(parsed.harness);
  if (!adapter) return `Harness '${parsed.harness}' is not available.`;

  if (!adapter.changeModel) {
    return `Model changing is not supported by the ${adapter.name} adapter via this interface. ` +
      `For ${parsed.harness}, set the model at session launch time or in config files.`;
  }

  // If sessionId provided, try per-session change
  if (parsed.sessionId) {
    const result = await adapter.changeModel(parsed.sessionId, parsed.model);
    if (result.ok) {
      return result.error || `Model changed to '${parsed.model}' for session ${parsed.sessionId} on ${adapter.name}.`;
    }
    return `Failed to change model: ${result.error}`;
  }

  // Global change — pass empty sessionId convention
  const result = await adapter.changeModel("", parsed.model);
  if (result.ok) {
    return result.error || `Default model for ${adapter.name} set to '${parsed.model}'.`;
  }
  return `Failed to change model: ${result.error}`;
}

/**
 * List available models for a harness.
 */
export async function listModelsResult(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<Array<{ harness: string; name: string; models: string[]; defaultModel?: string }>> {
  const parsed = ListModelsSchema.parse(args);
  const targets = parsed.harness ? [adapters.get(parsed.harness)].filter(Boolean) as HarnessAdapter[] : [...adapters.values()];
  const results: Array<{ harness: string; name: string; models: string[]; defaultModel?: string }> = [];
  for (const adapter of targets) {
    const models = adapter.listModels ? await adapter.listModels() : [];
    results.push({ harness: adapter.type, name: adapter.name, models, ...(models[0] ? { defaultModel: models[0] } : {}) });
  }
  return results;
}

export function formatListModelsResult(results: Array<{ harness: string; name: string; models: string[]; defaultModel?: string }>): string {
  if (results.length === 0) return "No harnesses available.";
  const sections: string[] = [];
  for (const entry of results) {
    sections.push(`### ${entry.name}${entry.models.length > 0 ? " (first = default)" : ""}`, entry.models.length > 0 ? entry.models.map((model, index) => `  ${index === 0 ? "→ " : "  "}${model}`).join("\n") : "  (model listing not available)", "");
  }
  return sections.join("\n");
}

export async function handleListModels(adapters: Map<string, HarnessAdapter>, args: unknown): Promise<string> {
  return formatListModelsResult(await listModelsResult(adapters, args));
}

export async function handleBrowserWake(
  service: BrowserWakeService,
  args: unknown,
): Promise<string> {
  const record = await service.wake(args);
  return JSON.stringify(record);
}

// ===== Helpers =====

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d${hours}h`;
}
