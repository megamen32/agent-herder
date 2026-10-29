import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentResumeClient, type ResumeTransportRequest } from "../src/resume-transport.js";

/**
 * A native OpenCode target must never be continued by a blind CLI fallback.
 *
 * The core derives `input_id` deterministically from the idempotency key and
 * sends it with the admitted goal, so the native message carries
 * `metadata.agentHerderInputId`. The legacy Agent Resume service cannot
 * address an OpenCode 2 session inbox, so a fallback delivers the goal blind:
 * no binding on the message and no `input_id` in the receipt. The consumer
 * could then not name the message that carried the goal.
 */

const nativeRequest: ResumeTransportRequest = {
  target: { agent: "opencode", session_id: "ses_opencode_1", cwd: "/workspace/app" },
  result_ref: "sss://result/opaque-1",
  idempotency_key: "human-request:req-1:answer-1",
};

describe("native OpenCode resume fallback", () => {
  // The core owns admission for an OpenCode target only when a native endpoint
  // is configured; without one there is nothing to fall back from.
  const previousUrl = process.env.OPENCODE_URL;
  const directories: string[] = [];

  beforeEach(async () => {
    process.env.OPENCODE_URL = "http://127.0.0.1:4095";
    directories.push(await mkdtemp(join(tmpdir(), "herder-native-fallback-")));
  });

  afterEach(async () => {
    if (previousUrl === undefined) delete process.env.OPENCODE_URL;
    else process.env.OPENCODE_URL = previousUrl;
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not silently fall back to the CLI when the native admission is refused", async () => {
    let serviceCalled = false;
    const client = new AgentResumeClient({
      invoke: async () => {
        serviceCalled = true;
        return { status: "accepted", target: nativeRequest.target, result_ref: nativeRequest.result_ref, receipt_ref: "agent-resume://receipt/1" };
      },
      coreTransport: {
        resume: async () => ({
          status: "failed",
          target: nativeRequest.target,
          result_ref: nativeRequest.result_ref,
          reason: "native_admission_refused",
        }),
      },
    });

    const receipt = await client.resume(nativeRequest);

    expect(serviceCalled).toBe(false);
    expect(receipt.status).toBe("failed");
    expect(receipt.reason).toBe("native_admission_refused");
  });

  it("reports the exact cause of the native refusal", async () => {
    const client = new AgentResumeClient({
      invoke: async () => {
        throw new Error("the legacy service must not be reached");
      },
      coreTransport: {
        resume: async () => ({
          status: "failed",
          target: nativeRequest.target,
          result_ref: nativeRequest.result_ref,
          reason: "native_admission_refused",
          detail: "HTTP 409 session is busy",
        }),
      },
    });

    const receipt = await client.resume(nativeRequest);
    expect(receipt).toMatchObject({
      status: "failed",
      reason: "native_admission_refused",
      detail: "HTTP 409 session is busy",
    });
  });

  it("keeps the native binding in the receipt when the core replays a stored native receipt", async () => {
    // The core stored a native receipt for this key. A replay of that stored
    // receipt must still name the native message that carried the goal.
    const client = new AgentResumeClient({
      coreLedgerPath: join(directories[0]!, "receipts.json"),
      coreTransport: {
        resume: async () => ({
          status: "accepted",
          target: nativeRequest.target,
          result_ref: nativeRequest.result_ref,
          receipt_ref: "agent-resume://receipt/2",
          idempotency_key: nativeRequest.idempotency_key,
          input_id: "herder-resume-0123456789abcdef0123456789abcdef",
          native_input_message_id: "msg_18595479a0010LQzLIIW76QAdT",
        }),
      },
    });

    const receipt = await client.resume(nativeRequest);
    expect(receipt).toMatchObject({
      status: "accepted",
      input_id: "herder-resume-0123456789abcdef0123456789abcdef",
      native_input_message_id: "msg_18595479a0010LQzLIIW76QAdT",
    });
  });

  it("still lets a non-OpenCode target fall back to the legacy service", async () => {
    let serviceCalled = false;
    const client = new AgentResumeClient({
      invoke: async (value) => {
        serviceCalled = true;
        return {
          status: "accepted",
          target: value.target,
          result_ref: value.result_ref,
          receipt_ref: "agent-resume://receipt/3",
          idempotency_key: value.idempotency_key,
        };
      },
      coreTransport: {
        resume: async () => ({
          status: "failed",
          target: nativeRequest.target,
          result_ref: nativeRequest.result_ref,
          reason: "native_admission_refused",
        }),
      },
    });

    const receipt = await client.resume({
      ...nativeRequest,
      target: { agent: "claude", session_id: "sess-claude-1", cwd: "/workspace/app" },
    });

    expect(serviceCalled).toBe(true);
    expect(receipt.status).toBe("accepted");
  });
});
