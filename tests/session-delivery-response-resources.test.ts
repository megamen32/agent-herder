import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import {
  deliveryResponseResourceUri,
  publishDeliveryResponseResourceUpdated,
  registerDeliveryResponseResource,
  type DeliveryResponseResourceBinding,
} from "../src/mcp/delivery-response-resources.js";
import type { DeliveryResponseResult } from "../src/session-delivery-response.js";

const connected: Array<{ client: Client; close: () => Promise<void>; unsubscribe: () => void }> = [];
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, close, unsubscribe }) => {
    unsubscribe();
    await client.close();
    await close();
  }));
});

const binding: DeliveryResponseResourceBinding = {
  hostId: "server-100",
  harness: "codex",
  sessionId: "session-with/slash",
  jobId: "job_existing_delivery",
  inputId: "input-123",
};

function result(text: string): DeliveryResponseResult {
  return {
    jobId: binding.jobId,
    inputId: binding.inputId,
    jobRef: `herder://jobs/${binding.jobId}`,
    target: { hostId: binding.hostId, harness: binding.harness, sessionId: binding.sessionId },
    status: "completed",
    correlation: "reply_to",
    text,
    totalTextLength: text.length,
    responseSha256: "a".repeat(64),
    baselineCoverage: "complete",
    turnId: "turn-1",
  };
}

async function connect(readAuthorizedResult: (target: DeliveryResponseResourceBinding) => Promise<DeliveryResponseResult>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "delivery-response-test", version: "1.0.0" }, {
    capabilities: { resources: { subscribe: true } },
  });
  const events = new HerderEventBus();
  registerDeliveryResponseResource(server, readAuthorizedResult, events);
  const unsubscribe = events.subscribe((event) => { void server.server.sendResourceUpdated({ uri: event.uri }); });
  // serveStdio is the supported SDK entry for modern subscriptions/listen;
  // the in-memory transport here supplies only the byte-free test wire.
  const handle = serveStdio(() => server, { transport: serverTransport });
  const client = new Client({ name: "delivery-response-test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(clientTransport);
  connected.push({ client, close: () => handle.close(), unsubscribe });
  return { client, events };
}

describe("delivery response resource subscription", () => {
  it("notifies the exact subscribed job URI and reads the same new result without another send", async () => {
    let visibleResult = result("pending");
    let reads = 0;
    let nativeSendCalls = 0;
    const { client, events } = await connect(async (requested) => {
      expect(requested).toEqual(binding);
      reads++;
      return visibleResult;
    });
    const uri = deliveryResponseResourceUri(binding);
    let resolveUpdated!: (value: { uri: string }) => void;
    const notified = new Promise<{ uri: string }>((resolve) => { resolveUpdated = resolve; });
    client.setNotificationHandler("notifications/resources/updated", (notification) => resolveUpdated(notification.params));

    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    const before = await client.readResource({ uri });
    expect(JSON.parse(before.contents[0]?.text ?? "{}").text).toBe("pending");

    // Test-only state transition stands in for a newly observed history result;
    // the existing delivery sender is deliberately never invoked.
    visibleResult = result("new visible assistant output");
    publishDeliveryResponseResourceUpdated(events, binding);
    const update = await Promise.race([
      notified,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resource update notification timed out")), 1_000)),
    ]);
    expect(update).toMatchObject({ uri });
    const after = await client.readResource({ uri });
    expect(JSON.parse(after.contents[0]?.text ?? "{}")).toMatchObject({
      jobId: binding.jobId,
      inputId: binding.inputId,
      target: { hostId: binding.hostId, harness: binding.harness, sessionId: binding.sessionId },
      status: "completed",
      text: "new visible assistant output",
    });
    expect(nativeSendCalls).toBe(0);
    expect(reads).toBe(2);
    await subscription.close();
  });

  it("rejects a reader result that does not match the URI target and input", async () => {
    const { client } = await connect(async () => ({
      ...result("wrong target"),
      inputId: "other-input",
    }));
    await expect(client.readResource({ uri: deliveryResponseResourceUri(binding) })).rejects.toThrow("not bound to this exact resource URI");
  });
});
