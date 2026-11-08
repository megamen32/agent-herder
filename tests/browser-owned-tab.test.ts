import { describe, expect, it } from "vitest";
import { isOwnedTabUrl, ownedTabUrl } from "../src/adapters/browser-owned-tab.js";

describe("owned browser tab marker", () => {
  it("marks one tab per provider and recognizes only its own marker", () => {
    expect(ownedTabUrl("https://chatgpt.com", "chatgpt")).toBe("https://chatgpt.com/?herder_owned=chatgpt");
    expect(isOwnedTabUrl("https://chatgpt.com/?herder_owned=chatgpt", "chatgpt")).toBe(true);
    expect(isOwnedTabUrl("https://chatgpt.com/?herder_owned=zai", "chatgpt")).toBe(false);
    expect(isOwnedTabUrl("https://chatgpt.com/c/6ada477c-7014-83ed-82ae-7881dbe3e109", "chatgpt")).toBe(false);
  });
});
