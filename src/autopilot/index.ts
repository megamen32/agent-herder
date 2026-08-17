import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ChoiceRegistry, type AutopilotChoice } from "./choice-registry.js";
import {
  effectivePolicyAllowsTarget,
  type EffectivePolicy,
} from "./policy.js";

export type StopHookInput = {
  hook_event_name: "Stop";
  session_id: string;
  cwd: string;
  turn_id: string;
  last_user_message?: string | null;
  last_assistant_message: string | null;
  transcript_path: string | null;
  stop_hook_active: boolean;
  model?: string;
  harness?: "codex" | "opencode" | "claude" | "hermes" | "zcode";
};

export type AutopilotDecision =
  | { kind: "continue"; nextGoal: string }
  | { kind: "done"; summary: string; notify?: boolean }
  | {
      kind: "human";
      title: string;
      body: string;
      severity: "low" | "medium" | "high";
    }
  | { kind: "choice"; choices: AutopilotChoice[] };

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
  choices?: Array<{ choice_id: string; label: string }>;
  choice_request_id?: string;
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
const MAX_CHOICE_CONTEXT_BYTES = 2 * 1024;
const MAX_CHOICE_LAST_MESSAGE_BYTES = 1_200;
const MAX_CHOICE_TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024;
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
const CHOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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
  choices?: Array<{ choice_id: string; label: string }>;
  choice_request_id?: string;
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
    ...(input.choices ? { choices: input.choices } : {}),
    ...(input.choice_request_id ? { choice_request_id: input.choice_request_id } : {}),
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
                "Choose exactly one kind: continue, done, human, or choice. " +
                "If uncertain between 2-4 safe next steps, use choice with " +
                "{kind:choice,choices:[{choiceId,label,nextGoal}]}; choiceId is opaque, " +
                "label is a concise, self-contained Russian user-facing action, and nextGoal is bounded text for this exact agent session. " +
                "Use continue only when a concrete next goal can be executed " +
                "in the same agent session. Use done only when the user's " +
                "objective is actually complete. For a bounded user decision, including " +
                "proceed, modify, or abort before an irreversible action, use choice so " +
                "the user receives actionable Russian buttons. Use human only when " +
                "free-form input, credentials, or a secret is required and 2-4 safe " +
                "enumerated choices cannot represent the answer. When " +
                "remaining_continuations is 0, never return continue; return done, choice, or human. " +
                "Shape: {kind:continue,nextGoal:string} or " +
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
        return parseJudgeJson(content);
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
  allowAllSessions?: boolean;
  receiptStore: ReceiptStore;
  maxContinuationsPerSession: number;
  notification?: NotificationConfig;
  choiceRegistry?: ChoiceRegistry;
  effectivePolicy?: EffectivePolicy;
  policyBypassSessionId?: string;
  harness?: "codex" | "opencode" | "claude" | "hermes" | "zcode";
  onDecision?: (decision: AutopilotDecision, metadata?: { choiceRequestId?: string }) => void;
}): { handleStop(input: StopHookInput): Promise<AutopilotHookResult> } {
  const continuationCounts = new Map<string, number>();
  const activeReceiptKeys = new Set<string>();
  const notification = options.notification ?? DEFAULT_NOTIFICATION;
  const maxContinuations = Math.max(
    0,
    Math.floor(options.effectivePolicy?.source === "persisted"
      ? options.effectivePolicy.policy.maxContinuationsPerSession
      : options.maxContinuationsPerSession),
  );

  return {
    async handleStop(input) {
      validateInput(input);

      if (options.effectivePolicy) {
        // A per-session opt-in can widen the selector, but never bypasses the
        // global master switch. Turning the master off is an immediate stop.
        const explicitSessionOverride = options.policyBypassSessionId === input.session_id
          && (options.effectivePolicy.source !== "persisted" || options.effectivePolicy.policy.enabled);
        if (!explicitSessionOverride && !effectivePolicyAllowsTarget(options.effectivePolicy, {
          harness: options.harness ?? input.harness ?? "codex",
          sessionId: input.session_id,
          cwd: input.cwd,
        })) return {};
      } else if (!options.allowAllSessions && !options.allowSessions.has(input.session_id)) {
        // Compatibility path for callers that have not loaded the durable
        // policy yet. The real Stop hook always supplies effectivePolicy.
        return {};
      }

      const evidence = await readBoundedEvidence(
        input.transcript_path,
        input.last_assistant_message,
      );
      const receiptKey = receiptKeyFor(input, evidence);
      if (options.receiptStore.has(receiptKey) || activeReceiptKeys.has(receiptKey)) {
        return {};
      }

      const budgetKey = `${input.session_id}:${input.turn_id}`;
      const currentCount =
        continuationCounts.get(budgetKey) ??
        countPersistedContinuations(options.receiptStore, input.session_id, input.turn_id);
      const remainingContinuations = Math.max(0, maxContinuations - currentCount);

      activeReceiptKeys.add(receiptKey);
      try {
        const decision = normalizeDecision(
          await options.judge.decide({
            hook: sanitizeHookForJudge(input),
            evidence,
            remainingContinuations,
          }),
        );

        if (decision.kind === "continue") {
          options.onDecision?.(decision);
          if (remainingContinuations <= 0) {
            await options.notify.send(
              createNoticePlacePayload({
                title: `Agent Herder: достигнут лимит автопродолжений по ${projectLabel(input.cwd)}`,
                body: boundedUtf8(
                  [
                    `Сессия: ${shortSessionId(input.session_id)}`,
                    "",
                    "MiniMax предложил ещё один шаг, но лимит автоматических продолжений для текущей задачи исчерпан.",
                    "",
                    "Предложенный следующий шаг:",
                    decision.nextGoal,
                  ].join("\n"),
                  MAX_CHOICE_CONTEXT_BYTES,
                ),
                severity: "medium",
                dedupKey: `agent-herder:continuation-limit:${input.session_id}:${input.turn_id}`,
                correlationId: `${input.session_id}/${input.turn_id}`,
                ...notification,
              }),
            );
            options.receiptStore.set(receiptKey, { kind: "human" });
            return {};
          }
          continuationCounts.set(budgetKey, currentCount + 1);
          options.receiptStore.set(receiptKey, { kind: decision.kind });
          return {
            decision: "block",
            reason: bounded(decision.nextGoal, MAX_REASON_LENGTH),
          };
        }

        if (decision.kind === "choice") {
          if (!options.choiceRegistry) throw new Error("Choice registry is required for choice decisions");
          const persistedPolicy = options.effectivePolicy?.source === "persisted"
            ? options.effectivePolicy.policy
            : undefined;
          const includeContext = persistedPolicy?.card;
          const lastUserMessage = !includeContext || includeContext.includeUserMessage
            ? input.last_user_message === undefined
              ? await readLastUserMessage(input.transcript_path)
              : sanitizeChoiceContext(input.last_user_message) ?? null
            : null;
          const timeoutEnabled = persistedPolicy?.timeout.mode === "auto_continue";
          const timeoutChoiceId = timeoutEnabled ? decision.choices[0]?.choiceId : undefined;
          const expiresAt = timeoutEnabled && timeoutChoiceId
            ? new Date(Date.now() + persistedPolicy.timeout.delayMs).toISOString()
            : undefined;
          const pending = await options.choiceRegistry.create({
            harness: options.harness ?? "codex",
            sessionId: input.session_id,
            turnId: input.turn_id,
            cwd: input.cwd,
            choices: decision.choices,
            ...(expiresAt ? { expiresAt } : {}),
            ...(timeoutChoiceId ? { timeoutChoiceId } : {}),
            ...(options.effectivePolicy?.source === "persisted"
              ? {
                  policyRevision: options.effectivePolicy.revision,
                  maxContinuationsPerSession: options.effectivePolicy.policy.maxContinuationsPerSession,
                }
              : {}),
          });
          await options.notify.send(
            createNoticePlacePayload({
              title: `Agent Herder: выбор следующего шага по ${projectLabel(input.cwd)}`,
              body: buildChoiceNotificationBody(input, decision.choices, lastUserMessage, includeContext, options.harness ?? "codex"),
              severity: "medium",
              dedupKey: `agent-herder:choice:${pending.requestId}`,
              correlationId: `${input.session_id}/${input.turn_id}`,
              choices: decision.choices.map((choice) => ({ choice_id: choice.choiceId, label: choice.label })),
              choice_request_id: pending.requestId,
              ...notification,
            }),
          );
          options.receiptStore.set(receiptKey, { kind: decision.kind });
          options.onDecision?.(decision, { choiceRequestId: pending.requestId });
          return {};
        } else if (decision.kind === "human") {
          options.onDecision?.(decision);
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
          options.onDecision?.(decision);
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

        if (decision.kind === "done" && !decision.notify) options.onDecision?.(decision);

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

function buildChoiceNotificationBody(
  input: StopHookInput,
  choices: AutopilotChoice[],
  lastUserMessage: string | null,
  card?: { includeUserMessage: boolean; includeAssistantMessage: boolean; includeReason: boolean },
  harness: "codex" | "opencode" | "claude" | "hermes" | "zcode" = "codex",
): string {
  const options = choices
    .map((choice, index) => `${index + 1}. ${choice.label}`)
    .join("\n");
  const includeUserMessage = card?.includeUserMessage ?? true;
  const includeAssistantMessage = card?.includeAssistantMessage ?? true;
  const includeReason = card?.includeReason ?? true;
  const sections = [
    `Проект: ${projectLabel(input.cwd)}`,
    `Сессия: ${shortSessionId(input.session_id)}`,
  ];
  if (includeUserMessage) {
    sections.push(
      "",
      "Последний запрос пользователя:",
      lastUserMessage === null ? "(последний запрос пользователя недоступен)" : lastUserMessage,
    );
  }
  if (includeAssistantMessage) {
    const lastMessage = input.last_assistant_message === null
      ? "(последнее сообщение агента недоступно)"
      : boundedUtf8(
          redactSecrets(input.last_assistant_message).trim(),
          MAX_CHOICE_LAST_MESSAGE_BYTES,
        ) || "(последнее сообщение агента пустое)";
    sections.push("", "Последний ответ агента:", lastMessage);
  }
  if (includeReason) {
    sections.push("", "MiniMax не выбрал автоматически: безопасных вариантов несколько.");
  }
  const harnessLabel = harness === "opencode" ? "OpenCode" : harness === "claude" ? "Claude Code" : harness === "hermes" ? "Hermes" : harness === "zcode" ? "ZCode" : "Codex";
  sections.push(
    "",
    `Следующий шаг относится именно к этой ${harnessLabel}-сессии:`,
    options,
    "",
    `После выбора продолжится эта же ${harnessLabel}-сессия.`,
  );

  return boundedUtf8(
    sections.join("\n"),
    MAX_CHOICE_CONTEXT_BYTES,
  );
}

async function readLastUserMessage(transcriptPath: string | null): Promise<string | null> {
  if (!transcriptPath) return null;
  const transcript = await readTail(transcriptPath, MAX_CHOICE_TRANSCRIPT_SCAN_BYTES).catch(() => "");
  let lastEventUserMessage: string | null = null;
  let lastResponseUserMessage: string | null = null;

  for (const line of transcript.split(/\r?\n/)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    const payloadRecord = payload as Record<string, unknown>;
    const payloadType = payloadRecord.type;
    const message = payloadType === "user_message"
      ? textFromTranscriptValue(payloadRecord.message)
      : payloadType === "message" && payloadRecord.role === "user"
        ? textFromTranscriptValue(payloadRecord.content)
        : "";
    if (!message.trim()) continue;
    if (payloadType === "user_message") lastEventUserMessage = message;
    else lastResponseUserMessage = message;
  }

  const lastUserMessage = lastEventUserMessage ?? lastResponseUserMessage;
  return lastUserMessage
    ? boundedUtf8(redactSecrets(lastUserMessage).trim(), MAX_CHOICE_LAST_MESSAGE_BYTES)
    : null;
}

function textFromTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromTranscriptValue).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined) return textFromTranscriptValue(record.content);
  return "";
}

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const name = normalized.split(/[\\/]/).pop()?.trim();
  return bounded(name || "проект", 80);
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
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
    last_user_message: sanitizeChoiceContext(input.last_user_message),
    last_assistant_message:
      input.last_assistant_message === null
        ? null
        : redactSecrets(input.last_assistant_message),
  };
}

