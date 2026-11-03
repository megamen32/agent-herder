import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSearchIndex, deepLinkSessionIds } from "../src/session-search.js";

const dirs: string[] = [];
const indexes: SessionSearchIndex[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herder-link-search-"));
  dirs.push(dir);
  const index = new SessionSearchIndex(join(dir, "index.sqlite"), "host-a");
  indexes.push(index);
  return index;
}
async function* chunks(text: string) { yield { id: "message-1", text }; }
afterEach(() => {
  for (const index of indexes.splice(0)) index.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session search over a pasted deep link", () => {
  it("extracts stable chat ids from links and bare UUIDs only", () => {
    expect(deepLinkSessionIds("https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(deepLinkSessionIds("https://chatgpt.com/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(deepLinkSessionIds("посмотри чат 6aa1dd0e-4f11-4fc9-a633-94fa95566c2f, пожалуйста"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(deepLinkSessionIds("обычный запрос")).toEqual([]);
    expect(deepLinkSessionIds("https://example.com/c/not-a-chat-id")).toEqual([]);
  });

  it("finds the zai session a pasted chat.z.ai link points to, first", async () => {
    const index = fixture();
    await index.ingest({
      harness: "zai", nativeSessionId: "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
      title: "ZAI conversation", cwd: "/", revision: "1", chunks: chunks("привет"),
    }, "scan-1");
    await index.ingest({
      harness: "codex", nativeSessionId: "other-id",
      title: "unrelated", cwd: "/", revision: "1", chunks: chunks("текст со словами https chat"),
    }, "scan-1");
    const result = index.search({ query: "https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      hostId: "host-a", harness: "zai", nativeSessionId: "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    });
  });

  it("matches the plain and scoped id forms a session row can carry", async () => {
    const index = fixture();
    await index.ingest({
      harness: "chatgpt", nativeSessionId: "6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
      title: "Browser chat", cwd: "/", revision: "1", chunks: chunks("hello"),
    }, "scan-1");
    const result = index.search({ query: "6aa1dd0e-4f11-4fc9-a633-94fa95566c2f" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ harness: "chatgpt", nativeSessionId: "6aa1dd0e-4f11-4fc9-a633-94fa95566c2f" });
  });
});
