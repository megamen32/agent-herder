import { describe, expect, it } from "vitest";
import { localTranscriptAddressFor, TranscriptRequestOwner, mergeTranscriptPageIfCurrent, transcriptValueIfCurrent, type TranscriptView } from "../src/web-ui/fleet/RemoteSessionView.js";

const page = (hostId: string, nativeSessionId: string, eventId: string): TranscriptView => ({
  scope: { hostId, harness: "codex", nativeSessionId },
  events: [{ sequence: 0, eventId, kind: "message", author: { kind: "unknown", sourceRole: "user" }, text: eventId }],
  totalEvents: 1,
  nextCursor: null,
  complete: true,
  source: "native-complete-export",
});

const key = (value: TranscriptView) => JSON.stringify([value.scope.hostId, value.scope.harness, value.scope.nativeSessionId]);

describe("local native transcript deferred updates", () => {
  it("requests JSONL pages only for supported local transcript harnesses", () => {
    for (const harness of ["codex", "claude", "qoder"]) {
      expect(localTranscriptAddressFor("local-host", { harness, id: "native/id" })).toEqual({
        hostId: "local-host", harness, nativeSessionId: "native/id",
      });
    }
    expect(localTranscriptAddressFor("local-host", { harness: "opencode", id: "empty-or-active" })).toBeUndefined();
  });

  it("binds the normal local session selection to its exact host, harness and native id", () => {
    expect(localTranscriptAddressFor("local-host", { harness: "codex", id: "native/id" })).toEqual({
      hostId: "local-host",
      harness: "codex",
      nativeSessionId: "native/id",
    });
    expect(localTranscriptAddressFor("local-host", { harness: "codex", id: "native/id", remote: true })).toBeUndefined();
    expect(localTranscriptAddressFor("local-host", { harness: "codex", id: "native/id" }, { hostId: "remote-host", harness: "codex", nativeSessionId: "native/id" })).toBeUndefined();
    expect(localTranscriptAddressFor(undefined, { harness: "codex", id: "native/id" })).toBeUndefined();
  });

  it("does not let queued session A page or error updates replace session B", () => {
    const pageA = page("local-host", "session-A", "A-event");
    const pageB = page("local-host", "session-B", "B-event");
    const owner = new TranscriptRequestOwner(key(pageA));
    const tokenA = owner.begin(key(pageA))!;

    // Match React's deferred state updater: the request is current when queued,
    // but the callback may run only after another session has committed.
    const queuedPageA = owner.isCurrent(tokenA)
      ? (current: TranscriptView | undefined) => mergeTranscriptPageIfCurrent(current, pageA, owner, tokenA, "replace")
      : undefined;
    const queuedErrorA = owner.isCurrent(tokenA)
      ? (current: string) => transcriptValueIfCurrent(current, "session A failed", owner, tokenA)
      : undefined;
    expect(owner.finish(tokenA)).toBe(true);

    owner.setSession(key(pageB));
    const tokenB = owner.begin(key(pageB))!;
    const committedPageB = pageB;
    const committedErrorB = "session B error";

    expect(queuedPageA!(committedPageB)).toBe(committedPageB);
    expect(queuedErrorA!(committedErrorB)).toBe(committedErrorB);
    expect(owner.isCurrent(tokenB)).toBe(true);
    expect(owner.finish(tokenB)).toBe(true);
  });

  it("prepends older pages and preserves their cursor when the observed tail changes", () => {
    const view = (ids: string[], nextCursor: string | null): TranscriptView => ({
      ...page("local-host", "session-A", ids[0]), order: "latest", nextCursor, complete: nextCursor === null,
      events: ids.map(id => page("local-host", "session-A", id).events[0]),
    });
    const tail = view(["3", "4"], "older");
    const owner = new TranscriptRequestOwner(key(tail));
    const token = owner.begin(key(tail))!;
    const older = mergeTranscriptPageIfCurrent(tail, view(["1", "2", "3"], "oldest"), owner, token, "older")!;
    expect(older.events.map(event => event.eventId)).toEqual(["1", "2", "3", "4"]);
    const refreshed = mergeTranscriptPageIfCurrent(older, view(["4", "5"], "next-tail"), owner, token, "refresh")!;
    expect(refreshed.events.map(event => event.eventId)).toEqual(["1", "2", "3", "4", "5"]);
    expect(refreshed.nextCursor).toBe("oldest");
    const separateTail = view(["8", "9"], "gap");
    expect(mergeTranscriptPageIfCurrent(refreshed, separateTail, owner, token, "refresh")).toBe(separateTail);
  });

  it("deduplicates a current continuation without dropping the newer cursor", () => {
    const firstPage = page("local-host", "session-A", "event-1");
    const secondPage: TranscriptView = {
      ...firstPage,
      events: [
        firstPage.events[0],
        { sequence: 1, eventId: "event-2", kind: "tool_call", author: { kind: "assistant", sourceRole: "assistant" }, toolName: "read_file", toolCallId: "call-2" },
      ],
      totalEvents: 2,
      nextCursor: "next-cursor",
      complete: false,
    };
    const owner = new TranscriptRequestOwner(key(firstPage));
    const token = owner.begin(key(firstPage))!;
    const merged = mergeTranscriptPageIfCurrent(firstPage, secondPage, owner, token, "older")!;
    expect(merged.events.map(event => event.eventId)).toEqual(["event-1", "event-2"]);
    expect(merged.nextCursor).toBe("next-cursor");
    expect(owner.finish(token)).toBe(true);
  });
});
