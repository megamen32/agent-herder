import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StopHookInput = {
  hook_event_name: "Stop";
  session_id: string;
  cwd: string;
  turn_id: string;
  last_assistant_message: string | null;
  transcript_path: string | null;
  stop_hook_active: boolean;
  model?: string;
};

export type AutopilotDecision =
  | { kind: "continue"; nextGoal: string }
  | { kind: "done"; summary: string; notify?: boolean }
  | {
      kind: "human";
      title: string;
      body: string;
      severity: "low" | "medium" | "high";
    };

export type AutopilotHookResult =
  | { decision: "block"; reason: string }
  | {};

export type JudgeClient = {
  decide(input: {
    hook: StopHookInput;
    evidence: string;
    remainingContinuations: number;
  }): Promise<unknown>;
};

export type NoticeSeverity =
  | "debug"
  | "info"
  | "notice"
  | "important"
  | "critical"
  | "emergency";

export type NotificationPayload = {
  schema: "notify.event.v1";
  project: string;
  recipient: string;
  kind: string;
  severity: NoticeSeverity;
  title: string;
  body: string;
  dedup_key: string;
  correlation_id: string;
};

export type NotificationSink = {
  send(payload: NotificationPayload): Promise<void>;
};

export type Receipt = { kind: AutopilotDecision["kind"] };
export type ReceiptStore = Map<string, Receipt>;

export type NotificationConfig = {
  project: string;
  recipient: string;
  kind: string;
};

const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_LAST_ASSISTANT_BYTES = 8 * 1024;
const MAX_REASON_LENGTH = 4 * 1024;
const LAST_ASSISTANT_PREFIX = "\nLast assistant message:\n";
const DEFAULT_NOTIFICATION: NotificationConfig = {
  project: "agent-herder",
  recipient: "me",
  kind: "notification",
};

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]*PRIVATE KEY-----/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s"'`,;]+/gi;
const API_KEY_PATTERN =
  /(\b(?:[A-Za-z0-9]+[_-])?api[-_\s]*key\b["']?\s*[:=]\s*)(["']?)[^\s"'`,;}\]]+/gi;
const PASSWORD_PATTERN =
  /(\b(?:password|passwd|pwd)\b["']?\s*[:=]\s*)(["']?)[^\s"'`,;}\]]+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:token|secret|client[_-]?secret|access[_-]?key|private[_-]?key|authorization)\b["']?\s*[:=]\s*)(["']?)[^\s"'`,;}\]]+/gi;
const STANDALONE_API_KEY_PATTERN =
  /\b(?:sk|pk|rk|ak|ghp|github_pat)[_-][A-Za-z0-9_-]{8,}\b/gi;

/**
 * Build the exact event envelope consumed by the existing NoticePlace/Notify
 * producer seam. Channel fan-out, including Matrix and any already configured
 * channels, remains the delivery owner's responsibility.
 */
export function createNoticePlacePayload(input: {
  title: string;
  body: string;
  severity: "low" | "medium" | "high" | NoticeSeverity;
  dedupKey: string;
  correlationId: string;
  project?: string;
  recipient?: string;
  kind?: string;
}): NotificationPayload {
  return {
    schema: "notify.event.v1",
    project: input.project ?? DEFAULT_NOTIFICATION.project,
    recipient: input.recipient ?? DEFAULT_NOTIFICATION.recipient,
    kind: input.kind ?? DEFAULT_NOTIFICATION.kind,
    severity: toNoticeSeverity(input.severity),
    title: bounded(input.title, 512),
    body: bounded(input.body, 8 * 1024),
    dedup_key: input.dedupKey,
    correlation_id: input.correlationId,
  };
}

/**
 * Minimal producer adapter. It deliberately talks to NoticePlace only; it
 * does not contain Matrix or Telegram transport logic.
 */
export function createNoticePlaceSink(config: {
  eventUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): NotificationSink {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async send(payload) {
      const response = await fetchImpl(config.eventUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "idempotency-key": payload.dedup_key,
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Notify event rejected with HTTP ${response.status}`);
      }
    },
  };
}

/**
 * OpenAI-compatible JSON judge. The endpoint/model are intentionally supplied
 * by the runtime environment; no provider or credential is hard-coded here.
 */
