import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAutopilotCore, loadReceiptStore, persistReceiptStore, type AutopilotDecision, type StopHookInput } from "../src/autopilot/index.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { buildAskHumanRequest, deliverNoticeQuestion } from "../src/human-request/notice-question.js";

const baseInput: StopHookInput = {
  hook_event_name: "Stop",
  session_id: "ses_incident",
  cwd: "/workspace/incident",
  turn_id: "turn-42",
  last_assistant_message: "Нужен выбор человека: продолжить исправление или откатить.",
  transcript_path: null,
  stop_hook_active: false,
};

const humanDecision = {
  kind: "human",
  title: "Agent Herder: нужно решение человека",
  body: "Инцидент нельзя закрыть автоматически.",
  severity: "high",
} satisfies AutopilotDecision;

describe("autopilot human decision branch", () => {
  it("creates exactly one Notice human request and no generic event", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-human-request-"));
    try {
      const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
      const judge = { decide: vi.fn(async () => humanDecision) };
      const sink = { send: vi.fn(async () => { }) };
      const receipts = new Map();
      const posted: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
      const deliverHumanQuestion = async (question: Parameters<NonNullable<Parameters<typeof createAutopilotCore>[0]["deliverHumanQuestion"]>>[0]) => {
        await deliverNoticeQuestion(question, {
          endpoint: "https://notify.example/v1/human-requests",
          token: "token",
          project: "agent-herder",
          recipient: "me",
          allowedActors: ["user:roomhacker"],
          fetchImpl: (async (url: string, init: RequestInit) => {
            posted.push({
              url: String(url),
              body: JSON.parse(String(init.body)) as Record<string, unknown>,
              headers: init.headers as Record<string, string>,
            });
            return { ok: true, status: 201 } as Response;
          }) as unknown as typeof fetch,
        });
      };
      const core = () => createAutopilotCore({
        judge, notify: sink, allowSessions: new Set([baseInput.session_id]), receiptStore: receipts,
        maxContinuationsPerSession: 3, humanRequests, deliverHumanQuestion, harness: "opencode",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      });

      await core().handleStop(baseInput);

      // Exactly one real question row and no generic event card.
      expect(posted).toHaveLength(1);
      expect(posted[0]?.url).toBe("https://notify.example/v1/human-requests");
      expect(posted[0]?.headers["idempotency-key"]).toBe(`human-request:${posted[0]?.body.request_id as string}`);
      expect(posted[0]?.body).toMatchObject({
        schema: "ask_human.request.v1",
        request_id: expect.any(String),
        project: "agent-herder",
        recipient: "me",
        mode: "question",
        kind: "user",
        allowed_actors: ["user:roomhacker"],
        native_target: { harness: "opencode", session_id: baseInput.session_id, cwd: baseInput.cwd },
      });
      expect(String(posted[0]?.body.message)).toContain(humanDecision.title);
      expect(sink.send).not.toHaveBeenCalled();

      const [created] = await humanRequests.list();
      expect(created).toMatchObject({ status: "pending", answerSource: "notice_question", continuation: "resume" });
      expect(created?.requestId).toBe(posted[0]?.body.request_id);

      // A repeated Stop retries the same card without a second request.
      const path = join(root, "receipts.json");
      await persistReceiptStore(path, receipts);
      const reloaded = await loadReceiptStore(path);
      await createAutopilotCore({
        judge, notify: sink, allowSessions: new Set([baseInput.session_id]), receiptStore: reloaded,
        maxContinuationsPerSession: 3, humanRequests, deliverHumanQuestion, harness: "opencode",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      }).handleStop({ ...baseInput, last_assistant_message: "Другой предпросмотр" });

      expect(judge.decide).toHaveBeenCalledTimes(1);
      expect(posted).toHaveLength(1);
      expect(await humanRequests.list()).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a locator-less Hermes decision as a notification instead of an unresumable question", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-human-hermes-"));
    try {
      const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
      const sink = { send: vi.fn(async () => { }) };
      const posted: unknown[] = [];
      await createAutopilotCore({
        judge: { decide: vi.fn(async () => humanDecision) }, notify: sink, allowSessions: new Set([baseInput.session_id]),
        receiptStore: new Map(), maxContinuationsPerSession: 3, humanRequests, harness: "hermes",
        deliverHumanQuestion: async () => { posted.push(1); },
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      }).handleStop(baseInput);

      expect(await humanRequests.list()).toHaveLength(0);
      expect(posted).toHaveLength(0);
      expect(sink.send).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never asks a question without the Notice human-request intake", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-human-no-intake-"));
    try {
      const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
      const sink = { send: vi.fn(async () => { }) };
      await createAutopilotCore({
        judge: { decide: vi.fn(async () => humanDecision) }, notify: sink, allowSessions: new Set([baseInput.session_id]),
        receiptStore: new Map(), maxContinuationsPerSession: 3, humanRequests, harness: "opencode",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      }).handleStop(baseInput);

      // No intake means no request: the pending-question gate never closes
      // behind a question that nobody can answer.
      expect(await humanRequests.list()).toHaveLength(0);
      expect(sink.send).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
