import { HarnessAdapter, AgentSession } from "../types/index.js";
import { summarizeTranscript, quickSummary } from "../summarizer.js";
import {
  ListAgentsSchema,
  AgentInfoSchema,
  SendMessageSchema,
  StopAgentSchema,
  RespondPermissionSchema,
  SetPermissionsSchema,
  ResumeAgentSchema,
  SummarizeSessionSchema,
  ChangeModelSchema,
  ListModelsSchema,
  AuditWorktreesSchema,
} from "./definitions.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { auditWorktrees } from "../worktree-audit.js";

/**
 * Format an agent session for display as MCP tool result text.
 */
function formatSession(s: AgentSession, verbose = false): string {
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

/**
 * Expand a path that may contain ~ or environment variables.
 */
function expandPath(p: string): string {
  return resolve(p.replace(/^~/, homedir()));
}

/**
 * Find an adapter and session by session ID.
 */
async function findSession(
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

export async function handleListAgents(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = ListAgentsSchema.parse(args);
  const allSessions: AgentSession[] = [];

  const targets =
    parsed.harness === "all"
      ? [...adapters.values()]
      : [adapters.get(parsed.harness)].filter(Boolean) as HarnessAdapter[];

  for (const adapter of targets) {
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

  if (limited.length === 0) {
    const filters: string[] = [];
    if (parsed.harness !== "all") filters.push(`harness=${parsed.harness}`);
    if (parsed.status !== "all") filters.push(`status=${parsed.status}`);
    if (parsed.maxAge) filters.push(`maxAge=${parsed.maxAge}s`);
    if (parsed.folder) filters.push(`folder=${parsed.folder}`);
    const filterStr = filters.length > 0 ? ` with filters: ${filters.join(", ")}` : "";
    return `No agent sessions found${filterStr}.`;
  }

  const summary = [
    `Found ${filtered.length} session(s)${parsed.harness !== "all" ? ` on ${parsed.harness}` : ""}${parsed.status !== "all" ? ` with status '${parsed.status}'` : ""}${parsed.maxAge ? ` from last ${formatDuration(parsed.maxAge)}` : ""}${parsed.folder ? ` under ${parsed.folder}` : ""}:`,
    "",
    ...limited.map((s) => formatSession(s, parsed.includeLastMessage)),
    "",
    filtered.length > parsed.limit ? `... and ${filtered.length - parsed.limit} more (use limit to see more)` : "",
  ];

  return summary.join("\n");
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

export async function handleAgentInfo(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = AgentInfoSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;
  return formatSession(found.session, true);
}

export async function handleSendMessage(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = SendMessageSchema.parse(args);
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  const result = await found.adapter.sendMessage(parsed.sessionId, {
    message: parsed.message,
    queue: parsed.mode === "queue",
    steer: parsed.mode === "steer",
  });

  if (result.ok) {
    const modeLabel = parsed.mode === "queue" ? " (queued)" : parsed.mode === "steer" ? " (steering)" : " (sync)";
    return `Message sent to [${found.session.harness}] ${parsed.sessionId}${modeLabel}.\nMessage: ${parsed.message}`;
  }
  return `Failed to send message: ${result.error}`;
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

  if (parsed.message) {
    const result = await found.adapter.sendMessage(parsed.sessionId, {
      message: parsed.message,
      queue: false,
    });
    if (result.ok) {
      return `Resumed agent [${found.session.harness}] ${parsed.sessionId} with message.`;
    }
    return `Failed to resume: ${result.error}`;
  }

  return `Agent [${found.session.harness}] ${parsed.sessionId} is ${found.session.status}. To resume, provide a message to send.`;
}

/**
 * Summarize a session's transcript using the built-in LLM summarizer.
 */
export async function handleSummarizeSession(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = SummarizeSessionSchema.parse(args);

  // Find the session
  const found = await findSession(adapters, parsed.sessionId, parsed.harness);
  if (!found) return `Session '${parsed.sessionId}' not found.`;

  // Try to get transcript from the adapter
  const adapter = found.adapter;
  if (!adapter.getTranscript) {
    return `Session transcript retrieval is not supported by the ${adapter.name} adapter in this mode.`;
  }

  const transcript = await adapter.getTranscript(parsed.sessionId);
  if (!transcript || transcript.trim().length === 0) {
    // Return what we know from the session metadata as a fallback
    return [
      `## Session Summary (no transcript available)`,
      ``,
      `**Session**: [${found.session.harness}] ${parsed.sessionId}`,
      `**Title**: ${found.session.title}`,
      `**Model**: ${found.session.model || "unknown"}`,
      `**Status**: ${found.session.status}`,
      `**CWD**: ${found.session.cwd}`,
      `**Last active**: ${found.session.lastActivity}`,
      `**Messages**: ${found.session.messageCount ?? "unknown"}`,
      found.session.lastMessage ? `**Last message**: ${found.session.lastMessage}` : "",
    ].join("\n");
  }

  // Call the summarizer
  if (parsed.quick) {
    const result = await quickSummary(transcript);
    if (result.error) return `Summarization failed: ${result.error}`;
    return [
      `## Quick Summary — [${found.session.harness}] ${parsed.sessionId}`,
      ``,
      result.summary,
    ].join("\n");
  }

  const result = await summarizeTranscript(transcript);
  if (result.error) return `Summarization failed: ${result.error}`;

  return [
    `## Session Summary — [${found.session.harness}] ${parsed.sessionId}`,
    ``,
    `*Model: ${found.session.model || "unknown"} | Messages: ${found.session.messageCount ?? "?"} | Status: ${found.session.status}*`,
    ``,
    result.summary,
  ].join("\n");
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
export async function handleListModels(
  adapters: Map<string, HarnessAdapter>,
  args: unknown
): Promise<string> {
  const parsed = ListModelsSchema.parse(args);

  const targets = parsed.harness
    ? [adapters.get(parsed.harness)].filter(Boolean) as HarnessAdapter[]
    : [...adapters.values()];

  if (targets.length === 0) return "No harnesses available.";

  const sections: string[] = [];

  for (const adapter of targets) {
    const models = adapter.listModels ? await adapter.listModels() : [];
    const currentModel = models.length > 0 ? ` (first = default)` : "";
    sections.push(
      `### ${adapter.name}${currentModel}`,
      models.length > 0
        ? models.map((m, i) => `  ${i === 0 ? "→ " : "  "}${m}`).join("\n")
        : "  (model listing not available)",
      ""
    );
  }

  return sections.join("\n");
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
