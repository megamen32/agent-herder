import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import type { HarnessAdapter } from "../src/types/index.js";

describe("protected HumanRequest native receipt readback", () => {
  it("recovers only one exact native input, never sends again or guesses from text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-exact-native-"));
    const server = new McpServer({ name: "native-receipt-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-receipt-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    try {
      const registry = new HumanRequestRegistry(join(dir, "questions.json"));
      const record = await registry.create({
        kind: "user", target: { agent: "opencode", sessionId: "ses_exact_test", cwd: dir },
      });
      const send = vi.fn(async (request: { target: object; result_ref: string; idempotency_key?: string }) => ({
        status: "accepted" as const, target: request.target, result_ref: request.result_ref,
        receipt_ref: "resume-exact", idempotency_key: request.idempotency_key,
      }));
      let observations: Array<{ id: string; role: string; inputId?: string; parts: [] }> = [];
      const messages = vi.fn(async (id: string) => {
        expect(id).toBe("ses_exact_test");
        return observations;
      });
      const adapter = { getSessionMessages: messages } as unknown as HarnessAdapter;
      registerHumanRequestTools(server, registry, {
        humanResume: send,
        queryReceipt: async (request) => ({
          status: "accepted", target: request.target,
          result_ref: request.result_ref, receipt_ref: "resume-exact",
          idempotency_key: request.idempotency_key,
          input_id: null, native_input_message_id: null,
        }),
        adapters: new Map([["opencode", adapter]]),
      });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const resolved = await client.callTool({
        name: "human_request_resolve",
        arguments: { requestId: record.requestId, resolutionRef: "provider://answer-1" },
      });
      expect(resolved.isError).not.toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      const admitted = (await registry.get(record.requestId))!;
      expect(admitted.status).toBe("resumed");
      const expectedInput = "herder-resume-" + createHash("sha256").update(admitted.idempotencyKey!).digest("hex").slice(0, 32);
      const query = () => client.callTool({ name: "human_request_get", arguments: { requestId: record.requestId } });
      const missing = await query();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(missing.structuredContent).toMatchObject({
        resumeReceipt: { status: "accepted", input_id: null, native_input_message_id: null },
      });
      observations = [{ id: "msg_other", role: "user", inputId: "unrelated", parts: [] }];
      expect((await query()).structuredContent).toMatchObject({
        resumeReceipt: { native_input_message_id: null },
      });
      observations = [
        { id: "msg_nativeexact", role: "user", inputId: expectedInput, parts: [] },
        { id: "msg_other", role: "user", inputId: "unrelated", parts: [] },
      ];
      expect((await query()).structuredContent).toMatchObject({
        resumeReceipt: {
          status: "accepted", input_id: expectedInput,
          native_input_message_id: "msg_nativeexact",
        },
      });
      observations.push({ id: "msg_duplicate", role: "user", inputId: expectedInput, parts: [] });
      expect((await query()).structuredContent).toMatchObject({
        resumeReceipt: { native_input_message_id: null },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledTimes(4);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
