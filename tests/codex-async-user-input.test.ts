import { describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const questions = [{ title: "Which route?", options: ["First", "Second"] }, { title: "Extra detail", options: null }];
const user = { type: "userMessage", id: "user", content: [] };
const question = { type: "agentMessage", id: "question", phase: "final_answer", text: "", questions };
const turn = (items: unknown[] = [user, question], status = "interrupted") => ({ id: "turn", status, itemsView: "summary", items, completedAt: null });
function fixture(value: unknown = { data: [turn()] }) {
  const adapter = new CodexAppServerAdapter({ cwd: process.cwd() });
  const internal = adapter as any;
  internal.ensureReady = vi.fn(async () => {});
  internal.request = vi.fn(async () => value);
  const events: any[] = [];
  adapter.subscribeEvents(event => events.push(event));
  return { adapter, internal, events };
}
describe("Codex persisted async input", () => {
  it("hydrates a native summary that retained only the empty final envelope", async () => {
    const empty = { type: "agentMessage", id: "empty-final", phase: "final_answer", text: "", questions: null };
    const { adapter, internal } = fixture();
    internal.request.mockResolvedValueOnce({ data: [turn([user, empty], "completed")] })
      .mockResolvedValueOnce({ data: [{ ...turn([user, question, empty], "completed"), itemsView: "full" }] });
    expect(await adapter.readAsyncUserInputState("thread")).toMatchObject({ itemId: "question", questions });
    expect(internal.request).toHaveBeenLastCalledWith("thread/turns/list", { threadId: "thread", limit: 1, sortDirection: "desc", itemsView: "full" });
  });
  it("reads the real completed question followed by an explicit empty final message", async () => {
    const empty = { type: "agentMessage", id: "empty-final", phase: "final_answer", text: "", questions: null };
    for (const text of ["", " \n\t "]) {
      const { adapter } = fixture({ data: [turn([user,
        { type: "agentMessage", id: "commentary", phase: "commentary", text: "Choosing a route", questions: null },
        question, { ...empty, text }, empty], "completed")] });
      expect(await adapter.readAsyncUserInputState("thread")).toMatchObject({ itemId: "question", questions });
    }
  });
  it("does not skip later user, tool, opaque, malformed or nonempty assistant items", async () => {
    const empty = { type: "agentMessage", id: "empty", phase: "final_answer", text: "", questions: null };
    for (const blocker of [user, { type: "commandExecution", id: "cmd" }, { type: "unknown", id: "opaque" },
      { ...empty, text: "Finished" }, { ...empty, questions: [{ invalid: true }] }]) {
      const { adapter } = fixture({ data: [turn([user, question, blocker, empty], "completed")] });
      expect(await adapter.readAsyncUserInputState("thread")).toBeNull();
    }
  });
  it("hydrates omitted tail text before deciding whether it is empty", async () => {
    for (const text of ["", "Already answered"]) {
      const summary = turn([user, question, { type: "agentMessage", id: "tail", phase: "final_answer", questions: null }], "completed");
      const { adapter, internal } = fixture();
      internal.request.mockResolvedValueOnce({ data: [summary] }).mockResolvedValueOnce({ data: [{ ...summary, itemsView: "full",
        items: [user, question, { ...summary.items[2] as object, text }],
      }] });
      expect(Boolean(await adapter.readAsyncUserInputState("thread"))).toBe(text === "");
      expect(internal.request).toHaveBeenCalledTimes(2);
    }
  });
  it("reads interrupted native typed questions even without completedAt", async () => {
    const { adapter, internal } = fixture();
    expect(await adapter.readAsyncUserInputState("thread")).toMatchObject({ target: { harness: "codex", sessionId: "thread" }, turnId: "turn", itemId: "question", questions, canRespond: true });
    expect(internal.request).toHaveBeenCalledExactlyOnceWith("thread/turns/list", { threadId: "thread", limit: 1, sortDirection: "desc", itemsView: "summary" });
  });
  it("accepts completed questions and rejects in-progress or failed turns", async () => {
    for (const status of ["completed", "inProgress", "failed"]) {
      const { adapter } = fixture({ data: [turn(undefined, status)] });
      expect(Boolean((await adapter.readAsyncUserInputState("thread"))?.canRespond)).toBe(status === "completed");
    }
  });
  it("rejects an answered question, later items, missing user and untyped text", async () => {
    for (const items of [[user, question, user], [user, question, { type: "commandExecution", id: "cmd" }], [question],
      [user, { ...question, questions: [] }], [user, { ...question, questions: [{ title: "Bad", options: [1] }] }],
      [user, { ...question, questions: null, text: "A question?" }]]) {
      const { adapter } = fixture({ data: [turn(items)] });
      expect(await adapter.readAsyncUserInputState("thread")).toBeNull();
    }
  });
  it("uses only the latest turn and never searches older unanswered questions", async () => {
    const { adapter } = fixture({ data: [turn([user, { ...question, questions: null }])] });
    expect(await adapter.readAsyncUserInputState("thread")).toBeNull();
  });
  it("hydrates an incomplete summary with one full turn page and fences a newer turn", async () => {
    const { adapter, internal } = fixture({ data: [turn([user, { type: "agentMessage", id: "question" }])] });
    internal.request.mockResolvedValueOnce({ data: [turn([user, { type: "agentMessage", id: "question" }])] })
      .mockResolvedValueOnce({ data: [{ ...turn(), itemsView: "full" }] });
    expect((await adapter.readAsyncUserInputState("thread"))?.questions).toEqual(questions);
    expect(internal.request).toHaveBeenLastCalledWith("thread/turns/list", { threadId: "thread", limit: 1, sortDirection: "desc", itemsView: "full" });
    internal.request.mockResolvedValueOnce({ data: [turn([user, { type: "agentMessage", id: "question" }])] })
      .mockResolvedValueOnce({ data: [{ ...turn(), id: "newer", itemsView: "full" }] });
    expect(await adapter.readAsyncUserInputState("thread")).toBeNull();
  });
  it("emits a typed completed-item event without a fabricated RPC", () => {
    const { internal, events } = fixture();
    internal.consumeMessage({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: question } });
    expect(events.filter(event => event.nativeType === "agentMessage/questions")).toEqual([
      expect.objectContaining({ kind: "message.updated", status: "needs_input", sessionId: "thread", data: { turnId: "turn", itemId: "question", questions } }),
    ]);
    expect(internal.request).not.toHaveBeenCalled();
  });
});