function sanitizeChoiceContext(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  return boundedUtf8(redactSecrets(value).trim(), MAX_CHOICE_LAST_MESSAGE_BYTES) || null;
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
    input.last_user_message !== undefined &&
    input.last_user_message !== null &&
    typeof input.last_user_message !== "string"
  ) {
    throw new Error("last_user_message must be a string, null, or undefined");
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
  if (decision.kind === "choice" && Array.isArray(decision.choices) && decision.choices.length >= 2 && decision.choices.length <= 4) {
    return {
      kind: "choice",
      choices: decision.choices.map((choice) => {
        if (!choice || typeof choice !== "object") throw new Error("Malformed choice decision");
        const item = choice as Record<string, unknown>;
        if (typeof item.choiceId !== "string" || !CHOICE_ID_PATTERN.test(item.choiceId) || typeof item.label !== "string" || typeof item.nextGoal !== "string") throw new Error("Malformed choice decision: choiceId must match callback identifier format");
        return { choiceId: bounded(item.choiceId, 128), label: bounded(item.label, 512), nextGoal: bounded(item.nextGoal, MAX_REASON_LENGTH) };
      }),
    };
  }

  throw new Error("Malformed judge decision");
}

function countPersistedContinuations(store: ReceiptStore, sessionId: string, turnId: string): number {
  const prefix = `${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}:`;
  let count = 0;
  for (const [key, receipt] of store) {
    if (key.startsWith(prefix) && receipt.kind === "continue") count += 1;
  }
  return count;
}

function receiptKeyFor(input: StopHookInput, evidence: string): string {
  const iteration = createHash("sha256")
    .update(JSON.stringify({
      stopHookActive: input.stop_hook_active,
      lastAssistantMessage: input.last_assistant_message,
      evidence,
    }))
    .digest("hex")
    .slice(0, 24);
  return `${encodeURIComponent(input.session_id)}:${encodeURIComponent(input.turn_id)}:${iteration}`;
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

function parseJudgeJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced) as unknown;

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    }
    throw new SyntaxError("No JSON object found");
  }
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
