import { createServer } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { openCodeAutomaticInputId } from "../packages/agent-resume/src/harness/opencode/client.js";
import { makeConfiguredAdapter, serveOpenCodeAhap } from "../src/ahap-opencode-runner.js";

async function read(messages: unknown[], family: "v2" | "v22" = "v2") {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/config") res.end(JSON.stringify(family === "v2" ? [{ type: "document", path: "/tmp/isolated/opencode.json" }] : null));
    else if (req.method === "GET" && req.url?.startsWith((family === "v2" ? "/api" : "") + "/session/requested-session/message")) {
      res.end(JSON.stringify(family === "v2" ? { data: messages } : messages));
    } else {
      res.end(JSON.stringify({ error: "unexpected request" }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no local address");
  try {
    const selected = await makeConfiguredAdapter(`http://127.0.0.1:${address.port}`);
    const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = [];
    output.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const done = serveOpenCodeAhap(selected.adapter, input, output, selected.family);
    input.end([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "opencode", ahapVersion: "0.1" } },
      { jsonrpc: "2.0", id: 2, method: "getSessionMessages", params: { id: "requested-session", limit: 20 } },
    ].map(item => JSON.stringify(item)).join("\n") + "\n");
    await done;
    const replies = Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toEqual(["GET /api/config", family === "v2"
      ? "GET /api/session/requested-session/message?limit=60&order=desc" : "GET /session/requested-session/message"]);
    return replies[1].result as Array<Record<string, unknown>>;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("OpenCode exact native message correlation", () => {
  it("preserves observed native input identity across the AHAP read wire", async () => {
    const [message] = await read([{
      info: { id: "real-native-message", role: "user", sessionID: "requested-session",
        metadata: { agentHerderInputId: "process-wake:process-rule:original-key" } },
      parts: [{ type: "text", text: "native history" }],
    }]);
    expect(message).toMatchObject({
      id: "real-native-message", nativeMessageId: "real-native-message", sessionId: "requested-session",
      inputId: "process-wake:process-rule:original-key", role: "user",
    });
  });

  it("does not promote a synthetic display id or prompt text into receipt evidence", async () => {
    const [message] = await read([{
      info: { role: "user", turnId: "original-key" }, parts: [{ type: "text", text: "original-key" }],
    }]);
    expect(message.id).toBe("requested-session:message-1");
    expect(message.nativeMessageId).toBeUndefined();
    expect(message.inputId).toBeUndefined();
    expect(message.sessionId).toBeUndefined();
  });

  it("preserves conflicting native identities and exact metadata bytes", async () => {
    const [message] = await read([{
      id: "different-display-id", inputId: "unrelated-outer-input",
      metadata: { agentHerderInputId: "unrelated-outer-key" },
      info: { id: "actual-native-id", role: "user", sessionID: "different-session",
        inputId: "unrelated-info-input", metadata: { agentHerderInputId: "  exact-native-key  " } },
      parts: [],
    }]);
    expect(message).toMatchObject({
      id: "different-display-id", nativeMessageId: "actual-native-id", sessionId: "different-session",
      inputId: "  exact-native-key  ",
    });
  });

  it("never attaches a fallback input correlation to a proven native message", async () => {
    const [message] = await read([{
      id: "actual-native-id", inputId: "original-key", metadata: { agentHerderInputId: "original-key" },
      info: { id: "actual-native-id", role: "user", inputId: "original-key" }, parts: [],
    }]);
    expect(message).toMatchObject({ id: "actual-native-id", nativeMessageId: "actual-native-id" });
    expect(message.inputId).toBeUndefined();
    const [legacy] = await read([{ id: "legacy-id", type: "user", metadata: { agentHerderInputId: "display-only" } }]);
    expect(legacy.inputId).toBe("display-only");
    expect(legacy.nativeMessageId).toBeUndefined();
  });

  it("recognizes the actual verified v2 native top-level user envelope", async () => {
    const [message] = await read([{
      id: "msg_1d6fb67c4001Tp8RgtbH7235CC", type: "user",
      metadata: { agentHerderInputId: "process-wake:process-rule:actual-request-key" },
      time: { created: 1_700_000_000_000 }, text: "native record",
    }]);
    expect(message).toMatchObject({
      id: "msg_1d6fb67c4001Tp8RgtbH7235CC", nativeMessageId: "msg_1d6fb67c4001Tp8RgtbH7235CC",
      inputId: "process-wake:process-rule:actual-request-key", role: "user",
    });
    expect(message.sessionId).toBeUndefined();
  });

  it("rejects top-level proof without the exact v2 native user shape", async () => {
    for (const row of [
      { id: "display-id", type: "user", metadata: { agentHerderInputId: "key" } },
      { id: "msg_123ABC", type: "assistant", metadata: { agentHerderInputId: "key" } },
      { id: "msg_123ABC", type: "user", inputId: "key" },
      { id: "msg_123ABC", type: "user", info: {}, metadata: { agentHerderInputId: "key" } },
    ]) {
      const [message] = await read([row]);
      expect(message.nativeMessageId).toBeUndefined();
    }
  });

  it("does not grant v2 top-level evidence to a different verified protocol", async () => {
    const [message] = await read([{
      id: "msg_123ABC", type: "user", metadata: { agentHerderInputId: "display-only" },
    }], "v22");
    expect(message.nativeMessageId).toBeUndefined();
  });
});


it("recognizes only exact native synthetic completion metadata and id", async () => {
  const key = "process-wake:exact-key";
  const native = { id: openCodeAutomaticInputId("requested-session", key), type: "synthetic",
    text: "receipt", metadata: { agentHerderInputId: key, agentHerderSessionId: "requested-session",
      agentHerderContinuation: "synthetic-queue-v1" } };
  expect((await read([native]))[0]).toMatchObject({
    id: native.id, nativeMessageId: native.id, nativeInputType: "synthetic", role: "system", inputId: key,
  });
  for (const row of [
    { ...native, id: "msg_unrelated" },
    { ...native, metadata: { ...native.metadata, agentHerderSessionId: "other-session" } },
    { ...native, metadata: { agentHerderInputId: key } },
    { ...native, type: "assistant" },
    { ...native, info: {} },
  ]) {
    expect((await read([row]))[0].nativeInputType).toBeUndefined();
  }
});
