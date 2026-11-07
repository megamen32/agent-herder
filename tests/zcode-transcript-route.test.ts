import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { handleIntegratorSessionTranscript } from "../src/integrator-session-route.js";
import type { HarnessAdapter } from "../src/types/index.js";

describe("ZCode complete transcript route", () => {
  it("pages every native message, preserving parts and freezing the snapshot", async () => {
    const messages = [
      { info: { messageId: "m1", sessionId: "s1", role: "user" }, parts: [{ type: "text", text: "question" }] },
      { info: { messageId: "m2", sessionId: "s1", role: "assistant" }, parts: [{ type: "text", text: "answer" }, { type: "tool", callId: "t1", state: { output: "tool result" } }] },
    ];
    const adapter = {
      type: "zcode",
      async getSession(id: string) { return id === "s1" ? { id, harness: "zcode", status: "idle" } : null; },
      async getRawTranscript() { return { complete: true, source: { kind: "native-api", location: "zcode app-server session/read", format: "json" }, bytes: Buffer.from(JSON.stringify({ session: { sessionId: "s1" }, messages })) }; },
    } as unknown as HarnessAdapter;
    const server = createServer((req, res) => { void handleIntegratorSessionTranscript(req, res, new URL(req.url!, "http://localhost"), new Map([["zcode", adapter]])); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("no listener");
    const base = `http://127.0.0.1:${address.port}/api/sessions/zcode/s1/transcript?limit=1`;
    try {
      const response = await fetch(base); expect(response.status).toBe(200);
      const first = (await response.json() as any).transcript;
      expect(first.events[0]).toMatchObject({ eventId: "m1", text: "question" });
      expect(first.totalEvents).toBe(2);
      messages.push({ info: { messageId: "m3", sessionId: "s1", role: "user" }, parts: [{ type: "text", text: "later" }] });
      const secondResponse = await fetch(`${base}&cursor=${encodeURIComponent(first.nextCursor)}`);
      expect(secondResponse.status).toBe(200);
      const second = (await secondResponse.json() as any).transcript;
      expect(second.complete).toBe(true);
      expect(second.events[0]).toMatchObject({ eventId: "m2", text: "answer", payload: { parts: [{ type: "text" }, { type: "tool", callId: "t1" }] } });
      messages[0].parts[0].text = "rewritten";
      expect((await fetch(`${base}&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(422);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
