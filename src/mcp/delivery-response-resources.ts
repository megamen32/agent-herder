import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { HerderEventBus } from "../herder-events.js";
import { decodeResourceComponent } from "../herder-resource-uris.js";
import type { DeliveryResponseResult, DeliveryResponseTarget } from "../session-delivery-response.js";

export type DeliveryResponseResourceBinding = DeliveryResponseTarget & {
  jobId: string;
  inputId: string;
};

export function deliveryResponseResourceUri(binding: DeliveryResponseResourceBinding): string {
  return `herder://delivery-responses/${encodeURIComponent(binding.hostId)}/${encodeURIComponent(binding.harness)}/${encodeURIComponent(binding.sessionId)}/${encodeURIComponent(binding.jobId)}/${encodeURIComponent(binding.inputId)}`;
}

/** Publish only the URI a caller subscribed to; payload remains in the same delivery job. */
export function publishDeliveryResponseResourceUpdated(events: HerderEventBus, binding: DeliveryResponseResourceBinding): void {
  events.publish({
    kind: "jobs",
    uri: deliveryResponseResourceUri(binding),
    action: "changed",
    source: "delivery-response",
  });
}

/**
 * Register a job-bound result resource. The reader is the authorization seam:
 * it must resolve the exact job/baseline and enforce the caller's existing
 * principal and target binding before returning any visible output.
 */
export function registerDeliveryResponseResource(
  server: McpServer,
  readAuthorizedResult: (binding: DeliveryResponseResourceBinding) => Promise<DeliveryResponseResult>,
  events?: HerderEventBus,
): void {
  server.registerResource(
    "delivery-response",
    new ResourceTemplate("herder://delivery-responses/{hostId}/{harness}/{sessionId}/{jobId}/{inputId}", { list: undefined }),
    { title: "Visible response to an existing delivery", mimeType: "application/json" },
    async (uri, variables) => {
      const binding: DeliveryResponseResourceBinding = {
        hostId: decodeResourceComponent(variables.hostId),
        harness: decodeResourceComponent(variables.harness) as DeliveryResponseTarget["harness"],
        sessionId: decodeResourceComponent(variables.sessionId),
        jobId: decodeResourceComponent(variables.jobId),
        inputId: decodeResourceComponent(variables.inputId),
      };
      if (Object.values(binding).some((value) => !value)) throw new Error("Invalid delivery response resource binding");
      if (uri.href !== deliveryResponseResourceUri(binding)) throw new Error("Non-canonical delivery response resource URI");

      const result = await readAuthorizedResult(binding);
      if (result.jobId !== binding.jobId || result.inputId !== binding.inputId
        || result.target.hostId !== binding.hostId || result.target.harness !== binding.harness
        || result.target.sessionId !== binding.sessionId || result.jobRef !== `herder://jobs/${encodeURIComponent(binding.jobId)}`) {
        throw new Error("Delivery response result is not bound to this exact resource URI");
      }
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(result),
          mimeType: "application/json",
          ...(events ? { _meta: {
            "herder/revision": events.revision(uri.href),
            "herder/sequence": events.latestSequence(),
          } } : {}),
        }],
      };
    },
  );
}
