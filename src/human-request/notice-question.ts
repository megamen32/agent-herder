import type { NoticeIncidentBinding } from "../autopilot/notice-incident.js";
import type { HumanQuestionBinding } from "./question-binding.js";

/** The exact Notice Place human-request envelope. One request is one card. */
export interface AskHumanRequestV1 {
  schema: "ask_human.request.v1";
  request_id: string;
  project: string;
  recipient: string;
  mode: "choice" | "question";
  message: string;
  choices?: Array<{ label: string; value: string }>;
  allowed_actors?: string[];
  kind: "user";
  native_target: { harness: string; session_id: string; cwd?: string };
  incident_id?: string;
  expires_at?: string;
}

export interface NoticeQuestionConfig {
  /** `POST /v1/human-requests` endpoint of the configured Notice producer. */
  endpoint: string;
  token: string;
  project: string;
  recipient: string;
  allowedActors?: string[];
  fetchImpl?: typeof fetch;
}

/** The minimal question shape a delivery needs; a binding also satisfies it. */
export type DeliverableHumanQuestion = Omit<HumanQuestionBinding, "record" | "answer"> & { answer?: HumanQuestionBinding["answer"]; noticeIncident?: NoticeIncidentBinding };

/** Build the envelope from one question binding. A metadata-only request has none. */
export function buildAskHumanRequest(
  binding: DeliverableHumanQuestion,
  config: { project: string; recipient: string; allowedActors?: string[]; incidentId?: string; expiresAt?: string },
): AskHumanRequestV1 {
  if (binding.noticeIncident && binding.noticeIncident.project !== config.project) throw new Error("Notice question must use the original incident project");
  if (binding.kind !== "user") throw new Error("a secret request is metadata-only and has no Notice question");
  if (!binding.question) throw new Error("a metadata-only request creates no Notice question");
  const choices = binding.question.choices?.map((choice) => ({ label: choice.label, value: choice.choice_id }));
  return {
    schema: "ask_human.request.v1",
    request_id: binding.request_id,
    project: config.project,
    recipient: config.recipient,
    mode: choices && choices.length > 0 ? "choice" : "question",
    message: binding.question.message,
    ...(choices ? { choices } : {}),
    ...(config.allowedActors ? { allowed_actors: config.allowedActors } : {}),
    kind: "user",
    native_target: binding.native_target,
    ...(binding.noticeIncident ? { incident_id: binding.noticeIncident.incidentId } : config.incidentId ? { incident_id: config.incidentId } : {}),
    ...(config.expiresAt ? { expires_at: config.expiresAt } : {}),
  };
}

/**
 * Create exactly one real Notice question for a binding.
 *
 * This is the dedicated human-request intake, never a generic event: the card
 * lives in the same question row as the source session, message and choices, and
 * the answer returns through the existing Herder completion path.
 */
export async function deliverNoticeQuestion(
  binding: DeliverableHumanQuestion,
  config: NoticeQuestionConfig,
): Promise<void> {
  const envelope = buildAskHumanRequest(binding, config);
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      // The registry's canonical key, so a redelivery updates the same question.
      "idempotency-key": binding.dedup_key,
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(envelope),
  });
  if (!response.ok) throw new Error(`Notice human request rejected with HTTP ${response.status}`);
}
