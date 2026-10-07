import { describe, expect, it } from "vitest";
import {
  decodeResourceComponent,
  sessionMessagesResourceUri,
  sessionResourceUri,
} from "../src/herder-resource-uris.js";

describe("Herder session resource URI components", () => {
  it("round-trips Fast Agent external IDs exactly once", () => {
    const id = "fast-agent:2610071837-yQGZPB";
    expect(sessionResourceUri("fast-agent", id)).toContain("fast-agent%3A2610071837-yQGZPB");
    expect(sessionMessagesResourceUri("fast-agent", id)).toContain("fast-agent%3A2610071837-yQGZPB/messages");
    expect(decodeResourceComponent(encodeURIComponent(id))).toBe(id);
  });

  it("fails closed on malformed percent escapes", () => {
    expect(() => decodeResourceComponent("fast-agent%broken")).toThrow(
      "Invalid percent-encoded Herder resource component",
    );
  });
});
