import { describe, expect, it } from "vitest";
import { matchesSessionQuery, sessionQueryLinkIds } from "../src/web-ui/session-list.js";

const session = (id: string, title = "Без названия") => ({
  id, harness: "zai", title, cwd: "/", lastMessage: "",
});

describe("session list search over a pasted deep link", () => {
  it("extracts stable chat ids from links and bare UUIDs only", () => {
    expect(sessionQueryLinkIds("https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(sessionQueryLinkIds("https://chatgpt.com/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(sessionQueryLinkIds("6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"))
      .toEqual(["6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"]);
    expect(sessionQueryLinkIds("обычный запрос")).toEqual([]);
    expect(sessionQueryLinkIds("https://example.com/c/not-a-chat-id")).toEqual([]);
  });

  it("finds a zai session by a pasted chat.z.ai link", () => {
    expect(matchesSessionQuery(
      session("route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"),
      "https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    )).toBe(true);
  });

  it("matches bare UUID, scoped and native id forms", () => {
    expect(matchesSessionQuery(
      session("route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"),
      "6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    )).toBe(true);
    expect(matchesSessionQuery(
      session("zai::route%3A6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"),
      "https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    )).toBe(true);
    expect(matchesSessionQuery(
      session("6aa1dd0e-4f11-4fc9-a633-94fa95566c2f", "Browser chat"),
      "https://chatgpt.com/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    )).toBe(true);
  });

  it("keeps ordinary queries working and foreign links honest", () => {
    expect(matchesSessionQuery(
      session("route:11111111-2222-3333-4444-555555555555"),
      "https://chat.z.ai/c/6aa1dd0e-4f11-4fc9-a633-94fa95566c2f",
    )).toBe(false);
    expect(matchesSessionQuery(session("route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f", "ZAI conversation"), "conversation")).toBe(true);
    expect(matchesSessionQuery(session("route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f"), "")).toBe(true);
  });
});
