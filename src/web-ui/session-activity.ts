import type { SessionMessageView } from "../types/index.js";
import { commandPaths, toolCommand, toolKind } from "../session-visualization.js";

/**
 * The work of a session, read from the transcript the panel already holds.
 *
 * The panel loads the turns of the open session for the chat itself. The same
 * turns answer what the owner asks about the session in the panel: which files
 * the agent touched, when it touched them and which MCP tools it called.
 * Nothing here is measured by the panel itself: every entry comes from a tool
 * call of the transcript, and an event the transcript does not prove stays out.
 */

/** The kind of work one tool call did. */
export type SessionActivityKind = "files" | "git" | "test" | "runtime" | "error" | "tool";

/** One proven action of the session. */
export type SessionActivityEvent = {
  /** The moment of the turn that carried the call. */
  at?: string;
  /** The name of the tool the agent called. */
  tool: string;
  /** What the call did, decided by its name and its command. */
  kind: SessionActivityKind;
  /** The kind in the owner's words. */
  label: string;
  /** The first line of the command, shortened. */
  detail?: string;
  /** The files the call touched. */
  paths: string[];
  /** True when the call went to an MCP server. */
  mcp: boolean;
};

/** One MCP tool and how many times the session called it. */
export type McpToolUsage = { name: string; count: number };

/** One file the session touched, with the moment of the change. */
export type SessionChangedFile = { path: string; operation: string; at?: string };

const KIND_LABELS: Record<SessionActivityKind, string> = {
  files: "Изменение файлов",
  git: "Работа с git",
  test: "Проверки",
  runtime: "Запуск и сервисы",
  error: "Ошибка инструмента",
  tool: "Инструмент",
};

/** The name of an MCP tool: the panel names them `mcp__server__tool`. */
export function isMcpTool(name: string | undefined): boolean {
  return /^mcp(?:__|[:_-])/i.test((name || "").trim());
}

/** The short form of a command: the first line, without the noise around it. */
function commandDetail(command: string): string | undefined {
  const line = command.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * The calls of the transcript. A call is counted once: a transcript that names
 * the tool call uses it, a transcript that carries only the result of the call
 * is read through the result.
 */
function callParts(messages: readonly SessionMessageView[] | undefined): SessionMessageView["parts"] {
  const calls: SessionMessageView["parts"] = [];
  const results: SessionMessageView["parts"] = [];
  for (const message of messages || []) {
    for (const part of message.parts || []) {
      if (part.type === "tool_call") calls.push(part);
      else if (part.type === "tool_result") results.push(part);
    }
  }
  return calls.length ? calls : results;
}

/** Every proven action of the session, in the order of the transcript. */
export function sessionActivityEvents(messages: readonly SessionMessageView[] | undefined): SessionActivityEvent[] {
  const events: SessionActivityEvent[] = [];
  const parts = callParts(messages);
  const at = new Map<SessionMessageView["parts"][number], string | undefined>();
  for (const message of messages || []) {
    for (const part of message.parts || []) at.set(part, message.timestamp);
  }
  for (const part of parts) {
    const command = toolCommand(part);
    const paths = commandPaths(command);
    const kind = (toolKind(part, command, paths) || "tool") as SessionActivityKind;
    const tool = part.name || part.type;
    events.push({
      at: at.get(part),
      tool,
      kind,
      label: KIND_LABELS[kind],
      detail: commandDetail(command),
      paths,
      mcp: isMcpTool(tool),
    });
  }
  return events;
}

/** The MCP tools of the session and how many times each of them was called. */
export function mcpToolUsage(messages: readonly SessionMessageView[] | undefined): McpToolUsage[] {
  const counter = new Map<string, number>();
  for (const event of sessionActivityEvents(messages)) {
    if (!event.mcp) continue;
    counter.set(event.tool, (counter.get(event.tool) || 0) + 1);
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

/** The files the session touched, with the moment of the last touch of each. */
export function sessionChangedFiles(messages: readonly SessionMessageView[] | undefined): SessionChangedFile[] {
  const files = new Map<string, SessionChangedFile>();
  for (const event of sessionActivityEvents(messages)) {
    if (event.kind !== "files") continue;
    for (const path of event.paths) {
      const known = files.get(path);
      files.set(path, { path, operation: event.label, at: event.at || known?.at });
    }
  }
  return [...files.values()];
}

/** The time of the day of a moment, in the owner's timezone of the panel. */
export function activityTime(at: string | undefined): string {
  if (!at) return "";
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** The moment of an event in the owner's words, without the year noise. */
export function activityMoment(at: string | undefined): string {
  if (!at) return "";
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
