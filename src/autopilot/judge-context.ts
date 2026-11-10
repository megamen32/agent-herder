import { Buffer } from "node:buffer";
import { redactSecrets } from "./index.js";

/** Local payload budgets, not claims about a provider's model context window. */
export const DEFAULT_AUTOPILOT_JUDGE_CONTEXT_BYTES = 128 * 1024;
export const AUTOPILOT_JUDGE_CONTEXT_HARD_LIMIT_BYTES = 512 * 1024;
const MAX_HISTORY_MESSAGES = 4096;
const MAX_TEXT_PARTS = 256;

export type AutopilotJudgeContextErrorCode =
  | "missing_user_message"
  | "missing_assistant_message"
  | "context_too_large"
  | "invalid_context_budget";

export class AutopilotJudgeContextError extends Error {
  constructor(
    readonly code: AutopilotJudgeContextErrorCode,
    message: string,
    readonly details: Readonly<Record<string, number>> = {},
  ) {
    super(message);
    this.name = "AutopilotJudgeContextError";
  }
}

/** Accepts native SessionMessageView (text/parts) and API messages (content).
 * Unknown blocks and roles are not serialized into the judge's prompt. */
export interface AutopilotJudgeMessageInput {
  readonly role: string;
  readonly id?: string;
  readonly text?: unknown;
  readonly content?: unknown;
  readonly parts?: unknown;
}

export interface AutopilotJudgeContextInput {
  /** Supplied by the caller's trusted human-input selection, never inferred here. */
  lastUserMessage: string | null | undefined;
  lastAssistantMessage: string | null | undefined;
  lastUserMessageId?: string;
  lastAssistantMessageId?: string;
  messages?: readonly AutopilotJudgeMessageInput[];
  maxContextBytes?: number;
  /** May reduce, but cannot increase, the implementation's hard limit. */
  hardLimitBytes?: number;
}

export interface AutopilotJudgeHistoryMessage {
  role: "user" | "assistant";
  content: string;
  id?: string;
}

export interface AutopilotJudgeContext {
  lastUserMessage: string;
  lastAssistantMessage: string;
  /** Older complete turns only. The mandatory messages live in their own fields. */
  messages: AutopilotJudgeHistoryMessage[];
  truncation: {
    /** UTF-8 JSON bytes of the three payload fields; excludes this metadata. */
    contextBytes: number;
    mandatoryBytes: number;
    maxContextBytes: number;
    hardLimitBytes: number;
    softBudgetExceeded: boolean;
    inputMessages: number;
    includedMessages: number;
    omittedMessages: number;
    duplicateMessagesRemoved: number;
    currentTurnMessagesOmitted: number;
    unsupportedMessagesOmitted: number;
    oversizedMessagesOmitted: number;
    incompleteMessagesOmitted: number;
    budgetMessagesOmitted: number;
    scanLimitMessagesOmitted: number;
    historyTruncated: boolean;
  };
}

type Normalized = {
  message: AutopilotJudgeHistoryMessage;
  sourceIndex: number;
  nativeId?: string;
};
type TextResult = { text: string } | { oversized: true } | null;

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveBudget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1
    || value > AUTOPILOT_JUDGE_CONTEXT_HARD_LIMIT_BYTES) {
    throw new AutopilotJudgeContextError(
      "invalid_context_budget", name + " must be a positive integer within the hard context limit",
    );
  }
  return value;
}

function mandatory(value: string | null | undefined, role: "user" | "assistant"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AutopilotJudgeContextError(
      role === "user" ? "missing_user_message" : "missing_assistant_message",
      "The complete latest " + role + " message is required",
    );
  }
  // Do not use notification/card projection: it deliberately abbreviates text.
  return redactSecrets(value);
}

