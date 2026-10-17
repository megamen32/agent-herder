import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import {
  HermesWakeClient,
  hermesTokenMatches,
  hermesWakeClientFromEnv,
  resolveHermesLocator,
  validateHermesResultRef,
} from "../src/hermes/wake.js";

// Focused integration: the Hermes binding over a real loopback HTTP receiver.
// Expected <1s/max 15s. No Hermes gateway: the fixture stands in for it.
const locator = {
  schema: "hermes.locator.v2",
  session_key: "agent:telegram:12345",
  platform: "telegram",
  chat_id: "12345",
  chat_type: "dm",
};
const resultRef = "0e2b0f1a-6f1d-4c7e-9a3b-2f9a1c4d5e6f";

async function receiver(handler: (body: Record<string, unknown>) => { status: number; value: unknown }): Promise<{ url: string; calls: Record<string, unknown>[]; close: () => Promise<void>; server: Server }> {
  const calls: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
      const { status, value } = handler(JSON.parse(body || "{}"));
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/wake`,
    calls,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it("validates the immutable locator without discovering anything", () => {
  expect(resolveHermesLocator(locator)).toMatchObject({ session_key: "agent:telegram:12345", chat_type: "dm" });
  expect(() => resolveHermesLocator({ ...locator, schema: "hermes.locator.v1" })).toThrow(/unsupported Hermes locator schema/);
  expect(() => resolveHermesLocator({ ...locator, chat_type: "voice" })).toThrow(/chat_type is unsupported/);
  expect(() => resolveHermesLocator({ ...locator, chat_id: "" })).toThrow(/chat_id is required/);
  expect(() => resolveHermesLocator(undefined)).toThrow(/locator is required/);
});

it("accepts only an opaque UUID as the result reference", () => {
  expect(validateHermesResultRef(resultRef)).toBe(resultRef);
  expect(() => validateHermesResultRef("hello")).toThrow(/opaque UUID/);
});

it("wakes exactly the bound session and authenticates with a bearer token", async () => {
  const seen = await receiver(() => ({
    status: 200,
    value: { receipt_id: "hermes-wake-1", receipt_ref: "hermes-wake-1", status: "accepted", target: resolveHermesLocator(locator), result_ref: resultRef },
  }));
  try {
    const client = new HermesWakeClient({ endpoint: seen.url, token: "secret-token" });
    const receipt = await client.wake(locator, resultRef);
    expect(receipt.status).toBe("accepted");
    expect(seen.calls[0]?.authorization).toBe("Bearer secret-token");
    expect(seen.calls[0]?.body).toEqual({ locator: resolveHermesLocator(locator), result_ref: resultRef });
  } finally {
    await seen.close();
  }
});

it("fails when the gateway receipt names another chat", async () => {
  const seen = await receiver(() => ({
    status: 200,
    value: { receipt_id: "hermes-wake-2", status: "accepted", target: { ...resolveHermesLocator(locator), chat_id: "99999" }, result_ref: resultRef },
  }));
  try {
    const client = new HermesWakeClient({ endpoint: seen.url, token: "t" });
    const receipt = await client.wake(locator, resultRef);
    expect(receipt.status).toBe("failed");
    expect(receipt.error).toContain("does not match the bound target");
  } finally {
    await seen.close();
  }
});

it("reports a refused wake instead of pretending it was delivered", async () => {
  const seen = await receiver(() => ({ status: 503, value: { status: "failed", reason: "adapter unavailable" } }));
  try {
    const client = new HermesWakeClient({ endpoint: seen.url, token: "t" });
    const receipt = await client.wake(locator, resultRef);
    expect(receipt).toMatchObject({ status: "failed", reason: "adapter unavailable" });
  } finally {
    await seen.close();
  }
});

it("compares the wake token in constant time and builds a client from env", () => {
  expect(hermesTokenMatches("secret", "Bearer secret")).toBe(true);
  expect(hermesTokenMatches("secret", "Bearer wrong")).toBe(false);
  expect(hermesTokenMatches("secret", "secret")).toBe(false);
  expect(hermesTokenMatches(undefined, "Bearer secret")).toBe(false);
  expect(hermesWakeClientFromEnv({})).toBeUndefined();
  expect(hermesWakeClientFromEnv({ AGENT_RESUME_HERMES_ENDPOINT: "http://127.0.0.1:1/", AGENT_RESUME_HERMES_TOKEN: "t" })).toBeInstanceOf(HermesWakeClient);
});