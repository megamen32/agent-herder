import { describe, expect, it, vi } from "vitest";
import type { NativeTranscriptEvent } from "../src/integrator-transcript.js";
import { fallbackSessionAttribution, fetchIntegratorTranscriptPage, integratorEventDisplay, TranscriptRequestOwner, transcriptForAddress, type TranscriptView } from "../src/web-ui/fleet/RemoteSessionView.js";

const address = { hostId: "roomhacker-server-100", harness: "codex", nativeSessionId: "thread/1" } as const;

describe("RemoteSessionView native transcript integration", () => {
  it("keeps native user-role authors unknown instead of labeling them as the current viewer", () => {
    const event: NativeTranscriptEvent = {
      sequence: 0, eventId: "native-user-1", kind: "message",
      author: { kind: "unknown", sourceRole: "user" }, text: "Please inspect this task",
    };
    expect(integratorEventDisplay(event)).toMatchObject({
      attribution: "Неизвестный автор · user",
      visualRole: "unknown",
      message: { id: "native-user-1", role: "user", text: "Please inspect this task" },
    });
    expect(fallbackSessionAttribution("user")).toBe("Неизвестный автор · user");
    expect(fallbackSessionAttribution("tool")).toBe("Инструмент");
    expect(fallbackSessionAttribution("system")).toBe("Система");
  });

  it("retains native tool name, call identity and payload for display", () => {
    const event: NativeTranscriptEvent = {
      sequence: 1, eventId: "call-event", kind: "tool_call",
      author: { kind: "assistant", sourceRole: "assistant" }, toolName: "read_file",
      toolCallId: "call-7", payload: { path: "README.md" },
    };
    expect(integratorEventDisplay(event)).toMatchObject({
      attribution: "Вызов инструмента · read_file",
      message: { role: "assistant", parts: [{ type: "tool_call", name: "read_file", input: { callId: "call-7", arguments: { path: "README.md" } } }] },
    });
  });

  it("fetches a bounded continuation from the exact host-local transcript route and checks its scope", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      session: { id: address.nativeSessionId, harness: address.harness, status: "running", lastActivity: "2026-10-20T20:00:00Z" },
      transcript: { scope: address, events: [], totalEvents: 1, nextCursor: null, complete: true, source: "native-complete-export" },
      steerEndpoint: "/api/sessions/codex/thread%2F1/message",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const page = await fetchIntegratorTranscriptPage({ address, expectedHostId: address.hostId, cursor: "cursor /next", fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/codex/thread%2F1/transcript?limit=50&cursor=cursor+%2Fnext",
      { credentials: "same-origin", cache: "no-store" },
    );
    expect(page.transcript.scope).toEqual(address);
  });

  it("renders transcript state only for the exact captured host, harness and session", () => {
    const transcript: TranscriptView = {
      scope: address, events: [], totalEvents: 0, nextCursor: null, complete: true, source: "native-complete-export",
    };
    expect(transcriptForAddress(transcript, address)).toBe(transcript);
    expect(transcriptForAddress(transcript, { ...address, hostId: "other-host" })).toBeUndefined();
    expect(transcriptForAddress(transcript, { ...address, harness: "opencode" })).toBeUndefined();
    expect(transcriptForAddress(transcript, { ...address, nativeSessionId: "thread/2" })).toBeUndefined();
  });

  it("ignores delayed session A completion without releasing session B's request owner", async () => {
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const pageA = new Promise<string>(resolve => { resolveA = resolve; });
    const pageB = new Promise<string>(resolve => { resolveB = resolve; });
    const owner = new TranscriptRequestOwner("A");
    const tokenA = owner.begin("A")!;
    let displayed = "";

    owner.setSession("B");
    const tokenB = owner.begin("B")!;
    expect(owner.begin("B")).toBeNull();

    const finishA = async () => {
      const value = await pageA;
      if (owner.isCurrent(tokenA)) displayed = value;
      owner.finish(tokenA);
    };
    const finishB = async () => {
      const value = await pageB;
      if (owner.isCurrent(tokenB)) displayed = value;
      owner.finish(tokenB);
    };
    const pendingA = finishA();
    const pendingB = finishB();
    resolveA("session-A-events");
    await pendingA;
    expect(displayed).toBe("");
    expect(owner.isCurrent(tokenB)).toBe(true);
    expect(owner.begin("B")).toBeNull();

    resolveB("session-B-events");
    await pendingB;
    expect(displayed).toBe("session-B-events");
    expect(owner.begin("B")).not.toBeNull();
  });

  it("does not let a late A page overwrite B after B has already completed", async () => {
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const pageA = new Promise<string>(resolve => { resolveA = resolve; });
    const pageB = new Promise<string>(resolve => { resolveB = resolve; });
    const owner = new TranscriptRequestOwner("A");
    const tokenA = owner.begin("A")!;
    let displayed = "";
    const finish = async (promise: Promise<string>, token: ReturnType<TranscriptRequestOwner["begin"]>, ) => {
      if (!token) return;
      const value = await promise;
      if (owner.isCurrent(token)) displayed = value;
      owner.finish(token);
    };
    const pendingA = finish(pageA, tokenA);
    owner.setSession("B");
    const tokenB = owner.begin("B")!;
    const pendingB = finish(pageB, tokenB);

    resolveB("session-B-events");
    await pendingB;
    expect(displayed).toBe("session-B-events");
    resolveA("session-A-events");
    await pendingA;
    expect(displayed).toBe("session-B-events");
  });

  it("keeps a valid page update relevant after finish, but invalidates queued updates on a newer request", () => {
    const owner = new TranscriptRequestOwner("A");
    const tokenA = owner.begin("A")!;
    let queuedA: ((current: string) => string) | undefined;
    if (owner.isCurrent(tokenA)) queuedA = current => owner.isCurrent(tokenA) ? "page-A" : current;
    expect(owner.finish(tokenA)).toBe(true);

    // React may invoke the state updater after the async request's finally ran.
    let displayed = queuedA!("");
    expect(displayed).toBe("page-A");

    const tokenB = owner.begin("A")!;
    let queuedB: ((current: string) => string) | undefined;
    if (owner.isCurrent(tokenB)) queuedB = current => owner.isCurrent(tokenB) ? "page-B" : current;
    expect(owner.finish(tokenB)).toBe(true);
    const tokenC = owner.begin("A")!;

    displayed = queuedB!(displayed);
    expect(displayed).toBe("page-A");
    expect(owner.isCurrent(tokenC)).toBe(true);
  });
});
