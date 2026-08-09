import { createHash } from "node:crypto";
import type { SessionDetails, SessionMessagePart, SessionMessageView } from "./types/index.js";

export interface SessionProgressEvidenceRef {
  kind: "message" | "tool";
  id: string;
  role?: SessionMessageView["role"];
  name?: string;
  preview?: string;
}

export interface SessionProgressSummary {
  session: {
    id: string;
    harness: string;
    status: string;
    title: string;
    cwd: string;
    lastActivity: string;
    needsPermission: boolean;
    messageCount?: number;
    lastMessage?: string;
  };
  activity: {
    hasMessageActivity: boolean;
    hasToolActivity: boolean;
    lastMessageId?: string;
    lastToolId?: string;
    historySource: SessionDetails["history"]["source"];
  };
  fingerprint: string;
  evidence: SessionProgressEvidenceRef[];
}

export function buildSessionProgress(details: SessionDetails, limit = 5): SessionProgressSummary {
  const messages = tailMessages(details.messages, Math.max(1, Math.min(limit, 10)));
  const lastMessage = [...messages].reverse().find((message) => message.role !== "tool");
  const lastToolMessage = [...messages].reverse().find((message) => message.parts.some((part) => part.type === "tool_call" || part.type === "tool_result"));
  const evidence = collectEvidence(messages, limit);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    session: {
      id: details.session.id,
      harness: details.session.harness,
      status: details.session.status,
      title: details.session.title,
      cwd: details.session.cwd,
      needsPermission: details.session.needsPermission,
      messageCount: details.session.messageCount ?? null,
      lastMessage: details.session.lastMessage ?? null,
      historySource: details.history.source,
      historyComplete: details.history.complete,
      lineageKind: details.lineage.kind,
    },
    activity: messages.map((message) => summarizeMessage(message)),
    evidence: evidence.map((item) => ({ kind: item.kind, id: item.id, role: item.role, name: item.name, preview: item.preview })),
  })).digest("hex").slice(0, 16);

  return {
    session: {
      id: details.session.id,
      harness: details.session.harness,
      status: details.session.status,
      title: details.session.title,
      cwd: details.session.cwd,
      lastActivity: details.session.lastActivity,
      needsPermission: details.session.needsPermission,
      messageCount: details.session.messageCount,
      lastMessage: redactPreview(details.session.lastMessage),
    },
    activity: {
      hasMessageActivity: Boolean(lastMessage),
      hasToolActivity: Boolean(lastToolMessage),
      lastMessageId: lastMessage?.id,
      lastToolId: lastToolMessage?.id,
      historySource: details.history.source,
    },
    fingerprint: `progress:${fingerprint}`,
    evidence,
  };
}

function tailMessages(messages: SessionMessageView[], limit: number): SessionMessageView[] {
  return messages.slice(Math.max(0, messages.length - limit));
}

function collectEvidence(messages: SessionMessageView[], limit: number): SessionProgressEvidenceRef[] {
  const refs: SessionProgressEvidenceRef[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      refs.push({ kind: "message", id: message.id, role: message.role, preview: previewText(message) });
    }
    for (const part of message.parts) {
      if (part.type === "tool_call" || part.type === "tool_result") {
        refs.push({ kind: "tool", id: message.id, name: part.name, preview: previewPart(part) });
      }
    }
    if (refs.length >= limit) break;
  }
  return refs.slice(0, limit);
}

function summarizeMessage(message: SessionMessageView): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    text: message.text ?? null,
    parts: message.parts.map((part) => ({ type: part.type, name: part.name ?? null, text: part.text ?? null, output: part.output ?? null })),
  };
}

function previewText(message: SessionMessageView): string | undefined {
  return textPreview(message.text || message.parts.map(previewPart).filter(Boolean).join(" "));
}

function previewPart(part: SessionMessagePart): string | undefined {
  if (part.type === "tool_call") return textPreview(typeof part.input === "string" ? part.input : JSON.stringify(part.input));
  if (part.type === "tool_result") return textPreview(part.output);
  return textPreview(part.text);
}

function textPreview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const redacted = redactPreview(trimmed) ?? "";
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}

function redactPreview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]");
}
