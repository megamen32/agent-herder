import { expect, it, vi } from "vitest";
import { deliverAutopilotGoal } from "../src/autopilot/continuation-delivery.js";
import type { AutopilotRunnerInput } from "../src/autopilot-runner.js";

// Focused unit: Autopilot continuation transport per harness.
// Expected <1s/max 10s. No provider, judge or native session.
const input = (harness: string): AutopilotRunnerInput => ({
  harness: harness as AutopilotRunnerInput["harness"],
  sessionId: "ses_1",
  cwd: "/tmp/project",
  turnId: "turn-1",
});

it("delivers an OpenCode goal through the native inbox, not a CLI process", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, admitted: true }));
  const resume = vi.fn(async () => ({ status: "accepted" }));
  const result = await deliverAutopilotGoal(input("opencode"), "сделай следующий шаг", "input-1", {
    adapter: { sendMessage } as never,
    resume: resume as never,
  });
  expect(result).toMatchObject({ status: "delivered", transport: "opencode-inbox", inputId: "input-1" });
  expect(sendMessage).toHaveBeenCalledWith("ses_1", expect.objectContaining({ message: "сделай следующий шаг", queue: true, origin: "automation", inputId: "input-1" }));
  expect(resume).not.toHaveBeenCalled();
});

it("falls back to the durable transport when the native inbox refuses the goal", async () => {
  const resume = vi.fn(async () => ({ status: "accepted" }));
  const result = await deliverAutopilotGoal(input("opencode"), "goal", "input-2", {
    adapter: { sendMessage: async () => ({ ok: false, error: "HTTP 409" }) } as never,
    resume: resume as never,
  });
  expect(result.transport).toBe("agent-resume");
  expect(result.error).toContain("HTTP 409");
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: "input-2" }));
});

it("keeps CLI-only harnesses on the durable transport", async () => {
  const sendMessage = vi.fn();
  const resume = vi.fn(async () => ({ status: "accepted" }));
  const result = await deliverAutopilotGoal(input("codex"), "goal", "input-3", {
    adapter: { sendMessage } as never,
    resume: resume as never,
  });
  expect(result).toMatchObject({ status: "accepted", transport: "agent-resume" });
  expect(sendMessage).not.toHaveBeenCalled();
});

it("reports a failed continuation instead of pretending it was delivered", async () => {
  const result = await deliverAutopilotGoal(input("opencode"), "goal", "input-4", {
    adapter: { sendMessage: async () => ({ ok: true, admitted: true }) } as never,
    resume: (async () => { throw new Error("transport down"); }) as never,
  });
  expect(result.status).toBe("delivered");

  const failed = await deliverAutopilotGoal(input("codex"), "goal", "input-5", {
    resume: (async () => ({ status: "rejected", reason: "no route" })) as never,
  });
  expect(failed).toMatchObject({ status: "failed", transport: "agent-resume", error: "no route" });
});