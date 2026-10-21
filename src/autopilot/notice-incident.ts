import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingHumanQuestion } from "./index.js";
import { deliverNoticeQuestion } from "../human-request/notice-question.js";
import { boundedHealthText, HEALTH_ERROR_DETAIL_LIMIT } from "../automation/noticeplace-health-text.js";

/** The center's health plans; the contract accepts no other plan id. */
export const HEALTH_PLAN_IDS = ["observe", "repair", "verify"] as const;
export type HealthPlanId = (typeof HEALTH_PLAN_IDS)[number];

/** True only for a plan the center can accept as a progress plan. */
export function isHealthPlanId(value: unknown): value is HealthPlanId {
  return typeof value === "string" && (HEALTH_PLAN_IDS as readonly string[]).includes(value);
}

/** Parse and validate one plan id; never falls back to a default plan. */
export function parseHealthPlanId(value: unknown, field = "plan_id"): HealthPlanId {
  if (!isHealthPlanId(value)) throw new Error(`${field} must be one of ${HEALTH_PLAN_IDS.join(", ")}`);
  return value;
}

/** Explicit original Notice identity; no token or guessed text-based binding. */
export type NoticeIncidentBinding = { incidentId: string; project: string; planId?: HealthPlanId };
export type IncidentProgressUpdate = {
  binding: NoticeIncidentBinding;
  /** The selected health plan this progress belongs to. */
  planId?: HealthPlanId;
  idempotencyKey: string;
  step: string;
  evidenceRefs: string[];
  fingerprint: string;
};
export type IncidentUpdateSink = { send(update: IncidentProgressUpdate): Promise<void> };

export function parseNoticeIncident(value: unknown): NoticeIncidentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("noticeIncident must name the original incident and project");
  const input = value as Record<string, unknown>;
  for (const key of ["incidentId", "project"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 128 || /[\r\n\0]/.test(input[key])) throw new Error(`noticeIncident.${key} is invalid`);
  }
  const planId = input.planId === undefined ? undefined : parseHealthPlanId(input.planId, "noticeIncident.planId");
  return {
    incidentId: (input.incidentId as string).trim(),
    project: (input.project as string).trim(),
    ...(planId ? { planId } : {}),
  };
}

/** Same protected, project-scoped callback contract as Notice's health helper. */
export async function loadIncidentCallback(project: string, env: NodeJS.ProcessEnv = process.env) {
  const path = env.GPTADMIN_HEALTH_CALLBACK_FILE || join(homedir(), ".config/gptadmin/health-callback.json");
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.()) throw new Error("health callback file must be user-owned with mode 0600");
  const document = JSON.parse(await readFile(path, "utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("health callback file is invalid");
  const map = document.tokens;
  if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some((value) => typeof value !== "string"))) throw new Error("health callback project token map is invalid");
  const token = (map !== undefined ? map[project] : document.token);
  if (typeof token !== "string" || !token.trim()) throw new Error("health callback original project token is not configured");
  const url = new URL(document.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("health callback endpoint must be authenticated loopback HTTP");
  return { url: url.href.replace(/\/$/, ""), token: token.trim() };
}

/**
 * Why an incident binding could not be confirmed at the center.
 *
 * A definite rejection (the incident does not exist, belongs to another
 * project, or is already closed) must stop the observation. An unreachable
 * center proves nothing, so it must not silence a live card.
 */
export class NoticeIncidentBindingError extends Error {
  constructor(message: string, readonly kind: "rejected" | "unreachable") {
    super(message);
    this.name = "NoticeIncidentBindingError";
  }
}

/**
 * Read one incident back from the center.
 *
 * The binding of a session to an incident is a caller-supplied pair, so it is
 * verified against the center before anything is published into that incident:
 * the incident must exist, must belong to the stated project and must still be
 * open. The read is project-scoped and never resolves anything.
 */
export async function readIncidentBinding(
  binding: NoticeIncidentBinding,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; project: string; state: string }> {
  const callback = await loadIncidentCallback(binding.project, env);
  let response: Response;
  try {
    response = await fetchImpl(`${callback.url}/v1/incidents/${encodeURIComponent(binding.incidentId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${callback.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} could not be read: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
  }
  if (!response.ok) throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} was rejected with HTTP ${response.status}`, "rejected");
  const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} returned no incident document`, "rejected");
  const id = String(payload.id ?? "");
  const project = String(payload.project ?? "");
  const state = String(payload.state ?? "");
  if (id !== binding.incidentId) throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} does not exist`, "rejected");
  if (project !== binding.project) throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} belongs to another project`, "rejected");
  if (!OPEN_INCIDENT_STATES.includes(state)) throw new NoticeIncidentBindingError(`Notice incident ${binding.incidentId} is not open (state ${state || "unknown"})`, "rejected");
  return { id, project, state };
}

/** The center's open incident states; anything else is closed for progress. */
const OPEN_INCIDENT_STATES = ["open", "acknowledged", "snoozed"];

export function createIncidentUpdateSink(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): IncidentUpdateSink {
  return {
    async send(update) {
      // The center accepts progress only for the selected plan of the
      // incident. A progress without a known plan is refused here instead of
      // being sent with a guessed one.
      const planId = update.planId ?? update.binding.planId;
      if (!isHealthPlanId(planId)) throw new Error(`Notice incident progress needs the selected health plan (${HEALTH_PLAN_IDS.join(", ")})`);
      const callback = await loadIncidentCallback(update.binding.project, env);
      const response = await fetchImpl(`${callback.url}/v1/incidents/${encodeURIComponent(update.binding.incidentId)}/health/progress`, {
        method: "POST", headers: { authorization: `Bearer ${callback.token}`, "content-type": "application/json", "idempotency-key": update.idempotencyKey },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ plan_id: planId, step: update.step, evidence_refs: update.evidenceRefs, progress_fingerprint: update.fingerprint, actor: "agent-herder" }),
      });
      if (!response.ok) throw new Error(`Notice incident progress rejected with HTTP ${response.status}${await readRejectionDetail(response)}`);
    },
  };
}

/**
 * The center's own reason for a refusal.
 *
 * The response body carries the contract error ("unknown health plan",
 * "health progress requires the selected plan"), which is the only way to
 * triage a refusal. The body may echo a token, so it is redacted and bounded
 * before it reaches a log line.
 */
async function readRejectionDetail(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "";
  }
  if (!body.trim()) return "";
  let reason = body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error ?? parsed.message ?? parsed.detail;
    if (typeof error === "string" && error.trim()) reason = error;
  } catch {
    // A non-JSON body is still a reason; it is redacted below.
  }
  const detail = boundedHealthText(reason, HEALTH_ERROR_DETAIL_LIMIT);
  return detail ? `: ${detail}` : "";
}

/** Bound questions use the original incident's scope, never the Hermes producer. */
export async function deliverIncidentQuestion(question: PendingHumanQuestion, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!question.noticeIncident) throw new Error("question has no original Notice incident");
  const callback = await loadIncidentCallback(question.noticeIncident.project, env);
  await deliverNoticeQuestion(question, { endpoint: `${callback.url}/v1/human-requests`, token: callback.token, project: question.noticeIncident.project, recipient: "me", fetchImpl });
}
