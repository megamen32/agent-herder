import { describe, expect, it, vi } from "vitest";
import { createDeliveryResponseOwnerReader } from "../src/mcp/delivery-response-owner-routing.js";
import { deliveryResponseResourceUri, type DeliveryResponseResourceBinding } from "../src/mcp/delivery-response-resources.js";
import type { DeliveryResponseResult } from "../src/session-delivery-response.js";

const binding: DeliveryResponseResourceBinding = {
  hostId: "owner-88", harness: "minimax-code", sessionId: "session-1", jobId: "job-1", inputId: "input-1",
};
const result: DeliveryResponseResult = {
  jobId: binding.jobId, inputId: binding.inputId, jobRef: "herder://jobs/job-1",
  target: { hostId: binding.hostId, harness: binding.harness, sessionId: binding.sessionId },
  status: "completed", correlation: "observed_after_delivery", text: "reply", totalTextLength: 5,
  responseSha256: "a".repeat(64), baselineCoverage: "complete",
};

describe("delivery response owner routing", () => {
  it("reads remote response through the exact owner resource instead of caller-local jobs", async () => {
    const readLocal = vi.fn(async () => { throw new Error("must not read caller-local registry"); });
    const readRemote = vi.fn(async (target: string, request: DeliveryResponseResourceBinding) => ({
      contents: [{ uri: deliveryResponseResourceUri(request), mimeType: "application/json", text: JSON.stringify(result) }],
      target,
    }));
    const read = createDeliveryResponseOwnerReader({ localHostId: "caller-100", readLocal, readRemote });

    await expect(read(binding)).resolves.toEqual(result);
    expect(readRemote).toHaveBeenCalledWith("mcp:shell:owner-88:AgentHerder", binding);
    expect(readLocal).not.toHaveBeenCalled();
  });

  it("fails closed on a remote job/resource mismatch without local fallback", async () => {
    const readLocal = vi.fn(async () => result);
    const readRemote = vi.fn(async (_target: string, request: DeliveryResponseResourceBinding) => ({
      contents: [{ uri: deliveryResponseResourceUri({ ...request, jobId: "other-job" }), text: JSON.stringify(result) }],
    }));
    const read = createDeliveryResponseOwnerReader({ localHostId: "caller-100", readLocal, readRemote });

    await expect(read(binding)).rejects.toThrow(/owner_resource_mismatch/);
    expect(readLocal).not.toHaveBeenCalled();
  });

  it("uses local registry only for an exact local host binding", async () => {
    const local = { ...binding, hostId: "owner-88" };
    const readLocal = vi.fn(async () => result);
    const readRemote = vi.fn();
    const read = createDeliveryResponseOwnerReader({ localHostId: "owner-88", readLocal, readRemote });

    await expect(read(local)).resolves.toEqual(result);
    expect(readLocal).toHaveBeenCalledWith(local);
    expect(readRemote).not.toHaveBeenCalled();
  });
});
