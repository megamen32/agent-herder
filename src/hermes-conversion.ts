import type { ContentPart, Message } from "session-convert";

export type HermesConversionTarget = "codex" | "opencode" | "claude";

export interface HermesConversionCapabilities {
  transcriptConversion: {
    supported: true;
    mode: "export-to-neutral-conversation";
    targets: HermesConversionTarget[];
  };
  liveSessionConversion: {
    supported: false;
    reason: "hermes-export-does-not-contain-runnable-process-state";
  };
  liveSessionResume: {
    supported: false;
    reason: "hermes-export-does-not-contain-routing-or-resume-state";
  };
}

/** The neutral shape is intentionally Hermes-specific: session-convert's HarnessType does not include Hermes. */
export interface HermesNeutralConversation {
  id: string;
  sourceHarness: "hermes";
  targetHarness: HermesConversionTarget;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  model?: string;
  meta?: Record<string, unknown>;
}

export interface HermesConversionResult {
  capabilities: HermesConversionCapabilities;
  conversation?: HermesNeutralConversation;
  warnings: string[];
  unknownPayloads: unknown[];
}

export interface HermesExportInput {
  export: unknown;
  target: HermesConversionTarget;
}

const CAPABILITIES: HermesConversionCapabilities = {
  transcriptConversion: {
    supported: true,
    mode: "export-to-neutral-conversation",
    targets: ["codex", "opencode", "claude"],
  },
  liveSessionConversion: {
    supported: false,
    reason: "hermes-export-does-not-contain-runnable-process-state",
  },
  liveSessionResume: {
    supported: false,
    reason: "hermes-export-does-not-contain-routing-or-resume-state",
  },
};

/** Convert a Hermes transcript export only; this never imports or resumes a running Hermes session. */
export function convertHermesExport(input: HermesExportInput): HermesConversionResult {
  const warnings: string[] = [];
  const unknownPayloads: unknown[] = [];
  const root = asRecord(input.export);
  if (!root) {
    return { capabilities: CAPABILITIES, warnings: ["Hermes export root is not an object"], unknownPayloads: [input.export] };
  }

  const rawMessages = firstArray(root, ["messages", "history", "conversation"]);
  if (!rawMessages) {
    return {
      capabilities: CAPABILITIES,
      warnings: ["Hermes export has no messages/history/conversation array"],
      unknownPayloads: [input.export],
    };
  }

  const messages = rawMessages.map((raw, index) => normalizeMessage(raw, index, warnings, unknownPayloads));
  const id = stringValue(root.id ?? root.session_id ?? root.sessionId) ?? "hermes-export";
  const now = new Date(0).toISOString();
  const createdAt = stringValue(root.created_at ?? root.createdAt ?? root.started_at) ?? now;
  const updatedAt = stringValue(root.updated_at ?? root.updatedAt ?? root.finished_at) ?? createdAt;
  const meta: Record<string, unknown> = { hermesExport: true };
  if (unknownPayloads.length > 0) meta.unknownPayloads = unknownPayloads;
  if (root.lineage !== undefined) meta.lineage = root.lineage;

  return {
    capabilities: CAPABILITIES,
    conversation: {
      id,
      sourceHarness: "hermes",
      targetHarness: input.target,
      cwd: stringValue(root.cwd ?? root.working_directory ?? root.project_path) ?? "",
      title: stringValue(root.title ?? root.name) ?? firstText(messages) ?? id,
      createdAt,
      updatedAt,
      messages,
      model: stringValue(root.model),
      meta,
    },
    warnings,
    unknownPayloads,
  };
}