function historyText(input: AutopilotJudgeMessageInput, limit: number): TextResult {
  const direct = typeof input.text === "string" && input.text.trim()
    ? input.text : typeof input.content === "string" ? input.content : null;
  if (direct !== null) {
    if (direct.length > limit || bytes(direct) > limit) return { oversized: true };
    return direct.trim() ? { text: redactSecrets(direct) } : null;
  }
  const parts = Array.isArray(input.content) ? input.content
    : Array.isArray(input.parts) ? input.parts : [];
  if (parts.length > MAX_TEXT_PARTS) return { oversized: true };
  const texts: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const block = part as Record<string, unknown>;
    if (typeof block.type !== "string"
      || !["text", "input_text", "output_text", "markdown"].includes(block.type)) continue;
    const text = typeof block.text === "string" ? block.text
      : typeof block.content === "string" ? block.content : null;
    if (text === null || !text.trim()) continue;
    if (text.length > limit) return { oversized: true };
    total += bytes(text) + (texts.length ? 1 : 0);
    if (total > limit) return { oversized: true };
    texts.push(text);
  }
  return texts.length ? { text: redactSecrets(texts.join("\n")) } : null;
}

/** Reserve the complete, redacted latest human input and assistant response,
 * then fill the remaining soft budget with the newest complete history turns.
 *
 * A mandatory pair above the soft budget is retained without abbreviation.
 * A pair above the hard limit fails explicitly. Unknown/empty input never
 * falls back to a possibly generated "user" message from the history.
 *
 * Byte budgets cover JSON for lastUserMessage, lastAssistantMessage and
 * messages (including escaping and IDs). The caller must separately budget
 * its system instructions, transport envelope and this bounded metadata.
 */
