import { HarnessAdapter, AgentSession } from "../types/index.js";
import {
  ListAgentsSchema,
  AgentInfoSchema,
  SendMessageSchema,
  StopAgentSchema,
  RespondPermissionSchema,
  SetPermissionsSchema,
  ResumeAgentSchema,
} from "./definitions.js";

/**
 * Format an agent session for display as MCP tool result text.
 */
function formatSession(s: AgentSession, verbose = false): string {
  const lines = [
    `[${s.harness}] ${s.id}`,
    `  Status: ${s.status}${s.needsPermission ? " ⚠️ NEEDS INPUT" : ""}`,
    `  Title: ${s.title}`,
    `  CWD: ${s.cwd}`,
    `  Last active: ${s.lastActivity}`,
  ];
  if (s.model) lines.push(`  Model: ${s.model}`);
  if (s.costUsd !== undefined) lines.push(`  Cost: $${s.costUsd.toFixed(4)}`);
  if (s.durationSec !== undefined) lines.push(`  Duration: ${Math.round(s.durationSec)}s`);
  if (s.messageCount !== undefined) lines.push(`  Messages: ${s.messageCount}`);
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
 * Find an adapter and session by session ID.
 * If harness is specified, only search that harness.
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

  // Sort by last activity
  filtered.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

  const limited = filtered.slice(0, parsed.limit);

  if (limited.length === 0) {
    return "No agent sessions found.";
  }

  const summary = [
    `Found ${filtered.length} session(s)${parsed.harness !== "all" ? ` on ${parsed.harness}` : ""}${parsed.status !== "all" ? ` with status '${parsed.status}'` : ""}:`,
    "",
    ...limited.map((s) => formatSession(s)),
    "",
    filtered.length > parsed.limit ? `... and ${filtered.length - parsed.limit} more (use limit to see more)` : "",
  ];

  return summary.join("\n");
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

  // For Claude Code, resume means sending a message with --resume
  // For OpenCode, send a message to the existing session
  // For Codex, start a new invocation
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

  // No message — just try to re-activate
  // For OpenCode this would be a no-op (session stays in memory)
  // For Claude/Codex we'd need to re-launch, which requires the original prompt
  return `Agent [${found.session.harness}] ${parsed.sessionId} is ${found.session.status}. To resume, provide a message to send.`;
}