function normalizeMessage(raw: unknown, index: number, warnings: string[], unknownPayloads: unknown[]): Message {
  const record = asRecord(raw);
  if (!record) {
    warnings.push(`Hermes message ${index} is not an object`);
    unknownPayloads.push(raw);
    return { id: `hermes-message-${index}`, role: "system", parts: [{ type: "text", text: String(raw) }] };
  }

  const rawRole = stringValue(record.role ?? record.type) ?? "system";
  const role = rawRole === "user" || rawRole === "assistant" || rawRole === "system" || rawRole === "tool" ? rawRole : "system";
  if (role === "system" && rawRole !== "system") warnings.push(`Hermes message ${index} has unknown role '${rawRole}'`);
  const parts: ContentPart[] = [];
  const content = record.content ?? record.parts ?? record.text;
  if (!(role === "tool" && record.tool_call_id !== undefined)) {
    appendContent(parts, content, `message ${index}`, warnings, unknownPayloads);
  }
  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) appendToolCall(parts, call, `message ${index}`, warnings, unknownPayloads);
  }
  if (record.tool_call_id !== undefined && role === "tool") {
    const result = textValue(record.content ?? record.output ?? "");
    parts.push({ type: "tool_result", toolCallId: stringValue(record.tool_call_id) ?? `hermes-tool-${index}`, content: result, isError: record.is_error === true });
  }
  if (parts.length === 0) {
    warnings.push(`Hermes message ${index} has no recognized content`);
    unknownPayloads.push(raw);
  }
  return {
    id: stringValue(record.id ?? record.message_id) ?? `hermes-message-${index}`,
    role,
    parts,
    timestamp: stringValue(record.timestamp ?? record.created_at ?? record.createdAt),
    model: stringValue(record.model),
  };
}

function appendContent(parts: ContentPart[], content: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
    return;
  }
  if (Array.isArray(content)) {
    content.forEach((part, index) => appendBlock(parts, part, `${context} part ${index}`, warnings, unknownPayloads));
    return;
  }
  if (content !== undefined && content !== null) appendBlock(parts, content, context, warnings, unknownPayloads);
}

function appendBlock(parts: ContentPart[], raw: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  const block = asRecord(raw);
  if (!block) {
    if (typeof raw === "string") parts.push({ type: "text", text: raw });
    else { warnings.push(`Unknown Hermes payload at ${context}`); unknownPayloads.push(raw); }
    return;
  }
  const type = stringValue(block.type ?? block.kind);
  if (type === "text" || type === "input_text" || type === "output_text") {
    parts.push({ type: "text", text: textValue(block.text ?? block.content ?? "") });
  } else if (type === "thinking" || type === "reasoning") {
    parts.push({ type: "thinking", text: textValue(block.text ?? block.content ?? "") });
  } else if (type === "tool_use" || type === "tool_call") {
    appendToolCall(parts, block, context, warnings, unknownPayloads);
  } else if (type === "tool_result" || type === "tool_response") {
    parts.push({ type: "tool_result", toolCallId: stringValue(block.tool_call_id ?? block.toolCallId ?? block.id) ?? `${context}-tool`, name: stringValue(block.name), content: textValue(block.content ?? block.output ?? block.result ?? ""), isError: block.is_error === true || block.isError === true });
  } else {
    warnings.push(`Unknown Hermes payload at ${context}`);
    unknownPayloads.push(raw);
  }
}

function appendToolCall(parts: ContentPart[], raw: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  const block = asRecord(raw);
  if (!block) { warnings.push(`Unknown Hermes tool call at ${context}`); unknownPayloads.push(raw); return; }
  const fn = asRecord(block.function);
  const name = stringValue(block.name ?? fn?.name) ?? "unknown_tool";
  const rawInput = block.input ?? block.arguments ?? fn?.arguments ?? {};
  let input: Record<string, unknown> = {};
  if (isRecord(rawInput)) input = rawInput;
  else { warnings.push(`Hermes tool call '${name}' has non-object input`); unknownPayloads.push(rawInput); }
  parts.push({ type: "tool_call", id: stringValue(block.id ?? block.tool_call_id) ?? `${context}-${name}`, name, input, finished: block.finished === true });
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function textValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
function firstText(messages: Message[]): string | undefined { for (const message of messages) for (const part of message.parts) if (part.type === "text" && part.text) return part.text.slice(0, 80); return undefined; }
