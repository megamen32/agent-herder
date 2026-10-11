import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingHumanQuestion } from "./index.js";
import { deliverNoticeQuestion } from "../human-request/notice-question.js";

/** Explicit original Notice identity; no token or guessed text-based binding. */
export type NoticeIncidentBinding = { incidentId: string; project: string };
export type IncidentProgressUpdate = {
  binding: NoticeIncidentBinding;
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
  return { incidentId: (input.incidentId as string).trim(), project: (input.project as string).trim() };
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

export function createIncidentUpdateSink(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): IncidentUpdateSink {
  return {
    async send(update) {
      const callback = await loadIncidentCallback(update.binding.project, env);
      const response = await fetchImpl(`${callback.url}/v1/incidents/${encodeURIComponent(update.binding.incidentId)}/health/progress`, {
        method: "POST", headers: { authorization: `Bearer ${callback.token}`, "content-type": "application/json", "idempotency-key": update.idempotencyKey },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ plan_id: "repair", step: update.step, evidence_refs: update.evidenceRefs, progress_fingerprint: update.fingerprint, actor: "agent-herder" }),
      });
      if (!response.ok) throw new Error(`Notice incident progress rejected with HTTP ${response.status}`);
    },
  };
}

/** Bound questions use the original incident's scope, never the Hermes producer. */
export async function deliverIncidentQuestion(question: PendingHumanQuestion, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!question.noticeIncident) throw new Error("question has no original Notice incident");
  const callback = await loadIncidentCallback(question.noticeIncident.project, env);
  await deliverNoticeQuestion(question, { endpoint: `${callback.url}/v1/human-requests`, token: callback.token, project: question.noticeIncident.project, recipient: "me", fetchImpl });
}
