import { expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

it("does not report a one-message fallback as a complete native transcript", async () => {
  const failure = JSON.stringify([{ code: "invalid_value", path: ["messages", 0, "info", "source"] }]);
  const call = vi.fn(async (_channel: string, _method: string, args: unknown[]) => {
    if ((args[0] as { messageLimit?: number }).messageLimit === 1) return { messages: [{ info: { role: "user" }, parts: [] }] };
    throw new Error(failure);
  });
  const client = { start: vi.fn(), call } as unknown as ZcodeClientLike;
  const adapter = new ZcodeAdapter({ client });
  await expect(adapter.getRawTranscript("session-1")).rejects.toMatchObject({
    code: "ZCODE_TRANSCRIPT_SOURCE_UNAVAILABLE",
    diagnostic: { native: "native_schema_rejected", persisted: "native_source_disabled" },
  });
  expect(call).toHaveBeenCalledTimes(1);
});

it("retains a safe cold-runtime diagnosis without reading an ambient store for injected clients", async () => {
  const call = vi.fn(async () => { throw Object.assign(new Error("Session runtime is not ready"), { code: "runtimeNotReady" }); });
  const adapter = new ZcodeAdapter({ client: { start: vi.fn(), call } as unknown as ZcodeClientLike });
  await expect(adapter.getRawTranscript("session-1")).rejects.toMatchObject({
    diagnostic: { native: "runtime_not_ready", persisted: "native_source_disabled" },
  });
  expect(call).toHaveBeenCalledTimes(1);
});
