import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { createNativeUserInputNoticeObserver, collectCanonicalNativeUserInputAnswers, parseNativeUserInputContextRef } from "../src/human-request/native-user-input-notice.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-input-notice-")); roots.push(root);
  const registry = new HumanRequestRegistry(join(root, "requests.json"));
  const session: AgentSession = { id: "thread-1", harness: "codex", hostId: "fixture-host", cwd: root, status: "needs_input", title: "Тестовый агент", lastActivity: new Date().toISOString() };
  const questions = [{ id: "q1", header: "Маршрут", question: "Какой вариант выбрать?", options: [{ label: "Первый", description: "Один" }, { label: "Второй", description: "Два" }], isSecret: false },
    { id: "q2", header: "Комментарий", question: "Что добавить?", options: null, isSecret: false }];
  const state = { target: { hostId: session.hostId, harness: "codex", sessionId: session.id }, pendingRequests: [{ id: "request-1", requestId: "request-1", turnId: "turn-1", itemId: "item-1", canRespond: true, questions }], observedAt: new Date().toISOString(), coldRestoreSupported: false };
  const adapter = { type: "codex", name: "fixture", init: async () => {}, getSession: async () => session, readNativeUserInputState: async () => state,
    sendMessage: vi.fn(), respondNativeUserInput: vi.fn() } as unknown as HarnessAdapter;
  const producer = { endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "fixture", recipient: "qa", source: "ask_human_env" as const };
  const posts: any[] = []; const resolved = new Map<string, string>();
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body); posts.push(body);
      return new Response(JSON.stringify({ schema: "ask_human.response.v1", request_id: body.request_id, state: "pending", kind: "user", project: "fixture", recipient: "qa", mode: body.mode, choices: body.choices ?? [],
        native_harness: "codex", native_session_id: session.id, native_cwd: root, telegram: { status: "sent", chat_id: "isolated-fixture", message_id: posts.length } }), { status: 201 });
    }
    const id = String(url).split("/").at(-2)!;
    if (!resolved.has(id)) return new Response("{}", { status: 409 });
    return new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: id, state: "resolved", kind: "user", result_ref: `notice:${id}`, native: { harness: "codex", session_id: session.id, cwd: root }, answer: resolved.get(id) }));
  }) as unknown as typeof fetch;
  const deps = { loadProducer: async () => producer, fetchImpl };
  return { registry, session, adapter, state, posts, resolved, deps, fetchImpl };
}

it("reconciles native pending questions after boot into one exact Telegram card each without duplicate deliveries", async () => {
  const f = await fixture();
  const observer = createNativeUserInputNoticeObserver(f.registry, f.deps);
  expect(await observer.reconcileInitialSnapshot(f.adapter, [f.session])).toBe(true);
  await createNativeUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  await observer.onEvent(f.adapter, { kind: "message.updated", harness: "codex", sessionId: f.session.id, nativeType: "item/tool/requestUserInput" });
  expect(f.posts).toHaveLength(2);
  const records = await f.registry.list(); expect(records).toHaveLength(2);
  expect(records.map(r => parseNativeUserInputContextRef(r.contextRef)?.questionId).sort()).toEqual(["q1", "q2"]);
  expect(records.every(r => r.noticeDelivery?.state === "accepted")).toBe(true);
  expect(f.posts[0].choices).toEqual([{ value: "option_0", label: "Первый" }, { value: "option_1", label: "Второй" }]);
  expect(f.posts[1].mode).toBe("question");
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("waits for all canonical sibling answers and returns exact native answers without auto selection or native invocation", async () => {
  const f = await fixture(); await createNativeUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  const records = await f.registry.list();
  const first = records.find(r => parseNativeUserInputContextRef(r.contextRef)?.questionId === "q1")!;
  const second = records.find(r => r !== first)!;
  f.resolved.set(first.requestId, "option_1");
  expect(await collectCanonicalNativeUserInputAnswers(f.registry, first, f.adapter, f.deps)).toBeNull();
  f.resolved.set(second.requestId, "Комментарий владельца");
  const result = await collectCanonicalNativeUserInputAnswers(f.registry, second, f.adapter, f.deps);
  expect(result?.answers).toEqual({ q1: { answers: ["Второй"] }, q2: { answers: ["Комментарий владельца"] } });
  expect(result?.carrier.requestId).toBe(first.requestId);
  expect(result?.siblings).toHaveLength(2);
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  expect((f.adapter as any).respondNativeUserInput).not.toHaveBeenCalled();
  f.state.pendingRequests[0]!.canRespond = false;
  await expect(collectCanonicalNativeUserInputAnswers(f.registry, first, f.adapter, f.deps)).rejects.toThrow("not actionable");
});

it("preserves UNKNOWN no-replay across observer restarts", async () => {
  const f = await fixture(); const fetchImpl = vi.fn(async () => { throw new Error("lost response after admission"); }) as unknown as typeof fetch;
  const deps = { ...f.deps, fetchImpl };
  await createNativeUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  await createNativeUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect((await f.registry.list()).every(r => r.noticeDelivery?.state === "unknown")).toBe(true);
});

it("retains the definite HTTP rejection status without reopening its delivery fence", async () => {
  const f = await fixture();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid bearer token" }), { status: 401 })) as unknown as typeof fetch;
  const deps = { ...f.deps, fetchImpl };
  await createNativeUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  await createNativeUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect((await f.registry.list()).every(record => record.noticeDelivery?.state === "unknown" && record.noticeDelivery.httpStatus === 401)).toBe(true);
});

it("does not expose secret questions or deliver a stale/cross-host binding", async () => {
  const f = await fixture(); f.state.pendingRequests[0]!.questions.forEach(q => { q.isSecret = true; });
  expect(await createNativeUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session])).toBe(true);
  expect(f.posts).toHaveLength(0);
  f.state.target.hostId = "other-host";
  expect(await createNativeUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session])).toBe(false);
  expect(f.posts).toHaveLength(0);
});
