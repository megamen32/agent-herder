import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { asyncUserInputContextRef } from "../src/human-request/async-user-input-notice.js";
import { completeAsyncUserInputNotice } from "../src/human-request/async-user-input-completion.js";
import type { HarnessAdapter } from "../src/types/index.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "async-completion-")); roots.push(root);
  const registry = new HumanRequestRegistry(join(root, "requests.json"));
  const target = { hostId: "fixture-host", harness: "codex", sessionId: "fixture-thread", turnId: "terminal-turn", itemId: "questions-item" };
  const questions = [{ title: "Какой маршрут?", options: ["Первый", "Второй"] as string[] | null }, { title: "Комментарий?", options: null as string[] | null }];
  const fingerprint = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
  const records = await Promise.all([0, 1].map(questionIndex => registry.create({ kind: "user", answerSource: "notice_question", contextRef: asyncUserInputContextRef({ ...target, questionIndex, fingerprint }), target: { harness: "codex", sessionId: target.sessionId, cwd: root }, notify: { project: "fixture", recipient: "qa", kind: "human_request", severity: "important", title: "Тест" } })));
  const state = { target: { hostId: target.hostId, harness: "codex", sessionId: target.sessionId }, turnId: target.turnId, itemId: target.itemId, canRespond: true, questions };
  const readState = vi.fn(async () => state);
  const adapter = { getSession: vi.fn(async () => ({ id: target.sessionId, harness: "codex", hostId: target.hostId, cwd: root })), readAsyncUserInputState: readState, sendMessage: vi.fn() } as unknown as HarnessAdapter;
  const answers = new Map<string, string>();
  const refs = new Map(records.map(record => [record.requestId, randomUUID()]));
  const deps = { loadProducer: async () => ({ endpoint: "https://fixture.test/v1/human-requests", token: "fixture", project: "fixture", recipient: "qa", source: "ask_human_env" as const }), fetchImpl: vi.fn(async (url: any) => {
    const id = String(url).split("/").at(-2)!;
    return answers.has(id) ? new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: id, state: "resolved", kind: "user", result_ref: refs.get(id), native: { harness: "codex", session_id: target.sessionId, cwd: root }, answer: answers.get(id) })) : new Response("{}", { status: 409 });
  }) as unknown as typeof fetch };
  const resume = vi.fn(async (request: ResumeTransportRequest): Promise<ResumeReceipt> => ({ status: "accepted", target: request.target, result_ref: request.result_ref, idempotency_key: request.idempotency_key, receipt_ref: "fixture-accepted" }));
  const run = (index = 1) => completeAsyncUserInputNotice(registry, records[index]!, adapter, resume, deps);
  const resolveAll = () => { answers.set(records[0]!.requestId, "option_1"); answers.set(records[1]!.requestId, "Точный ответ"); };
  return { root, registry, records, adapter, state, readState, answers, refs, deps, resume, run, resolveAll };
}

it("waits for all canonical answers without admission", async () => {
  const f = await fixture(); f.answers.set(f.records[0]!.requestId, "option_1");
  expect(await f.run()).toMatchObject({ admitted: false, pending: true });
  expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true); expect(f.resume).not.toHaveBeenCalled();
});

it("continues exact same session once with all canonical answers and carrier idempotency", async () => {
  const f = await fixture(); f.resolveAll();
  expect(await f.run()).toMatchObject({ admitted: true, pending: false, record: { status: "resumed" } });
  const request = f.resume.mock.calls[0]![0];
  expect(request.target).toEqual({ agent: "codex", session_id: "fixture-thread", cwd: f.root });
  expect(JSON.parse(request.prompt!.split("\n").slice(1).join("\n"))).toEqual([{ question: "Какой маршрут?", answer: "Второй" }, { question: "Комментарий?", answer: "Точный ответ" }]);
  const carrier = await f.registry.get(f.records[0]!.requestId);
  expect(request.result_ref).toBe(f.refs.get(f.records[0]!.requestId)); expect(request.idempotency_key).toBe(carrier!.idempotencyKey);
  expect(request.human_requested_at).toBe(Date.parse(carrier!.admittedAt!));
  expect((await f.registry.list()).every(r => r.status === "resumed")).toBe(true);
  f.state.turnId = "next-turn"; f.readState.mockClear();
  expect(await f.run(0)).toMatchObject({ admitted: false, pending: false, record: { status: "resumed" } });
  expect(f.readState).not.toHaveBeenCalled(); expect(f.resume).toHaveBeenCalledTimes(1); expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it("admits only one carrier across concurrent sibling callbacks", async () => {
  const f = await fixture(); f.resolveAll(); await Promise.all([f.run(0), f.run(1)]);
  expect(f.resume).toHaveBeenCalledTimes(1); expect((await f.registry.list()).every(r => r.status === "resumed")).toBe(true);
});

it.each(["throw", "ambiguous"])("never replays %s continuation across a registry restart", async mode => {
  const f = await fixture(); f.resolveAll();
  f.resume.mockImplementationOnce(async request => { if (mode === "throw") throw new Error("receipt lost"); return { status: "ambiguous", target: request.target, result_ref: request.result_ref, reason: "unknown" }; });
  await f.run(); f.state.turnId = "new-turn"; f.readState.mockClear();
  const registry = new HumanRequestRegistry(join(f.root, "requests.json"));
  expect(await completeAsyncUserInputNotice(registry, f.records[0]!, f.adapter, f.resume, f.deps)).toMatchObject({ admitted: false, pending: false, record: { status: "resume_failed", resumeRetryable: false } });
  expect(f.resume).toHaveBeenCalledTimes(1); expect(f.readState).not.toHaveBeenCalled();
});

it("refuses stale newer user turn before any admission", async () => {
  const f = await fixture(); f.resolveAll(); f.state.turnId = "new-user-turn";
  await expect(f.run()).rejects.toThrow(); expect(f.resume).not.toHaveBeenCalled();
  expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true);
});

it("rechecks latest native source after sibling admissions immediately before resume", async () => {
  const f = await fixture(); f.resolveAll();
  const admit = f.registry.admitResume.bind(f.registry);
  vi.spyOn(f.registry, "admitResume").mockImplementation(async (id, input) => { const value = await admit(id, input); if (id === f.records[1]!.requestId) f.state.turnId = "new-user-turn"; return value; });
  expect(await f.run()).toMatchObject({ admitted: true, pending: false, record: { status: "resume_failed" } });
  expect(f.resume).not.toHaveBeenCalled(); expect((await f.registry.list()).every(r => r.status === "resume_failed" && r.resumeRetryable === false)).toBe(true);
});

it("never takes over an expired admitted carrier to send a second continuation", async () => {
  const f = await fixture(); f.resolveAll();
  await f.registry.admitResume(f.records[0]!.requestId, { resultRef: f.refs.get(f.records[0]!.requestId), now: new Date("2020-01-01"), leaseMs: 1000 });
  f.state.turnId = "new-turn";
  expect(await f.run()).toMatchObject({ admitted: false, pending: true }); expect(f.resume).not.toHaveBeenCalled(); expect(f.readState).not.toHaveBeenCalled();
});
