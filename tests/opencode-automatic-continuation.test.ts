import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { openCodeAutomaticInputId } from "../packages/agent-resume/src/harness/opencode/client.js";

async function fixture(mode: "ok" | "lost" | "conflict" = "ok") {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const stored = new Map<string, any>();
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", chunk => text += chunk);
    req.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: req.method!, path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/session/ses_exact/synthetic") {
        const row = stored.get(body.id) ?? { id: body.id, sessionID: "ses_exact",
          type: "synthetic", delivery: body.delivery,
          payload: { text: body.text, metadata: body.metadata, description: body.description } };
        stored.set(body.id, row);
        if (mode === "lost") { req.socket.destroy(); return; }
        res.end(JSON.stringify({ data: mode === "conflict"
          ? { ...row, payload: { ...row.payload, text: "different prior input" } } : row }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/session/ses_exact/message")) {
        res.end(JSON.stringify({ data: [...stored.values()].map(row => ({
          id: row.id, type: row.type, text: row.payload.text, metadata: row.payload.metadata,
        })), cursor: { next: null, previous: null } }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/session/ses_exact/prompt") {
        res.end(JSON.stringify({ data: { id: "msg_manual" } })); return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected native call" }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no fixture address");
  const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, protocol: "v2" });
  return { adapter, calls, stored, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

it("automatic completion admits one native synthetic queue without prompt hooks, steer or a second wake", async () => {
  const f = await fixture();
  try {
    const options = { message: "Build finished. Read its receipt.", inputId: "process-wake:rule1",
      queue: true, origin: "automation" as const };
    const result = await f.adapter.sendMessage("ses_exact", options);
    const id = openCodeAutomaticInputId("ses_exact", options.inputId);
    expect(result).toMatchObject({ ok: true, admitted: true, inputId: options.inputId, nativeInputMessageId: id });
    expect(f.calls).toEqual([{ method: "POST", path: "/api/session/ses_exact/synthetic", body: {
      id, text: options.message, description: "Agent Herder completion", delivery: "queue", resume: true,
      metadata: { agentHerderInputId: options.inputId, agentHerderSessionId: "ses_exact",
        agentHerderContinuation: "synthetic-queue-v1" },
    } }]);
    // Native synthetic records are system inputs in Herder, never assistant
    // outputs or invented human user records.
    expect(await f.adapter.getSessionMessages("ses_exact", 20)).toEqual([expect.objectContaining({
      id, nativeMessageId: id, nativeInputType: "synthetic", inputId: options.inputId, role: "system",
    })]);
    expect(f.stored.size).toBe(1);
  } finally { await f.close(); }
});

it("native input identity is stable per exact session and key, independent of payload", async () => {
  const f = await fixture();
  try {
    const options = { message: "Completed", inputId: "one-key", queue: true, origin: "automation" as const };
    const first = await f.adapter.sendMessage("ses_exact", options);
    const second = await f.adapter.sendMessage("ses_exact", options);
    expect(first.nativeInputMessageId).toBe(second.nativeInputMessageId);
    expect(f.stored.size).toBe(1);
    expect(openCodeAutomaticInputId("ses_other", "one-key")).not.toBe(first.nativeInputMessageId);
    expect(openCodeAutomaticInputId("ses_exact", "other-key")).not.toBe(first.nativeInputMessageId);
  } finally { await f.close(); }
});

it("lost native ACK remains unknown, is not retried, and retains exact readback correlation", async () => {
  const f = await fixture("lost");
  try {
    const result = await f.adapter.sendMessage("ses_exact", {
      message: "Completed", inputId: "lost-key", queue: true, origin: "automation",
    });
    expect(result).toMatchObject({ ok: false, admissionUnknown: true, admission: "unknown" });
    expect(result.notSubmitted).not.toBe(true);
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    const [message] = (await f.adapter.getSessionMessages("ses_exact", 20))!;
    expect(message).toMatchObject({ inputId: "lost-key", nativeInputType: "synthetic",
      nativeMessageId: openCodeAutomaticInputId("ses_exact", "lost-key") });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  } finally { await f.close(); }
});

it("a conflicting first-wins native payload cannot confirm the new request", async () => {
  const f = await fixture("conflict");
  try {
    expect(await f.adapter.sendMessage("ses_exact", {
      message: "Completed", inputId: "conflict-key", queue: true, origin: "automation",
    })).toMatchObject({ ok: false, admissionUnknown: true, admission: "unknown" });
    expect(f.calls).toHaveLength(1);
  } finally { await f.close(); }
});

it("automatic Start and Steer fail before native I/O while manual Queue keeps the prompt endpoint", async () => {
  const f = await fixture();
  try {
    for (const mode of [{ queue: false, steer: true }, { queue: false, start: true }]) {
      expect(await f.adapter.sendMessage("ses_exact", {
        message: "Completed", inputId: "refused", origin: "automation", ...mode,
      })).toMatchObject({ notSubmitted: true, admission: "not_submitted" });
    }
    expect(f.calls).toHaveLength(0);
    expect(await f.adapter.sendMessage("ses_exact", {
      message: "Human question", inputId: "human-key", queue: true, origin: "human", activeTurnOnly: true,
    })).toMatchObject({ ok: true, nativeInputMessageId: "msg_manual" });
    expect(f.calls.map(call => call.path)).toEqual(["/api/session/ses_exact/prompt"]);
  } finally { await f.close(); }
});
