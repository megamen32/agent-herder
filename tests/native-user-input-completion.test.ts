import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { nativeUserInputContextRef } from "../src/human-request/native-user-input-notice.js";
import { completeNativeUserInputNotice } from "../src/human-request/native-user-input-completion.js";
import type { HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-completion-")); roots.push(root);
  const registry = new HumanRequestRegistry(join(root, "requests.json"));
  const target = { hostId: "fixture-host", harness: "codex", sessionId: "fixture-thread", nativeRequestId: "native-request" };
  const records = await Promise.all(["a", "b"].map(questionId => registry.create({ kind: "user", answerSource: "notice_question", contextRef: nativeUserInputContextRef({ ...target, questionId }), target: { harness: "codex", sessionId: target.sessionId, cwd: root }, notify: { project: "fixture", recipient: "qa", kind: "human_request", severity: "important", title: "Тест" } })));
  const pending = [{ id: target.nativeRequestId, turnId: "turn", itemId: "item", canRespond: true, questions: [{ id: "b", question: "Текст" }, { id: "a", question: "Выбор", options: [{ label: "Да" }, { label: "Нет" }] }] }];
  const respond = vi.fn(async () => ({ ok: true, admitted: true, admission: "accepted" as const }));
  const adapter = { getSession: vi.fn(async () => ({ id: target.sessionId, harness: "codex", hostId: target.hostId, cwd: root })), readNativeUserInputState: vi.fn(async () => ({ target: { hostId: target.hostId, harness: "codex", sessionId: target.sessionId }, pendingRequests: pending })), respondNativeUserInput: respond, sendMessage: vi.fn() };
  const answers = new Map<string, string>();
  const deps = { loadProducer: async () => ({ endpoint: "https://fixture.test/v1/human-requests", token: "fixture", project: "fixture", recipient: "qa", source: "ask_human_env" as const }), fetchImpl: vi.fn(async (url: any) => {
    const id = String(url).split("/").at(-2)!;
    return answers.has(id) ? new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: id, state: "resolved", kind: "user", result_ref: `notice:${id}`, native: { harness: "codex", session_id: target.sessionId, cwd: root }, answer: answers.get(id) })) : new Response("{}", { status: 409 });
  }) as unknown as typeof fetch };
  const run = () => completeNativeUserInputNotice(registry, records[1]!, adapter as unknown as HarnessAdapter, deps);
  const resolveAll = () => { answers.set(records[0]!.requestId, "option_1"); answers.set(records[1]!.requestId, "Точный ответ"); };
  return { root, registry, records, pending, adapter, respond, answers, deps, run, resolveAll };
}

it("waits without admission until every canonical sibling is answered", async () => {
  const f = await fixture(); f.answers.set(f.records[1]!.requestId, "Точный ответ");
  expect(await f.run()).toMatchObject({ admitted: false, pending: true });
  expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true);
  expect(f.respond).not.toHaveBeenCalled(); expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("responds once with canonical siblings and survives duplicate callback after pending removal", async () => {
  const f = await fixture(); f.resolveAll();
  expect(await f.run()).toMatchObject({ admitted: true, pending: false });
  expect(f.respond).toHaveBeenCalledExactlyOnceWith("fixture-thread", "native-request", { a: { answers: ["Нет"] }, b: { answers: ["Точный ответ"] } });
  expect((await f.registry.list()).every(r => r.status === "resumed")).toBe(true);
  f.pending.splice(0); f.adapter.readNativeUserInputState.mockClear();
  expect(await f.run()).toMatchObject({ admitted: false, pending: false, record: { status: "resumed" } });
  expect(f.adapter.readNativeUserInputState).not.toHaveBeenCalled(); expect(f.respond).toHaveBeenCalledTimes(1);
});

it("serializes concurrent callbacks through the deterministic carrier", async () => {
  const f = await fixture(); f.resolveAll(); await Promise.all([f.run(), f.run()]);
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect((await f.registry.list()).every(r => r.status === "resumed")).toBe(true);
});

it.each(["throw", "unknown"])("fences ambiguous %s native outcome across registry restart", async mode => {
  const f = await fixture(); f.resolveAll();
  f.respond.mockImplementationOnce(async () => { if (mode === "throw") throw new Error("lost transport receipt"); return { ok: false, admitted: false, admission: "unknown" as any }; });
  await f.run(); f.pending.splice(0);
  const registry = new HumanRequestRegistry(join(f.root, "requests.json"));
  expect(await completeNativeUserInputNotice(registry, f.records[0]!, f.adapter as unknown as HarnessAdapter, f.deps)).toMatchObject({ admitted: false, pending: false, record: { status: "resume_failed", resumeRetryable: false } });
  expect(f.respond).toHaveBeenCalledTimes(1);
});

it("does not replay an expired admitted carrier after a crash", async () => {
  const f = await fixture(); f.resolveAll();
  await f.registry.admitResume(f.records[0]!.requestId, { resultRef: `notice:${f.records[0]!.requestId}`, now: new Date("2020-01-01"), leaseMs: 1000 });
  f.pending.splice(0);
  expect(await f.run()).toMatchObject({ admitted: false, pending: true });
  expect(f.respond).not.toHaveBeenCalled(); expect(f.adapter.readNativeUserInputState).not.toHaveBeenCalled();
});

it("rejects a forged canonical binding before claiming or writing native input", async () => {
  const f = await fixture(); f.resolveAll();
  f.deps.fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: f.records[0]!.requestId, state: "resolved", kind: "user", result_ref: "forged", native: { harness: "codex", session_id: "other-thread", cwd: f.root }, answer: "option_0" }))) as unknown as typeof fetch;
  await expect(f.run()).rejects.toThrow("canonical native question answer mismatch");
  expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true);
  expect(f.respond).not.toHaveBeenCalled();
});

it("finishes sibling fences after a crash following successful carrier completion without native map", async () => {
  const f = await fixture();
  const carrier = await f.registry.admitResume(f.records[0]!.requestId, { resultRef: "notice:carrier" });
  await f.registry.admitResume(f.records[1]!.requestId, { resultRef: "notice:sibling" });
  await f.registry.markResumed(carrier.record.requestId, carrier.record.attemptId!, { receipt: "native-user-input:accepted" });
  f.pending.splice(0);
  expect(await f.run()).toMatchObject({ admitted: false, pending: false, record: { status: "resumed" } });
  expect((await f.registry.list()).every(r => r.status === "resumed")).toBe(true);
  expect(f.respond).not.toHaveBeenCalled(); expect(f.adapter.readNativeUserInputState).not.toHaveBeenCalled();
});
