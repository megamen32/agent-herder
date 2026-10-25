import { unwrapResult } from "../mesh/protocol.js";
import { deliveryResponseResourceUri, type DeliveryResponseResourceBinding } from "./delivery-response-resources.js";
import type { DeliveryResponseResult } from "../session-delivery-response.js";

type ReadResponseResource = (target: string, binding: DeliveryResponseResourceBinding) => Promise<unknown>;
type ReadLocalResponse = (binding: DeliveryResponseResourceBinding) => Promise<DeliveryResponseResult>;

/** Route response reads to the owner that stores the exact durable job. */
export function createDeliveryResponseOwnerReader(input: {
  localHostId: string;
  readLocal: ReadLocalResponse;
  readRemote: ReadResponseResource;
}): ReadLocalResponse {
  return async (binding) => {
    if (binding.hostId === input.localHostId) return input.readLocal(binding);

    const target = `mcp:shell:${binding.hostId}:AgentHerder`;
    const response = unwrapResult(await input.readRemote(target, binding));
    const uri = deliveryResponseResourceUri(binding);
    if (!Array.isArray(response.contents)) throw new Error("delivery_response_owner_resource_missing");
    const matches = response.contents.filter((entry): entry is { uri: string; text: string } =>
      Boolean(entry && typeof entry === "object" && (entry as { uri?: unknown }).uri === uri
        && typeof (entry as { text?: unknown }).text === "string"));
    if (matches.length !== 1) throw new Error("delivery_response_owner_resource_mismatch");

    let result: unknown;
    try { result = JSON.parse(matches[0]!.text); }
    catch { throw new Error("delivery_response_owner_result_invalid"); }
    if (!result || typeof result !== "object") throw new Error("delivery_response_owner_result_invalid");
    const value = result as Partial<DeliveryResponseResult>;
    if (value.jobId !== binding.jobId || value.inputId !== binding.inputId || value.jobRef !== `herder://jobs/${encodeURIComponent(binding.jobId)}`
      || value.target?.hostId !== binding.hostId || value.target?.harness !== binding.harness || value.target?.sessionId !== binding.sessionId) {
      throw new Error("delivery_response_owner_result_unbound");
    }
    return value as DeliveryResponseResult;
  };
}
