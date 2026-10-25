import { staleRunningQuestionBinding, type IntegratorProgressResult, type StaleRunningQuestionTarget } from "../integrator-progress.js";
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
  /** Require the exact persisted Notice question and channel receipt for permission cards. */
  requireExactTelegramReceipt?: boolean;
}

export interface NoticeQuestionDeliveryReceipt {
  requestId: string;
  httpStatus: 200 | 201;
  deliveryStatus: "sent";
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
export function deliverNoticeQuestion(
  binding: DeliverableHumanQuestion,
  config: NoticeQuestionConfig & { requireExactTelegramReceipt: true },
): Promise<NoticeQuestionDeliveryReceipt>;
export function deliverNoticeQuestion(
  binding: DeliverableHumanQuestion,
  config: NoticeQuestionConfig,
): Promise<void>;
export async function deliverNoticeQuestion(
  binding: DeliverableHumanQuestion,
  config: NoticeQuestionConfig,
): Promise<unknown> {
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
  if (!config.requireExactTelegramReceipt) return undefined;
  if (response.status !== 200 && response.status !== 201) throw new Error("Notice human request returned an unexpected success status");
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new Error("Notice human request returned no verifiable receipt"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Notice human request returned a malformed receipt");
  const receipt = raw as Record<string, unknown>;
  const target = binding.native_target;
  const channel = receipt.telegram && typeof receipt.telegram === "object" && !Array.isArray(receipt.telegram)
    ? receipt.telegram as Record<string, unknown> : undefined;
  const choices = Array.isArray(receipt.choices) ? receipt.choices as Array<Record<string, unknown>> : [];
  const exactChoices = choices.length === 2
    && choices[0]?.value === "allow" && choices[0]?.label === "Разрешить"
    && choices[1]?.value === "deny" && choices[1]?.label === "Запретить";
  const telegramSent = channel?.status === "sent" && typeof channel.chat_id === "string" && channel.chat_id.trim().length > 0
    && Number.isInteger(channel.message_id) && Number(channel.message_id) > 0;
  const validState = ["pending", "resolving", "resolved", "cancelled", "expired"].includes(String(receipt.state));
  if (receipt.schema !== "ask_human.response.v1" || receipt.request_id !== binding.request_id || !validState
    || receipt.project !== config.project || receipt.recipient !== config.recipient || receipt.kind !== "user"
    || receipt.mode !== "choice" || !exactChoices
    || receipt.native_harness !== target.harness || receipt.native_session_id !== target.session_id
    || receipt.native_cwd !== (target.cwd ?? "") || !telegramSent) {
    throw new Error("Notice human request receipt does not prove the exact bound card was sent");
  }
  return { requestId: binding.request_id, httpStatus: response.status as 200 | 201, deliveryStatus: "sent" };
}

/**
 * Ask the operator about one stale-running session.
 *
 * The stale-running fact is the only trigger: every other progress state makes
 * no network call at all. The delivery goes through the existing producer, so
 * the question lands in the same Notice scope as every other human question,
 * and the deterministic request id keeps it on one card.
 */
export async function deliverStaleRunningQuestion(
  progress: IntegratorProgressResult,
  target: StaleRunningQuestionTarget,
  config: NoticeQuestionConfig,
): Promise<boolean> {
  const binding = staleRunningQuestionBinding(progress, target);
  if (!binding) return false;
  await deliverNoticeQuestion(binding, config);
  return true;
}