export function createOpenAICompatibleJudge(config: {
  baseUrl: string;
  model: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): JudgeClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    async decide(input) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          // The judge parser consumes one JSON response. Explicitly disable
          // gateway SSE defaults so OpenAI-compatible providers do not return
          // `data:` frames that cannot be parsed as a single document.
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are the Agent Herder stop-hook judge. Return only JSON. " +
                "Choose exactly one kind: continue, done, or human. " +
                "Use continue only when a concrete next goal can be executed " +
                "in the same Codex session. Use done only when the user's " +
                "objective is actually complete. Use human when permission, " +
                "credentials, an irreversible decision, or missing user input " +
                "is required. Shape: {kind:continue,nextGoal:string} or " +
                "{kind:done,summary:string,notify:boolean} or " +
                "{kind:human,title:string,body:string,severity:low|medium|high}. " +
                "Do not put credentials, tokens, private keys, or raw secrets " +
                "in nextGoal, summary, title, or body.",
            },
            {
              role: "user",
              content: JSON.stringify({
                hook: input.hook,
                evidence: input.evidence,
                remaining_continuations: input.remainingContinuations,
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Judge request rejected with HTTP ${response.status}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      const content = extractJudgeContent(body);
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new Error("Judge returned non-JSON content");
      }
    },
  };
}

export function createAutopilotCore(options: {
  judge: JudgeClient;
  notify: NotificationSink;
  allowSessions: ReadonlySet<string>;
  receiptStore: ReceiptStore;
  maxContinuationsPerSession: number;
  notification?: NotificationConfig;
}): { handleStop(input: StopHookInput): Promise<AutopilotHookResult> } {
  const continuationCounts = new Map<string, number>();
  const activeReceiptKeys = new Set<string>();
  const notification = options.notification ?? DEFAULT_NOTIFICATION;
  const maxContinuations = Math.max(
    0,
    Math.floor(options.maxContinuationsPerSession),
  );

  return {
    async handleStop(input) {
      validateInput(input);

      // A global Stop hook must be harmless for sessions that were not
      // explicitly armed for autopilot.
      if (!options.allowSessions.has(input.session_id)) {
        return {};
      }

      const receiptKey = receiptKeyFor(input.session_id, input.turn_id);
      if (options.receiptStore.has(receiptKey) || activeReceiptKeys.has(receiptKey)) {
        return {};
      }

      const currentCount =
        continuationCounts.get(input.session_id) ??
        countPersistedContinuations(options.receiptStore, input.session_id);
      const remainingContinuations = maxContinuations - currentCount;
      if (remainingContinuations <= 0) {
        return {};
      }

      activeReceiptKeys.add(receiptKey);
      try {
        const evidence = await readBoundedEvidence(
          input.transcript_path,
          input.last_assistant_message,
        );
        const decision = normalizeDecision(
          await options.judge.decide({
            hook: sanitizeHookForJudge(input),
            evidence,
            remainingContinuations,
          }),
        );

        if (decision.kind === "continue") {
          continuationCounts.set(input.session_id, currentCount + 1);
          options.receiptStore.set(receiptKey, { kind: decision.kind });
          return {
            decision: "block",
            reason: bounded(decision.nextGoal, MAX_REASON_LENGTH),
          };
        }

        if (decision.kind === "human") {
          await options.notify.send(
            createNoticePlacePayload({
              title: decision.title,
              body: decision.body,
              severity: decision.severity,
              dedupKey: `agent-herder:human:${input.session_id}:${input.turn_id}`,
              correlationId: `${input.session_id}/${input.turn_id}`,
              ...notification,
            }),
          );
        } else if (decision.notify) {
          await options.notify.send(
            createNoticePlacePayload({
              title: "Agent Herder завершил работу",
              body: decision.summary,
              severity: "low",
              dedupKey: `agent-herder:done:${input.session_id}:${input.turn_id}`,
              correlationId: `${input.session_id}/${input.turn_id}`,
              ...notification,
            }),
          );
        }

        // done/human are terminal for this hook invocation. Returning block
        // here would cause Codex to continue after the judge said to stop.
        options.receiptStore.set(receiptKey, { kind: decision.kind });
        return {};
      } finally {
        activeReceiptKeys.delete(receiptKey);
      }
    },
  };
}

export async function readBoundedEvidence(
  transcriptPath: string | null,
  lastAssistantMessage: string | null,
): Promise<string> {
  const hasLastAssistantMessage = lastAssistantMessage !== null;
  const lastPrefix = hasLastAssistantMessage ? LAST_ASSISTANT_PREFIX : "";
  const transcriptBudget = Math.max(
    0,
    MAX_EVIDENCE_BYTES -
      (hasLastAssistantMessage ? MAX_LAST_ASSISTANT_BYTES : 0) -
      byteLength(lastPrefix),
  );
  const transcript = transcriptPath
    ? await readTail(transcriptPath, transcriptBudget).catch(() => "")
    : "";
  const boundedTranscript = boundedUtf8(
    redactSecrets(transcript),
    transcriptBudget,
  );
  const lastMessage = hasLastAssistantMessage
    ? `${lastPrefix}${boundedUtf8(
        redactSecrets(lastAssistantMessage),
        MAX_LAST_ASSISTANT_BYTES,
      )}`
    : "";
  return boundedUtf8(`${boundedTranscript}${lastMessage}`, MAX_EVIDENCE_BYTES);
}