export function buildAutopilotJudgeContext(
  input: AutopilotJudgeContextInput,
): AutopilotJudgeContext {
  const hardLimitBytes = positiveBudget(
    input.hardLimitBytes ?? AUTOPILOT_JUDGE_CONTEXT_HARD_LIMIT_BYTES, "hardLimitBytes",
  );
  const maxContextBytes = positiveBudget(
    input.maxContextBytes ?? Math.min(DEFAULT_AUTOPILOT_JUDGE_CONTEXT_BYTES, hardLimitBytes),
    "maxContextBytes",
  );
  if (maxContextBytes > hardLimitBytes) {
    throw new AutopilotJudgeContextError(
      "invalid_context_budget", "maxContextBytes must not exceed hardLimitBytes",
    );
  }
  const lastUserMessage = mandatory(input.lastUserMessage, "user");
  const lastAssistantMessage = mandatory(input.lastAssistantMessage, "assistant");
  const mandatoryBytes = bytes(JSON.stringify({ lastUserMessage, lastAssistantMessage, messages: [] }));
  if (mandatoryBytes > hardLimitBytes) {
    throw new AutopilotJudgeContextError(
      "context_too_large", "The mandatory latest messages exceed the supported complete-context limit",
      { mandatoryBytes, hardLimitBytes },
    );
  }

  const source = Array.isArray(input.messages) ? input.messages : [];
  let scanStart = Math.max(0, source.length - MAX_HISTORY_MESSAGES);
  let scannedTextBytes = 0;
  const entries: Normalized[] = [];
  let unsupportedMessagesOmitted = 0;
  let oversizedMessagesOmitted = 0;
  // Read from the newest end and cap materialized text as well as row count.
  // A very large history never becomes another unbounded serialized prompt.
  for (let index = source.length - 1; index >= scanStart; index--) {
    const item = source[index];
    if (!item || typeof item !== "object" || Array.isArray(item)
      || (item.role !== "user" && item.role !== "assistant")) {
      unsupportedMessagesOmitted++;
      continue;
    }
    const text = historyText(item, hardLimitBytes);
    if (!text) { unsupportedMessagesOmitted++; continue; }
    if ("oversized" in text) { oversizedMessagesOmitted++; continue; }
    const textBytes = bytes(text.text);
    if (scannedTextBytes + textBytes > hardLimitBytes * 4) {
      scanStart = index + 1;
      break;
    }
    scannedTextBytes += textBytes;
    const nativeId = typeof item.id === "string" ? item.id : undefined;
    const id = nativeId && nativeId.length <= 256 && bytes(nativeId) <= 256
      ? redactSecrets(nativeId) : undefined;
    entries.push({
      sourceIndex: index, nativeId,
      message: { role: item.role, content: text.text, ...(id ? { id } : {}) },
    });
  }

  entries.reverse();

  const duplicates = new Set<number>();
  for (const pair of [
    { role: "user", text: lastUserMessage, id: input.lastUserMessageId },
    { role: "assistant", text: lastAssistantMessage, id: input.lastAssistantMessageId },
  ] as const) {
    const reverse = [...entries].reverse();
    const exactId = pair.id ? reverse.find(row =>
      row.message.role === pair.role && row.nativeId === pair.id) : undefined;
    const match = exactId ?? reverse.find(row =>
      row.message.role === pair.role && row.message.content === pair.text);
    if (match) duplicates.add(match.sourceIndex);
  }

  const turns: Normalized[][] = [];
  const normalized = new Map(entries.map(entry => [entry.sourceIndex, entry]));
  let current: Normalized[] = [];
  let hasUser = false;
  let hasAssistant = false;
  let invalidTurn = false;
  let incompleteMessagesOmitted = 0;
  const closeTurn = () => {
    if (hasUser && hasAssistant && !invalidTurn) turns.push(current);
    else incompleteMessagesOmitted += current.length;
    current = [];
    hasUser = false;
    hasAssistant = false;
    invalidTurn = false;
  };
  // Keep native role boundaries even when an oversized/unsupported text was
  // omitted. Filtering first would incorrectly join that user to the next turn.
  for (let index = scanStart; index < source.length; index++) {
    const item = source[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = normalized.get(index);
    if (item.role === "user") {
      if (hasUser) closeTurn();
      hasUser = true;
      if (entry) current.push(entry);
      else invalidTurn = true;
    } else if (item.role === "assistant") {
      if (!hasUser) {
        if (entry) incompleteMessagesOmitted++;
      } else {
        hasAssistant = true;
        if (entry) current.push(entry);
        else invalidTurn = true;
      }
    }
  }
  closeTurn();

  // Omit the entire represented turn, keeping older user/assistant relationships
  // intact. Do not leave an orphaned assistant after deduplicating the last user.
  let currentTurnMessagesOmitted = 0;
  const olderTurns = turns.filter(turn => {
    if (!turn.some(entry => duplicates.has(entry.sourceIndex))) return true;
    currentTurnMessagesOmitted += turn.length;
    return false;
  });
  const kept: AutopilotJudgeHistoryMessage[][] = [];
  let contextBytes = mandatoryBytes;
  let budgetMessagesOmitted = 0;
  for (let index = olderTurns.length - 1; index >= 0; index--) {
    const turn = olderTurns[index].map(entry => entry.message);
    const turnBytes = turn.reduce((total, item) => total + bytes(JSON.stringify(item)), 0)
      + turn.length - 1 + (kept.length ? 1 : 0);
    if (contextBytes + turnBytes > maxContextBytes) {
      for (let omitted = 0; omitted <= index; omitted++) {
        budgetMessagesOmitted += olderTurns[omitted].length;
      }
      break;
    }
    contextBytes += turnBytes;
    kept.unshift(turn);
  }
  const messages = kept.flat();
  return {
    lastUserMessage, lastAssistantMessage, messages,
    truncation: {
      contextBytes, mandatoryBytes, maxContextBytes, hardLimitBytes,
      softBudgetExceeded: mandatoryBytes > maxContextBytes,
      inputMessages: source.length,
      includedMessages: messages.length,
      omittedMessages: source.length - messages.length,
      duplicateMessagesRemoved: duplicates.size,
      currentTurnMessagesOmitted,
      unsupportedMessagesOmitted, oversizedMessagesOmitted,
      incompleteMessagesOmitted, budgetMessagesOmitted,
      scanLimitMessagesOmitted: scanStart,
      historyTruncated: scanStart > 0 || unsupportedMessagesOmitted > 0
        || oversizedMessagesOmitted > 0 || incompleteMessagesOmitted > 0
        || budgetMessagesOmitted > 0 || currentTurnMessagesOmitted > duplicates.size,
    },
  };
}
