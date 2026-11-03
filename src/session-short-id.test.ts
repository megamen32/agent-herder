import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionSearchIndex } from "./session-search.js";
import { isShortSessionId, sessionShortId } from "./session-short-id.js";

describe("session short ids", () => {
  it("derives a stable short id per harness and native id", () => {
    const zaiChat = "zai::route%3A6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    const a = sessionShortId("zai", zaiChat);
    expect(a).toMatch(/^[a-z][0-9a-f]{4}$/);
    expect(sessionShortId("zai", zaiChat)).toBe(a);
    expect(sessionShortId("chatgpt", "chatgpt::6ae7ada6-17a0-83eb-b765-6816447a573d")).toMatch(/^g[0-9a-f]{4}$/);
    expect(a).toMatch(/^z[0-9a-f]{4}$/);
    expect(isShortSessionId(a)).toBe(true);
    expect(isShortSessionId(zaiChat)).toBe(false);
    expect(isShortSessionId("")).toBe(false);
  });
});

describe("session search identity", () => {
  it("resolves pasted z.ai and chatgpt deep links and short ids to the exact chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herder-search-"));
    const index = new SessionSearchIndex(join(dir, "index.sqlite"));
    const scan = "scan-1";
    const zaiId = "zai::route%3A6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    const chatgptId = "chatgpt::6ae7ada6-17a0-83eb-b765-6816447a573d";
    await index.ingest(
      { harness: "zai", nativeSessionId: zaiId, title: "Problems with Herder Agent Delivery", cwd: "/home/roomhacker/.browser-chat/zai", revision: "r1",
        chunks: (async function* () { yield { id: "m1", text: "delivery problems herder agent" }; })() },
      scan,
    );
    await index.ingest(
      { harness: "chatgpt", nativeSessionId: chatgptId, title: "Ветка · Установка GPTAdmin на Mac", cwd: "/home/roomhacker/.browser-chat/chatgpt", revision: "r1",
        chunks: (async function* () { yield { id: "m1", text: "установка gptadmin на mac" }; })() },
      scan,
    );
    const byUrl = index.search({ query: "https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f" });
    expect(byUrl.results[0]?.nativeSessionId).toBe(zaiId);
    expect(byUrl.results[0]?.shortId).toBe(sessionShortId("zai", zaiId));
    const byChatgptUrl = index.search({ query: "посмотри https://chatgpt.com/c/6ae7ada6-17a0-83eb-b765-6816447a573d" });
    expect(byChatgptUrl.results[0]?.nativeSessionId).toBe(chatgptId);
    const byShort = index.search({ query: sessionShortId("zai", zaiId) });
    expect(byShort.results[0]?.nativeSessionId).toBe(zaiId);
    const byOtherShort = index.search({ query: sessionShortId("chatgpt", chatgptId) });
    expect(byOtherShort.results[0]?.nativeSessionId).toBe(chatgptId);
    index.close();
  });
});