function sanitizeHookForJudge(input: StopHookInput): StopHookInput {
  return {
    ...input,
    last_assistant_message:
      input.last_assistant_message === null
        ? null
        : redactSecrets(input.last_assistant_message),
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(BEARER_PATTERN, "[REDACTED_BEARER]")
    .replace(STANDALONE_API_KEY_PATTERN, "[REDACTED_API_KEY]")
    .replace(
      API_KEY_PATTERN,
      (_match: string, prefix: string, quote: string) =>
        `${prefix}${quote}[REDACTED_API_KEY]`,
    )
    .replace(
      PASSWORD_PATTERN,
      (_match: string, prefix: string, quote: string) =>
        `${prefix}${quote}[REDACTED_PASSWORD]`,
    )
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match: string, prefix: string, quote: string) =>
        `${prefix}${quote}[REDACTED_SECRET]`,
    );
}

function validateInput(input: StopHookInput): void {
  if (input.hook_event_name !== "Stop") {
    throw new Error("hook_event_name must be Stop");
  }

  for (const [name, value] of [
    ["session_id", input.session_id],
    ["cwd", input.cwd],
    ["turn_id", input.turn_id],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} must be a non-empty string`);
    }
  }

  if (
    input.last_assistant_message !== null &&
    typeof input.last_assistant_message !== "string"
  ) {
    throw new Error("last_assistant_message must be a string or null");
  }
  if (input.transcript_path !== null && typeof input.transcript_path !== "string") {
    throw new Error("transcript_path must be a string or null");
  }
  if (typeof input.stop_hook_active !== "boolean") {
    throw new Error("stop_hook_active must be boolean");
  }
}

function normalizeDecision(value: unknown): AutopilotDecision {
  if (!value || typeof value !== "object") {
    throw new Error("Judge decision must be an object");
  }

  const decision = value as Record<string, unknown>;
  if (decision.kind === "continue" && typeof decision.nextGoal === "string") {
    return { kind: "continue", nextGoal: bounded(decision.nextGoal, MAX_REASON_LENGTH) };
  }
  if (decision.kind === "done" && typeof decision.summary === "string") {
    return {
      kind: "done",
      summary: bounded(decision.summary, 8 * 1024),
      notify: decision.notify !== false,
    };
  }
  if (
    decision.kind === "human" &&
    typeof decision.title === "string" &&
    typeof decision.body === "string" &&
    (decision.severity === "low" ||
      decision.severity === "medium" ||
      decision.severity === "high")
  ) {
    return {
      kind: "human",
      title: bounded(decision.title, 512),
      body: bounded(decision.body, 8 * 1024),
      severity: decision.severity,
    };
  }

  throw new Error("Malformed judge decision");
}

function countPersistedContinuations(store: ReceiptStore, sessionId: string): number {
  const prefix = `${encodeURIComponent(sessionId)}:`;
  let count = 0;
  for (const [key, receipt] of store) {
    if (key.startsWith(prefix) && receipt.kind === "continue") count += 1;
  }
  return count;
}

function receiptKeyFor(sessionId: string, turnId: string): string {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}`;
}

function toNoticeSeverity(value: "low" | "medium" | "high" | NoticeSeverity): NoticeSeverity {
  if (value === "low") return "info";
  if (value === "medium") return "notice";
  if (value === "high") return "important";
  return value;
}

function bounded(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;

  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    const size = Number(stats.size);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractJudgeContent(body: Record<string, unknown>): string {
  const choices = body.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .filter(
              (part): part is Record<string, unknown> =>
                Boolean(part) && typeof part === "object",
            )
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("");
        }
      }
    }
  }

  if (typeof body.output_text === "string") return body.output_text;
  throw new Error("Judge response did not contain message content");
}

/** Read a JSON receipt file without treating a missing/corrupt file as proof of a completed turn. */
export async function loadReceiptStore(path: string): Promise<ReceiptStore> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Autopilot receipt store is corrupt");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Autopilot receipt store has an invalid shape");
  }

  const store: ReceiptStore = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).kind &&
      ["continue", "done", "human"].includes(
        String((value as Record<string, unknown>).kind),
      )
    ) {
      store.set(key, { kind: (value as Receipt).kind });
    }
  }
  return store;
}

export async function persistReceiptStore(path: string, store: ReceiptStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const serialized = Object.fromEntries(store.entries());
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(serialized, null, 2), "utf8");
  await rename(temporaryPath, path);
}
