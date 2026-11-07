import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeClient } from "../packages/agent-resume/src/harness/opencode/client.js";

afterEach(() => vi.unstubAllGlobals());

it("exports all native v2 pages and does not call a truncated tail complete", async () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, sessionID: "s1", type: "user", text: `text ${i}` }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === "/api/session/s1") return Response.json({ data: { id: "s1", time: { updated: 10 } } });
    return Response.json(url.searchParams.has("cursor")
      ? { data: [{ id: "m200", sessionID: "s1", type: "assistant", text: "answer" }], cursor: { next: null } }
      : { data: messages, cursor: { next: "page-two" } });
  }));
  const client = new OpenCodeClient({ baseUrl: "http://opencode.test", protocol: "v2" });
  const raw = await client.getRawTranscript("s1");
  expect(raw).toMatchObject({ complete: true });
  expect(JSON.parse(Buffer.from(raw!.bytes).toString())).toHaveLength(201);
});

it("rejects a history that changed while the native pages were read", async () => {
  let revision = 10;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => new URL(input.toString()).pathname === "/api/session/s1"
    ? Response.json({ data: { id: "s1", time: { updated: revision++ } } })
    : Response.json({ data: [{ id: "m1", sessionID: "s1", type: "user", text: "hello" }], cursor: { next: null } })));
  const client = new OpenCodeClient({ baseUrl: "http://opencode.test", protocol: "v2" });
  expect(await client.getRawTranscript("s1")).toBeNull();
});
