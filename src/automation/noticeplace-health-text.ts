/**
 * Bounded, redacted text for Notice Place health progress.
 *
 * A health incident card is delivered to a human (and to Telegram), so no
 * token-shaped substring of the executor's transcript may ever reach it. The
 * executor is told to read a protected callback file that carries tokens, so
 * the raw model text is not publishable as-is: it is redacted, bounded and
 * described structurally instead.
 */

/** Bearer credentials, in any casing, with the value replaced. */
const BEARER_PATTERN = /\b(bearer\s+)[^\s,;"']+/gi;
/** Key/value secrets: api_key=…, "token": "…", secret: … */
const SECRET_VALUE_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|secret|password|passwd|credential|private[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi;
/** Query-string secrets: ?token=…&signature=… */
const QUERY_SECRET_PATTERN = /([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi;
/** Long opaque blobs: hex digests, base64, JWT segments. */
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9+/_.-]{32,}/g;

/** Longest card step published for one observation tick. */
export const HEALTH_STEP_LIMIT = 220;
/** Longest excerpt of the last message quoted inside a card step. */
export const HEALTH_EXCERPT_LIMIT = 160;
/** Longest error detail read back from the center. */
export const HEALTH_ERROR_DETAIL_LIMIT = 200;

/** Replace every token-shaped substring; never returns a value with a secret. */
export function redactHealthText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(SECRET_VALUE_PATTERN, "$1$2[redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(OPAQUE_TOKEN_PATTERN, (match) => (isOpaqueToken(match) ? "[redacted]" : match));
}

/**
 * An opaque token is a long blob, not an ordinary word.
 *
 * A blob mixes letters and digits (base64, JWT, hash with digits) or is a
 * hex digest. A long hyphenated word or a path stays readable.
 */
function isOpaqueToken(match: string): boolean {
  if (/[A-Za-z]/.test(match) && /\d/.test(match)) return true;
  return /^[0-9a-fA-F]{32,}$/.test(match);
}

/** Redact, collapse whitespace and bound the length of one published text. */
export function boundedHealthText(value: string, limit = HEALTH_STEP_LIMIT): string {
  const redacted = redactHealthText(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 3))}...`;
}

/** What one observation tick knows about the executor. */
export interface HealthStepInput {
  /** Native session status as herder reports it. */
  status: string;
  /** Message count of the observed session, when the harness exposes it. */
  messageCount?: number;
  /** Tools seen in the observed message window. */
  toolNames: string[];
  /** Role of the last non-tool message. */
  lastMessageRole?: string;
  /** Text of the last non-tool message; never published unredacted. */
  lastMessageText?: string;
  /** Native history source, so an incomplete history is not presented as fact. */
  historySource?: string;
  /** Whether the observed history is complete. */
  historyComplete?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  user: "оператор",
  assistant: "исполнитель",
  tool: "инструмент",
  system: "система",
};

/**
 * One honest step for the incident card.
 *
 * The card shows a structural summary of the observed session plus a redacted
 * fragment of the last message. It never shows the raw model text, and it
 * always names its source, so an incomplete history is not read as a fact.
 */
export function describeHealthStep(input: HealthStepInput): string | undefined {
  const parts: string[] = ["Исполнитель работает", "по данным сессии"];
  parts.push(`статус: ${boundedHealthText(input.status || "неизвестен", 32)}`);
  if (typeof input.messageCount === "number" && Number.isFinite(input.messageCount)) {
    parts.push(`сообщений в сессии: ${Math.max(0, Math.trunc(input.messageCount))}`);
  }
  const tools = [...new Set(input.toolNames.filter((name) => typeof name === "string" && name.trim()))].slice(0, 5);
  if (tools.length) parts.push(`инструменты: ${tools.map((name) => boundedHealthText(name, 32)).join(", ")}`);
  if (input.lastMessageRole) {
    parts.push(`последнее сообщение: ${ROLE_LABELS[input.lastMessageRole] ?? boundedHealthText(input.lastMessageRole, 32)}`);
  }
  const source = input.historyComplete === false ? " (история неполная)" : input.historySource ? ` (${boundedHealthText(input.historySource, 32)})` : "";
  const head = `${parts.join("; ")}${source}.`;
  const excerpt = input.lastMessageText?.trim();
  if (!excerpt) return boundedHealthText(head, HEALTH_STEP_LIMIT);
  const quoted = boundedHealthText(excerpt, HEALTH_EXCERPT_LIMIT);
  if (!quoted) return boundedHealthText(head, HEALTH_STEP_LIMIT);
  return boundedHealthText(`${head} Фрагмент: «${quoted}»`, HEALTH_STEP_LIMIT);
}
