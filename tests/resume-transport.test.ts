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

  it("forwards the canonical Hermes locator through the sole agent-resume entrypoint", async () => {
    const hermesRequest: ResumeTransportRequest = {
      target: {
        agent: "hermes",
        locator: { schema: "hermes.locator.v2", session_key: "agent:main:telegram:thread:chat-42:topic-7", platform: "telegram", chat_id: "chat-42", thread_id: "topic-7", chat_type: "thread" },
      },
      result_ref: "result://hermes-42",
    };
    const calls: ResumeTransportRequest[] = [];
    const client = new AgentResumeClient({ invoke: async (value) => {
      calls.push(value);
      return { status: "accepted", target: value.target, result_ref: value.result_ref, receipt_ref: "agent-resume://hermes-receipt" };
    } });

    await expect(client.resume(hermesRequest)).resolves.toEqual({
      status: "accepted", target: hermesRequest.target, result_ref: hermesRequest.result_ref, receipt_ref: "agent-resume://hermes-receipt",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(hermesRequest);
    expect(Object.isFrozen(calls[0].target.locator)).toBe(true);
  });

  it("rejects Hermes targets without a complete canonical locator", async () => {
    const client = new AgentResumeClient({ invoke: async () => ({}) });
    await expect(client.resume({ target: { agent: "hermes" } as ResumeTransportRequest["target"], result_ref: "result://missing" })).rejects.toThrow("target.locator is required");
    await expect(client.resume({ target: { agent: "hermes", locator: { schema: "hermes.locator.v2", session_key: "key", platform: "telegram", chat_id: "", chat_type: "dm" } }, result_ref: "result://missing" })).rejects.toThrow("target.locator.chat_id is required");
  });

  it("does not accept a Hermes receipt for a different locator", async () => {
    const hermesTarget: ResumeTransportRequest["target"] = {
      agent: "hermes", locator: { schema: "hermes.locator.v2", session_key: "agent:main:telegram:dm:chat-42", platform: "telegram", chat_id: "chat-42", chat_type: "dm" },
    };
    const client = new AgentResumeClient({ invoke: async (value) => ({
      status: "accepted", target: { ...value.target, locator: { ...hermesTarget.locator, chat_id: "other" } },
      result_ref: value.result_ref, receipt_ref: "receipt:wrong-locator",
    }) });
    await expect(client.resume({ target: hermesTarget, result_ref: "result://hermes" })).resolves.toMatchObject({ status: "failed", reason: "unsupported" });
  });
});
