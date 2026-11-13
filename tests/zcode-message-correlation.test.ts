import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import { serveZcodeAhap } from "../src/ahap-zcode-runner.js";

function reader(messages: unknown[]) {
  const adapter = Object.create(ZcodeAdapter.prototype) as ZcodeAdapter;
  const call = vi.fn(async (method: string) => {
    expect(method).toBe("readSessionMessages");
    return { messages };
  });
  Object.assign(adapter, {
    persistedSessionIds: new Set(), sessionWorkspaces: new Map([["requested-session", { workspacePath: "/isolated" }]]),
    callAgent: call, readLocalSessionMessages: vi.fn(async () => null),
    resumeSession: vi.fn(() => { throw new Error("read projection must never resume"); }),
  });
  return { adapter, call };
}

async function wire(adapter: ZcodeAdapter) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const done = serveZcodeAhap(adapter, input, output);
  input.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "zcode", ahapVersion: "0.1" } },
    { jsonrpc: "2.0", id: 2, method: "getSessionMessages", params: { id: "requested-session", limit: 20 } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  await done;
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("ZCode exact native message correlation", () => {
  it("preserves observed command and input anchors across the AHAP read wire", async () => {
    const sourceCommandId = "queue_agent-herder:auto:original-request-key";
    const { adapter, call } = reader([{
      info: { role: "user", messageId: "real-native-message", sessionId: "requested-session",
        anchor: { sourceCommandId }, metadata: { inputId: "native-input-42" }, time: { created: 1 } },
      parts: [{ type: "text", text: "observed native message" }],
    }]);
    const replies = await wire(adapter);
    expect(replies[1].result[0]).toMatchObject({
      id: "real-native-message", nativeMessageId: "real-native-message", sourceCommandId,
      inputId: "native-input-42", sessionId: "requested-session", role: "user",
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("readSessionMessages", {
      workspacePath: "/isolated", sessionId: "requested-session", limit: 20,
    });
    expect(adapter.resumeSession).not.toHaveBeenCalled();
  });

  it("never promotes a synthetic display id, text or turn id into native receipt evidence", async () => {
    const { adapter } = reader([{
      info: { role: "user", turnId: "original-request-key", metadata: { sourceCommandId: "unanchored-request" } },
      parts: [{ type: "text", text: "same original-request-key as a previous prompt" }],
    }]);
    const [message] = (await adapter.getSessionMessages("requested-session"))!;
    expect(message.id).toBe("zcode-message-1");
    expect(message.nativeMessageId).toBeUndefined();
    expect(message.sourceCommandId).toBeUndefined();
    expect(message.inputId).toBeUndefined();
    expect(message.sessionId).toBeUndefined();
  });

  it("preserves original bytes and a conflicting native session for the caller to reject", async () => {
    const { adapter } = reader([{
      info: { role: "user", messageId: "observed-message", sessionId: "different-native-session",
        anchor: { sourceCommandId: "  exact-native-anchor  " }, metadata: { inputId: "raw-native-input" } },
      parts: [],
    }]);
    const [message] = (await adapter.getSessionMessages("requested-session"))!;
    expect(message.sourceCommandId).toBe("  exact-native-anchor  ");
    expect(message.sessionId).toBe("different-native-session");
    expect(message.inputId).toBe("raw-native-input");
  });

  it("does not invent a command correlation for an ordinary native message", async () => {
    const { adapter } = reader([{ info: { role: "user", messageId: "real-id" }, parts: [] }]);
    const [message] = (await adapter.getSessionMessages("requested-session"))!;
    expect(message).toMatchObject({ id: "real-id", nativeMessageId: "real-id" });
    expect(message.sourceCommandId).toBeUndefined();
    expect(message.inputId).toBeUndefined();
  });
});
