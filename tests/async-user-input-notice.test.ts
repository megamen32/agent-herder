import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { createAsyncUserInputNoticeObserver, collectCanonicalAsyncUserInputAnswers, parseAsyncUserInputContextRef } from "../src/human-request/async-user-input-notice.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "async-input-notice-")); roots.push(root);
  const registry = new HumanRequestRegistry(join(root, "requests.json"));
  const session: AgentSession = { id: "thread", harness: "codex", hostId: "fixture-host", cwd: root, status: "idle", title: "Тестовый агент", lastActivity: new Date().toISOString() };
  const state = { target: { hostId: session.hostId, harness: "codex", sessionId: session.id }, turnId: "turn", itemId: "item", canRespond: true,
    questions: [{ title: "Какой маршрут?", options: ["Первый", "Второй"] as string[] | null }, { title: "Комментарий?", options: null as string[] | null }] };
  const adapter = { type: "codex", name: "fixture", init: async () => {}, getSession: async () => session,
    readAsyncUserInputState: vi.fn(async () => state), sendMessage: vi.fn() } as unknown as HarnessAdapter;
  const producer = { endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "fixture", recipient: "qa", source: "ask_human_env" as const };
  const posts: any[] = []; const resolved = new Map<string, string>();
  let duringGet: (() => void) | undefined;
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body); posts.push(body);
      return new Response(JSON.stringify({ schema: "ask_human.response.v1", request_id: body.request_id, state: "pending", kind: "user", project: "fixture", recipient: "qa", mode: body.mode, choices: body.choices ?? [],
        native_harness: "codex", native_session_id: session.id, native_cwd: root, telegram: { status: "sent", chat_id: "isolated-fixture", message_id: posts.length } }), { status: 201 });
    }
    duringGet?.();
    const id = String(url).split("/").at(-2)!;
    if (!resolved.has(id)) return new Response("{}", { status: 409 });
    return new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: id, state: "resolved", kind: "user", result_ref: `notice:${id}`, native: { harness: "codex", session_id: session.id, cwd: root }, answer: resolved.get(id) }));
  }) as unknown as typeof fetch;
  return { registry, session, adapter, state, posts, resolved, deps: { loadProducer: async () => producer, fetchImpl }, setDuringGet: (value: () => void) => { duringGet = value; } };
}

