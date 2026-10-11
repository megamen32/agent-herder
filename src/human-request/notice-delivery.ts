import type { CreateHumanRequestInput, HumanRequestRecord, HumanRequestRegistry } from "./registry.js";

/** One question the human is asked, bound to an exact native session. */
export interface AskHumanInput {
  kind: "user" | "secret";
  /** The exact existing native session. Agent Herder never discovers a target. */
  target: CreateHumanRequestInput["target"];
  /** The human-readable question shown on the card. */
  message: string;
  /** Optional buttons; the answer resumes the same bound session. */
  choices?: ReadonlyArray<{ choiceId: string; label: string }>;
  contextRef?: string;
  /** Explicit Notice routing. Required: a question nobody receives is not a question. */
  notify: {
    project: string;
    recipient: string;
    kind: string;
    severity: string;
    title: string;
  };
}

export interface HumanQuestionDelivery {
  /** The existing NoticePlace producer port. */
  send(payload: {
    schema: "notify.event.v1";
    project: string;
    recipient: string;
    kind: string;
    severity: string;
    title: string;
    body: string;
    dedup_key: string;
    idempotency_key: string;
    correlation_id: string;
    human_request_id: string;
    event_type: string;
    choices?: Array<{ choice_id: string; label: string }>;
  }): Promise<void>;
}

const MAX_QUESTION_BYTES = 4 * 1024;
const MAX_TITLE_LENGTH = 512;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Create one resumable question and actually deliver its card.
 *
 * The registry stores routing metadata only, so creating a record is not the
 * same as asking a human. This seam does both against the existing NoticePlace
 * producer: the record is durable first, the card is delivered under the
 * registry's canonical dedup key, and a delivery failure is reported instead of
 * leaving a question that can never be answered.
 */
export async function askHuman(
  registry: Pick<HumanRequestRegistry, "create">,
  delivery: HumanQuestionDelivery,
  input: AskHumanInput,
): Promise<HumanRequestRecord> {
  const message = validateMessage(input.message);
  const title = validateTitle(input.notify.title);
  const choices = validateChoices(input.choices);
  const request = await registry.create({
    kind: input.kind,
    target: input.target,
    ...(input.contextRef ? { contextRef: input.contextRef } : {}),
    notify: { ...input.notify, title },
  });
  // The registry owns the canonical incident key; the card uses the same one so
  // a redelivery updates the same card instead of creating a second question.
  const dedupKey = request.notify?.dedupKey ?? `human-request:${request.requestId}`;
  await delivery.send({
    schema: "notify.event.v1",
    project: request.notify?.project ?? input.notify.project,
    recipient: request.notify?.recipient ?? input.notify.recipient,
    kind: request.notify?.kind ?? input.notify.kind,
    severity: request.notify?.severity ?? input.notify.severity,
    title,
    body: message,
    dedup_key: dedupKey,
    idempotency_key: dedupKey,
    correlation_id: `${input.target.sessionId}/${request.requestId}`,
    human_request_id: request.requestId,
    event_type: input.kind === "secret" ? "ask.secret.requested" : "ask.user.requested",
    ...(choices ? { choices } : {}),
  });
  return request;
}

function validateMessage(message: unknown): string {
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("message is required");
  const bounded = message.trim();
  if (Buffer.byteLength(bounded, "utf8") > MAX_QUESTION_BYTES) throw new Error("message must be at most 4096 bytes");
  return bounded;
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new Error("notify.title must be a nonempty string of at most 512 characters");
  }
  return title.trim();
}

function validateChoices(choices: AskHumanInput["choices"]): Array<{ choice_id: string; label: string }> | undefined {
  if (choices === undefined) return undefined;
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