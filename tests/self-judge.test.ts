import { describe, expect, it } from "vitest";

import { selfJudgeEvaluate } from "../src/autopilot/self-judge.js";

type JudgeInput = {
  harness: string;
  sessionId: string;
  lastAssistantMessage: string;
  messages: Array<{ role: string; text: string }>;
};

const marker = (text: unknown, kind: string): string => {
  const match = String(text).match(new RegExp("goal_" + kind + ":([a-f0-9]{8})", "i"));
  if (!match) throw new Error("missing goal_" + kind + " marker");
  return match[1];
};

describe("self-judge marker stages", () => {
  it("advances work, review, and completion markers in order", async () => {
    const input = (lastAssistantMessage: string): JudgeInput => ({
      harness: "test",
      sessionId: "self-judge-stage-test",
      lastAssistantMessage,
      messages: [{ role: "user", text: "Finish the task and verify every requirement." }],
    });

    const work = await selfJudgeEvaluate(input(""));
    const reviewUid = marker(work.next_goal, "review");
    expect(work).toMatchObject({ decision: "continue", self_judge: true });

    const review = await selfJudgeEvaluate(input("Done. goal_review:" + reviewUid));
    const completeUid = marker(review.next_goal, "complete");
    expect(review).toMatchObject({ decision: "continue", self_judge: true });
    expect(String(review.next_goal)).toContain("Проведи ревью");

    const complete = await selfJudgeEvaluate(input("Verified. goal_complete:" + completeUid));
    const closedUid = marker(complete.next_goal, "closed");
    expect(complete).toMatchObject({ decision: "continue", self_judge: true });
    expect(String(complete.next_goal)).toContain("goal_closed:");

    await expect(selfJudgeEvaluate(input("Closed. goal_closed:" + closedUid))).resolves.toMatchObject({
      decision: "terminal",
      terminalKind: "completed",
      self_judge: true,
    });
  });
});