it("delivers idle persisted questions once across reconciles/events and observer restarts", async () => {
  const f = await fixture(); const observer = createAsyncUserInputNoticeObserver(f.registry, f.deps);
  expect(await observer.reconcileInitialSnapshot(f.adapter, [f.session])).toBe(true);
  await createAsyncUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  await observer.onEvent(f.adapter, { kind: "turn.completed", harness: "codex", sessionId: f.session.id, nativeType: "turn/completed" });
  expect(f.posts).toHaveLength(2);
  expect(f.posts[0].choices).toEqual([{ value: "option_0", label: "Первый" }, { value: "option_1", label: "Второй" }]);
  expect((await f.registry.list()).map(record => parseAsyncUserInputContextRef(record.contextRef)?.questionIndex)).toEqual([0, 1]);
  expect((await f.registry.list()).every(record => record.noticeDelivery?.state === "accepted")).toBe(true);
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("collects canonical sibling answers in index order and maps choices to native labels", async () => {
  const f = await fixture(); await createAsyncUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  const records = await f.registry.list(); f.resolved.set(records[0]!.requestId, "option_1");
  expect(await collectCanonicalAsyncUserInputAnswers(f.registry, records[0]!, f.adapter, f.deps)).toBeNull();
  f.resolved.set(records[1]!.requestId, "Дополнение");
  const result = await collectCanonicalAsyncUserInputAnswers(f.registry, records[1]!, f.adapter, f.deps);
  expect(result?.answers).toEqual([{ question: "Какой маршрут?", answer: "Второй" }, { question: "Комментарий?", answer: "Дополнение" }]);
  expect(result?.carrier.requestId).toBe(records[0]!.requestId);
  expect(result?.siblings).toHaveLength(2);
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("preserves ambiguous delivery no-replay and redacts secret-looking source text", async () => {
  const f = await fixture(); f.state.questions[0]!.title = "Проверить token=superprivatevalue?";
  const deps = { ...f.deps, fetchImpl: vi.fn(async () => { throw new Error("unknown admission"); }) as unknown as typeof fetch };
  await createAsyncUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  await createAsyncUserInputNoticeObserver(f.registry, deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  expect((await f.registry.list()).every(record => record.noticeDelivery?.state === "unknown")).toBe(true);
  expect(JSON.stringify((deps.fetchImpl as any).mock.calls)).not.toContain("superprivatevalue");
});

it("rejects cross-host delivery and stale question fingerprints including during canonical reads", async () => {
  const f = await fixture(); const observer = createAsyncUserInputNoticeObserver(f.registry, f.deps);
  f.state.target.hostId = "foreign";
  expect(await observer.reconcileInitialSnapshot(f.adapter, [f.session])).toBe(false);
  expect(f.posts).toHaveLength(0);
  f.state.target.hostId = f.session.hostId; await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  const records = await f.registry.list(); for (const record of records) f.resolved.set(record.requestId, parseAsyncUserInputContextRef(record.contextRef)?.questionIndex === 0 ? "option_0" : "text");
  f.setDuringGet(() => { f.state.questions[0]!.title = "Changed"; });
  await expect(collectCanonicalAsyncUserInputAnswers(f.registry, records[0]!, f.adapter, f.deps)).rejects.toThrow("changed");
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("does not send a card when the exact cwd changes after the durable claim", async () => {
  const f = await fixture();
  const claim = f.registry.claimNoticeDelivery.bind(f.registry);
  vi.spyOn(f.registry, "claimNoticeDelivery").mockImplementation(async (...args) => {
    const result = await claim(...args); f.session.cwd += "/changed"; return result;
  });
  await createAsyncUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(f.posts).toHaveLength(0);
});

it("rejects a canonical choice outside the offered option IDs", async () => {
  const f = await fixture();
  await createAsyncUserInputNoticeObserver(f.registry, f.deps).reconcileInitialSnapshot(f.adapter, [f.session]);
  const records = await f.registry.list(); f.resolved.set(records[0]!.requestId, "invented_option");
  await expect(collectCanonicalAsyncUserInputAnswers(f.registry, records[0]!, f.adapter, f.deps)).rejects.toThrow("not an offered option");
});

it("joins concurrent snapshots and caches unchanged positive reads while typed events bypass TTL", async () => {
  const f = await fixture(); const observer = createAsyncUserInputNoticeObserver(f.registry, f.deps);
  const read = (f.adapter as any).readAsyncUserInputState;
  await Promise.all([observer.reconcileInitialSnapshot(f.adapter, [f.session]), observer.reconcileInitialSnapshot(f.adapter, [f.session]),
    observer.onEvent(f.adapter, { kind: "message.updated", harness: "codex", sessionId: f.session.id, nativeType: "agentMessage/questions" })]);
  expect(f.posts).toHaveLength(2);
  const calls = read.mock.calls.length;
  expect(calls).toBe(5); // one discovery plus fresh checks before each creation/delivery
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(read).toHaveBeenCalledTimes(calls);
  await observer.onEvent(f.adapter, { kind: "message.updated", harness: "codex", sessionId: f.session.id, nativeType: "agentMessage/questions" });
  expect(read.mock.calls.length).toBeGreaterThan(calls);
  const eventCalls = read.mock.calls.length;
  f.session.lastActivity = "2099-01-01T00:00:00.000Z";
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(read.mock.calls.length).toBeGreaterThan(eventCalls);
  expect(f.posts).toHaveLength(2);
});

it("retries a negative read after activity change or at most60 seconds", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await fixture(); const observer = createAsyncUserInputNoticeObserver(f.registry, f.deps);
  const read = (f.adapter as any).readAsyncUserInputState;
  read.mockResolvedValue(null);
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(read).toHaveBeenCalledTimes(1);
  f.session.lastActivity = "2099-01-01T00:00:00.000Z";
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(read).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 60_001);
  await observer.reconcileInitialSnapshot(f.adapter, [f.session]);
  expect(read).toHaveBeenCalledTimes(3);
});

it("bounds native snapshot discovery to four sessions at once", async () => {
  const f = await fixture(); const observer = createAsyncUserInputNoticeObserver(f.registry, f.deps);
  let active = 0; let maximum = 0;
  (f.adapter as any).readAsyncUserInputState.mockImplementation(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--; return null;
  });
  await observer.reconcileInitialSnapshot(f.adapter, Array.from({ length: 11 }, (_, index) => ({ ...f.session, id: `thread-${index}` })));
  expect(maximum).toBe(4);
});
