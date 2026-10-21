import { describe, expect, it } from "vitest";
import { selectionAfterSessionRefresh, sessionKeyFromHash, sessionTurnLinkFromHash } from "../src/web-ui/session-list.js";

describe("session selection after quick-list refresh", () => {
  it("opens new and previously delivered Notice Place links to the same session", () => {
    expect(sessionKeyFromHash("#/session/zcode%3Ases%2Fwith%20spaces")).toBe("zcode:ses/with spaces");
    expect(sessionKeyFromHash("#zcode/ses%2Fwith%20spaces")).toBe("zcode:ses/with spaces");
    expect(sessionKeyFromHash("#/session/%broken")).toBeUndefined();
    expect(sessionKeyFromHash("#unrelated")).toBeUndefined();
  });
  it("keeps a completed Notice Place deep link absent from the active list", () => {
    const linked = "opencode:completed-diagnosis";
    expect(selectionAfterSessionRefresh(linked, linked, [{ harness: "codex", id: "other-running" }])).toBe(linked);
    expect(selectionAfterSessionRefresh(linked, linked, [])).toBe(linked);
  });
  it("keeps a cold deep link when quick-list hydration has no current selection", () => {
    const linked = "codex:existing-native-session";
    expect(sessionKeyFromHash("#/session/codex%3Aexisting-native-session")).toBe(linked);
    expect(sessionKeyFromHash("#/session/codex:existing-native-session")).toBe(linked);
    expect(selectionAfterSessionRefresh(undefined, linked, [])).toBe(linked);
    expect(selectionAfterSessionRefresh("codex:previous-session", linked, [{ harness: "codex", id: "previous-session" }])).toBe(linked);
  });
  it("parses an exact turn locator without treating it as session identity or author evidence", () => {
    expect(sessionTurnLinkFromHash("#/session/codex%3Athread%2F1?turn=turn%2F42")).toEqual({sessionKey:"codex:thread/1",turnId:"turn/42"});
    expect(sessionKeyFromHash("#/session/codex%3Athread%2F1?turn=turn%2F42")).toBe("codex:thread/1");
    expect(sessionTurnLinkFromHash("#/session/codex%3Athread%2F1?turn=%00")).toEqual({sessionKey:"codex:thread/1"});
    expect(sessionTurnLinkFromHash("#/session/codex%3Athread%2F1")).toEqual({sessionKey:"codex:thread/1"});
  });
  it("keeps a listed session but clears a missing unlinked selection", () => {
    const listed = [{ harness: "zcode", id: "running" }];
    expect(selectionAfterSessionRefresh("zcode:running", undefined, listed)).toBe("zcode:running");
    expect(selectionAfterSessionRefresh("codex:removed", undefined, listed)).toBeUndefined();
  });
});
