import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeClient } from "../src/harness/opencode/client.js";

afterEach(() => vi.unstubAllGlobals());

it("reads every native OpenCode transcript page before claiming completeness", async () => {
  const first = Array.from({ length: 200 }, (_, n) => ({ id: `msg-${n}`, type: "user", text: `message-${n}` }));
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
    const url = new URL(input.toString());
    if (url.pathname === "/api/session/ses-test") return Response.json({ data: { id: "ses-test", directory: "/project" } });
    seen.push(url.search);
    if (!url.searchParams.has("cursor")) return Response.json({ data: first, cursor: { next: "next-page", previous: null } });
    if (url.searchParams.get("cursor") === "next-page") return Response.json({ data: [{ id: "msg-200", type: "assistant", text: "last-answer" }], cursor: { next: null, previous: "prev" } });
    return new Response(null, { status: 400 });
  }));
  const client = new OpenCodeClient({ baseUrl: "http://opencode.test", protocol: "v2" });
  const raw = await client.getRawTranscript("ses-test");
  expect(raw).not.toBeNull();
  expect(JSON.parse(Buffer.from(raw!.bytes).toString())).toHaveLength(201);
  expect(Buffer.from(raw!.bytes).toString()).toContain("last-answer");
  expect(seen).toHaveLength(2);
});
