import { createServer } from "node:http";
import { expect, it } from "vitest";
import { handleIntegratorSessionTranscript } from "../src/integrator-session-route.js";
import type { HarnessAdapter } from "../src/types/index.js";

it("pages an exact complete OpenCode JSON export through the ordinary route", async () => {
  const messages = [
    { id: "m1", sessionID: "s1", type: "user", text: "question" },
    { id: "m2", sessionID: "s1", type: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool", id: "t1" }] },
    { id: "m3", sessionID: "s1", type: "idle", outcome: "completed" },
  ];
  const adapter = { type: "opencode", async getSession() { return { id: "s1", harness: "opencode", status: "idle" }; },
    async getRawTranscript() { return { complete: true, source: { kind: "native-api", format: "json", location: "native" }, bytes: Buffer.from(JSON.stringify(messages)) }; },
  } as unknown as HarnessAdapter;
  const server = createServer((req, res) => { void handleIntegratorSessionTranscript(req, res, new URL(req.url!, "http://localhost"), new Map([["opencode", adapter]])); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("no listener");
  const base = `http://127.0.0.1:${address.port}/api/sessions/opencode/s1/transcript?limit=1`;
  try {
    const firstResponse = await fetch(base); expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json() as any).transcript;
    expect(first.events[0]).toMatchObject({ eventId: "m1", text: "question" });
    const secondResponse = await fetch(`${base}&cursor=${encodeURIComponent(first.nextCursor)}`); expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json() as any).transcript;
    expect(second.complete).toBe(false);
    expect(second.events[0]).toMatchObject({ eventId: "m2", text: "answer", payload: { content: [{ type: "text" }, { type: "tool", id: "t1" }] } });
    const thirdResponse = await fetch(`${base}&cursor=${encodeURIComponent(second.nextCursor)}`); expect(thirdResponse.status).toBe(200);
    const third = (await thirdResponse.json() as any).transcript;
    expect(third).toMatchObject({ complete: true, events: [{ eventId: "m3", author: { kind: "system", sourceRole: "idle" }, payload: { outcome: "completed" } }] });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
