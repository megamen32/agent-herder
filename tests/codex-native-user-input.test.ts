import { describe, expect, it, vi, afterEach } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const questions = ["first", "second"].map(id => ({ id, header: id, question: `Choose ${id}`, isOther: false, isSecret: false, options: [{ label: "Yes", description: "Continue" }] }));
const answers = Object.fromEntries(questions.map(q => [q.id, { answers: ["Yes"] }]));
function fixture(rpcId: number | string = "native-7") {
  const adapter = new CodexAppServerAdapter({ cwd: process.cwd() });
  const internal = adapter as any;
  internal.isReady = () => true;
  internal.isTransportWritable = () => true;
  internal.request = vi.fn(async () => ({ data: [{ id: "turn", status: "inProgress", completedAt: null }] }));
  internal.writeMessage = vi.fn();
  const events: any[] = [];
  adapter.subscribeEvents(event => events.push(event));
  const receive = () => internal.consumeMessage({ id: rpcId, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", itemId: "item", questions, isBlocking: true } });
  const resolved = () => internal.consumeMessage({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: rpcId } });
  receive();
  return { adapter, internal, events, receive, resolved };
}
afterEach(() => vi.useRealTimers());
describe("Codex exact native user input", () => {
  it("retains typed requests once, supports string RPC IDs and reports cold uncertainty", async () => {
    const { adapter, internal, events, receive } = fixture();
    receive();
    const state = await adapter.readNativeUserInputState("thread");
    expect(state).toMatchObject({ coldRestoreSupported: false, pendingRequests: [{ id: "native-7", requestId: "native-7", threadId: "thread", turnId: "turn", itemId: "item", questions, canRespond: true }] });
    expect(events.filter(e => e.nativeType === "item/tool/requestUserInput")).toHaveLength(1);
    expect(internal.request).not.toHaveBeenCalled();
  });
  it("returns all sibling answers through the same exact RPC and waits for native resolution", async () => {
    const { adapter, internal, resolved, events, receive } = fixture(7);
    internal.writeMessage.mockImplementation(resolved);
    expect(await adapter.respondNativeUserInput("thread", "7", answers)).toMatchObject({ ok: true, admitted: true });
    expect(internal.writeMessage).toHaveBeenCalledExactlyOnceWith({ id: 7, result: { answers } });
    expect(internal.request).toHaveBeenCalledExactlyOnceWith("thread/turns/list", { threadId: "thread", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    expect((await adapter.readNativeUserInputState("thread"))?.pendingRequests).toEqual([]);
    receive();
    expect((await adapter.readNativeUserInputState("thread"))?.pendingRequests).toEqual([]);
    expect(events.some(e => e.nativeType === "serverRequest/resolved" && e.data.userInput)).toBe(true);
  });
  it("rejects foreign sessions, incomplete answers, changed turns and concurrent writes", async () => {
    const { adapter, internal } = fixture();
    expect((await adapter.respondNativeUserInput("foreign", "native-7", answers)).ok).toBe(false);
    expect((await adapter.respondNativeUserInput("thread", "native-7", { first: answers.first! })).ok).toBe(false);
    internal.request.mockResolvedValueOnce({ data: [{ id: "other", status: "inProgress" }] });
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    expect(internal.writeMessage).not.toHaveBeenCalled();
  });
  it("fences generation changes during preflight and never reconnects an old request", async () => {
    const { adapter, internal } = fixture();
    internal.request.mockImplementation(async () => { internal.beginTransportGeneration(); return { data: [{ id: "turn", status: "inProgress" }] }; });
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    expect(internal.writeMessage).not.toHaveBeenCalled();
    expect((await adapter.readNativeUserInputState("thread"))?.pendingRequests).toEqual([]);
  });
  it("prevents two concurrent preflights from writing twice", async () => {
    const { adapter, internal, resolved } = fixture();
    internal.writeMessage.mockImplementation(resolved);
    const results = await Promise.all([adapter.respondNativeUserInput("thread", "native-7", answers),
      adapter.respondNativeUserInput("thread", "native-7", answers)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(internal.writeMessage).toHaveBeenCalledTimes(1);
  });
  it("does not answer a request resolved during preflight or a completed turn", async () => {
    const { adapter, internal, resolved } = fixture();
    internal.request.mockResolvedValueOnce({ data: [{ id: "turn", status: "completed", completedAt: 1 }] });
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    internal.request.mockImplementationOnce(async () => { resolved(); return { data: [{ id: "turn", status: "inProgress" }] }; });
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    expect(internal.writeMessage).not.toHaveBeenCalled();
  });
  it("resolves an outstanding confirmation as UNKNOWN immediately on disconnect", async () => {
    const { adapter, internal } = fixture();
    internal.writeMessage.mockImplementation(() => internal.clearTransportState(new Error("gone"), {}, false));
    expect(await adapter.respondNativeUserInput("thread", "native-7", answers)).toMatchObject({ ok: false, admissionUnknown: true });
    expect(internal.writeMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed questions and reports unavailable transport without reconnecting", async () => {
    const { adapter, internal } = fixture();
    internal.consumeMessage({ id: "bad", method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [questions[0], questions[0]], isBlocking: true } });
    expect((await adapter.readNativeUserInputState("thread"))?.pendingRequests).toHaveLength(1);
    internal.isTransportWritable = () => false;
    expect(await adapter.readNativeUserInputState("thread")).toBeNull();
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    expect(internal.request).not.toHaveBeenCalled();
  });
  it("freezes UNKNOWN writes against duplicate inbound requests, retries and disconnect", async () => {
    vi.useFakeTimers();
    const { adapter, internal, receive } = fixture();
    const first = adapter.respondNativeUserInput("thread", "native-7", answers);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await first).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
    receive();
    expect((await adapter.respondNativeUserInput("thread", "native-7", answers)).ok).toBe(false);
    expect(internal.writeMessage).toHaveBeenCalledTimes(1);
    internal.beginTransportGeneration();
    expect((await adapter.readNativeUserInputState("thread"))?.pendingRequests).toEqual([]);
  });
});
