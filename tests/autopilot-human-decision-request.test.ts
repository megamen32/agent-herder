import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAutopilotCore, loadReceiptStore, persistReceiptStore, type AutopilotDecision, type StopHookInput } from "../src/autopilot/index.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";

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
  it("binds one resumable Human Request to the exact session and puts it on the card", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-human-request-"));
    try {
      const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
      const judge = { decide: vi.fn(async () => humanDecision) };
      const sink = { send: vi.fn(async () => { if (sink.send.mock.calls.length === 1) throw new Error("offline"); }) };
      const receipts = new Map();
      const core = () => createAutopilotCore({
        judge, notify: sink, allowSessions: new Set([baseInput.session_id]), receiptStore: receipts,
        maxContinuationsPerSession: 3, humanRequests, harness: "opencode",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      });

      await core().handleStop(baseInput);

      const [created] = await humanRequests.list();
      expect(created).toMatchObject({
        kind: "user", status: "pending", continuation: "resume",
        target: { agent: "opencode", sessionId: baseInput.session_id, cwd: baseInput.cwd },
        notify: { project: "agent-herder", recipient: "me", kind: "notification", severity: "high", title: humanDecision.title },
      });
      expect(created?.contextRef).toContain(baseInput.session_id);
      const humanRequestId = created!.requestId;
      expect(sink.send.mock.calls[0]?.[0]).toMatchObject({ human_request_id: humanRequestId, dedup_key: `agent-herder:human:${baseInput.session_id}:${baseInput.turn_id}` });

      // A retry after a delivery outage reuses the same request and the same card.
      const path = join(root, "receipts.json");
      await persistReceiptStore(path, receipts);
      const reloaded = await loadReceiptStore(path);
      await createAutopilotCore({
        judge, notify: sink, allowSessions: new Set([baseInput.session_id]), receiptStore: reloaded,
        maxContinuationsPerSession: 3, humanRequests, harness: "opencode",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      }).handleStop({ ...baseInput, last_assistant_message: "Другой предпросмотр" });

      expect(judge.decide).toHaveBeenCalledTimes(1);
      expect(sink.send.mock.calls[1]).toEqual(sink.send.mock.calls[0]);
      expect(await humanRequests.list()).toHaveLength(1);
      expect(reloaded.get([...reloaded.keys()][0]!)).toMatchObject({ kind: "human", humanRequestId });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a locator-less Hermes decision as a notification instead of an unresumable question", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-human-hermes-"));
    try {
      const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
      const sink = { send: vi.fn(async () => { }) };
      await createAutopilotCore({
        judge: { decide: vi.fn(async () => humanDecision) }, notify: sink, allowSessions: new Set([baseInput.session_id]),
        receiptStore: new Map(), maxContinuationsPerSession: 3, humanRequests, harness: "hermes",
        notification: { project: "agent-herder", recipient: "me", kind: "notification" },
      }).handleStop(baseInput);

      expect(await humanRequests.list()).toHaveLength(0);
      expect(sink.send.mock.calls[0]?.[0]).not.toMatchObject({ human_request_id: expect.any(String) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});