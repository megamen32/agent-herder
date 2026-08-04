import { describe, expect, it } from "vitest";
import { AgentResumeClient, type ResumeTransportRequest } from "../src/resume-transport.js";

const request: ResumeTransportRequest = {
  target: { agent: "codex", session_id: "thread-7", cwd: "/workspace/app", model: "o4-mini" },
  result_ref: "sss://result/opaque-7",
};

describe("AgentResumeClient", () => {
  it("forwards the frozen selected target and opaque result ref, then accepts only a matching receipt", async () => {
    let observed: ResumeTransportRequest | undefined;
    const client = new AgentResumeClient({ invoke: async (value) => {
      observed = value;
      return { status: "accepted", target: value.target, result_ref: value.result_ref, receipt_ref: "agent-resume://receipt/7" };
    } });

    const receipt = await client.resume(request);
    expect(receipt).toEqual({ status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/7" });
    expect(observed).toEqual(request);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.target)).toBe(true);
  });

  it("classifies unavailable invocation and unsupported output as receipt failures", async () => {
    const unavailable = new AgentResumeClient({ invoke: async () => { throw new Error("entrypoint missing"); } });
    await expect(unavailable.resume(request)).resolves.toMatchObject({ status: "failed", reason: "unavailable", result_ref: request.result_ref });

    const unsupported = new AgentResumeClient({ invoke: async () => "human text, not a receipt" });
    await expect(unsupported.resume(request)).resolves.toMatchObject({ status: "failed", reason: "unsupported", result_ref: request.result_ref });
  });

  it("does not accept a receipt for a different target", async () => {
    const client = new AgentResumeClient({ invoke: async () => ({ status: "accepted", target: { ...request.target, session_id: "other" }, result_ref: request.result_ref }) });
    await expect(client.resume(request)).resolves.toMatchObject({ status: "failed", reason: "unsupported" });
  });

  it.each(["codex", "opencode", "claude"] as const)("preserves the immutable %s target", async (agent) => {
    const target = { agent, session_id: `${agent}-session`, cwd: "/workspace/app" };
    const client = new AgentResumeClient({ invoke: async (value) => ({ status: "accepted", target: value.target, result_ref: value.result_ref, receipt_ref: `receipt:${agent}` }) });
    await expect(client.resume({ target, result_ref: "result://opaque" })).resolves.toMatchObject({ status: "accepted", target, result_ref: "result://opaque" });
  });

  it("never falls back to a direct harness adapter when agent-resume reports unsupported", async () => {
    const calls: string[] = [];
    const client = new AgentResumeClient({ invoke: async () => { calls.push("agent-resume"); return { status: "failed", reason: "unsupported" }; } });
    await expect(client.resume(request)).resolves.toMatchObject({ status: "failed", reason: "unsupported" });
    expect(calls).toEqual(["agent-resume"]);
  });
});
