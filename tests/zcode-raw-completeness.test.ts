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
  expect(await adapter.getRawTranscript("session-1")).toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
});
