import type { CreateHumanRequestInput, HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

/**
 * The exact native target a question is bound to.
 *
 * Notice stores it as `native_target`, so the source session, the message and
 * the choices all land in the same question row instead of a separate notice.
 */
export interface HumanQuestionNativeTarget {
  harness: string;
  session_id: string;
  cwd?: string;
  marker?: string;
}

export interface AskHumanInput {
  kind: "user" | "secret";
  /** The exact existing native session. Agent Herder never discovers a target. */
  target: CreateHumanRequestInput["target"];
  /** The human-readable question. Notice stores it on the question row. */
  message?: string;
  /** Optional buttons; the answer resumes the same bound session. */
  choices?: ReadonlyArray<{ choiceId: string; label: string }>;
  contextRef?: string;
}

/** What the caller needs to create exactly one Notice question. */
export interface HumanQuestionBinding {
  request_id: string;
  native_target: HumanQuestionNativeTarget;
  /** Herder's canonical key for this request. */
  dedup_key: string;
  /** Opaque correlation handle; never a prompt, an answer or a secret. */
  context_ref?: string;
  kind: "user" | "secret";
  /** Absent for a metadata-only request, which creates no Notice question. */
  question?: { message: string; choices?: Array<{ choice_id: string; label: string }> };
  /** The one existing answer path that resumes the bound session. */
  answer: {
    mcp_tool: "human_request_resolve";
    completion_path: string;
  };
  record: HumanRequestRecord;
}

const MAX_QUESTION_BYTES = 4 * 1024;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Create one resumable question and return everything needed to show exactly
 * one Notice question for it.
 *
 * There is no second delivery channel: this seam never sends a generic event
 * card, because Notice owns the Ask card through its own
 * `POST /v1/human-requests`. The caller posts this binding once, and the answer
 * arrives through the existing Herder answer path, which resumes the exact
 * bound session once.
 */
export async function askHuman(
  registry: Pick<HumanRequestRegistry, "create">,
  input: AskHumanInput,
): Promise<HumanQuestionBinding> {
  const message = input.message === undefined ? undefined : validateMessage(input.message);
  const choices = validateChoices(input.choices, message);
  const record = await registry.create({
    kind: input.kind,
    target: input.target,
    // Only this seam produces a Notice question row, so only this seam may point
    // a resumed session at one.
    ...(message ? { answerSource: "notice_question" as const } : {}),
    ...(input.contextRef ? { contextRef: input.contextRef } : {}),
  });
  return {
    request_id: record.requestId,
    native_target: nativeTarget(record),
    dedup_key: record.notify?.dedupKey ?? `human-request:${record.requestId}`,
    ...(record.contextRef ? { context_ref: record.contextRef } : {}),
    kind: record.kind,
    ...(message ? { question: { message, ...(choices ? { choices } : {}) } } : {}),
    answer: {
      mcp_tool: "human_request_resolve",
      completion_path: record.kind === "secret"
        ? "/internal/human-requests/sss-completion"
        : "/internal/human-requests/ask-user-completion",
    },
    record,
  };
}

/** Project the durable record onto the exact native target shape. */
export function nativeTarget(record: HumanRequestRecord): HumanQuestionNativeTarget {
  const target = record.target;
  return {
    harness: target.agent ?? target.harness ?? "",
    session_id: target.sessionId,
    ...(target.cwd ? { cwd: target.cwd } : {}),
    ...(target.marker ? { marker: target.marker } : {}),
  };
}

function validateMessage(message: unknown): string {
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("message must be a nonempty string");
  const bounded = message.trim();
  if (Buffer.byteLength(bounded, "utf8") > MAX_QUESTION_BYTES) throw new Error("message must be at most 4096 bytes");
  return bounded;
}

function validateChoices(choices: AskHumanInput["choices"], message: string | undefined): Array<{ choice_id: string; label: string }> | undefined {
  if (choices === undefined) return undefined;
  if (!message) throw new Error("choices require a message; a metadata-only request creates no Notice question");
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 4) throw new Error("2 to 4 choices are required");
  const ids = new Set<string>();
  return choices.map((choice) => {
    if (!choice || typeof choice !== "object") throw new Error("each choice must be an object");
    if (typeof choice.choiceId !== "string" || !CHOICE_ID_PATTERN.test(choice.choiceId)) throw new Error("choiceId must match the callback identifier format");
    if (typeof choice.label !== "string" || choice.label.trim().length === 0 || choice.label.length > 512) {
      throw new Error("choice label must be a nonempty string of at most 512 characters");
    }
    if (ids.has(choice.choiceId)) throw new Error("choice ids must be unique");
    ids.add(choice.choiceId);
    return { choice_id: choice.choiceId, label: choice.label.trim() };
  });
}