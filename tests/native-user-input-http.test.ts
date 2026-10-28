import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { nativeUserInputContextRef } from "../src/human-request/native-user-input-notice.js";
import { createWebServer } from "../src/web/server.js";
import type { ControlResult, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
const servers: Server[] = [];
const envKeys = ["ASK_HUMAN_ENV_FILE", "AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-native-input-http-")); roots.push(root);
  const envFile = join(root, "fixture-producer.env");
  const bindingsFile = join(root, "bindings.json");
  await writeFile(envFile, "ASK_HUMAN_URL=https://native-notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=isolated-fixture-token\nNOTIFY_CENTER_PROJECT=http-fixture\nNOTIFY_CENTER_RECIPIENT=isolated-qa\nASK_HUMAN_ALLOWED_ACTORS=telegram:isolated-fixture\n", { mode: 0o600 });
  const target = { hostId: "http-fixture-host", harness: "codex", sessionId: "http-fixture-thread", nativeRequestId: "http-native-request" };
  await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [{ target: { hostId: target.hostId, harness: target.harness, sessionId: target.sessionId }, askHumanEnvFile: envFile }] }), { mode: 0o600 });
  process.env.ASK_HUMAN_ENV_FILE = envFile;
  process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE = bindingsFile;
  const registry = new HumanRequestRegistry(join(root, "requests.json"));
  const records = await Promise.all(["a", "b"].map(questionId => registry.create({ kind: "user", answerSource: "notice_question", target: { harness: target.harness, sessionId: target.sessionId, cwd: root }, contextRef: nativeUserInputContextRef({ ...target, questionId }), notify: { project: "http-fixture", recipient: "isolated-qa", kind: "human_request", severity: "important", title: "Изолированная проверка" } })));
  const pendingRequests = [{ id: target.nativeRequestId, turnId: "http-turn", itemId: "http-item", canRespond: true, questions: [{ id: "b", question: "Комментарий" }, { id: "a", question: "Маршрут", options: [{ label: "Один" }, { label: "Два" }] }] }];
  const nativeReply = vi.fn(async (_session: string, _request: string, _answers: Record<string, { answers: string[] }>): Promise<ControlResult> => { pendingRequests.splice(0); return { ok: true, admission: "accepted", admitted: true }; });
  const readState = vi.fn(async () => ({ target: { hostId: target.hostId, harness: target.harness, sessionId: target.sessionId }, pendingRequests }));
  const adapter = { type: "codex", name: "http-fixture", init: async () => {}, getSession: async () => ({ id: target.sessionId, hostId: target.hostId, harness: "codex", cwd: root, status: "needs_input", lastActivity: new Date().toISOString() }), readNativeUserInputState: readState, respondNativeUserInput: nativeReply, sendMessage: vi.fn(async () => { throw new Error("generic send forbidden"); }) } as unknown as HarnessAdapter;
  const answers = new Map<string, string>();
  const resultRefs = new Map(records.map(record => [record.requestId, randomUUID()]));
  let forgedNativeBinding = false;
  const canonicalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = String(input).split("/").at(-2)!;
    expect(String(input)).toBe(`https://native-notice.test/v1/human-requests/${id}/result`);
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer isolated-fixture-token");
    if (!answers.has(id)) return new Response("{}", { status: 409 });
    return new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: id, state: "resolved", kind: "user", result_ref: resultRefs.get(id), answer: answers.get(id), native: { harness: "codex", session_id: forgedNativeBinding ? "other-session" : target.sessionId, cwd: root } }));
  });
  const humanResume = vi.fn(async () => { throw new Error("generic humanResume forbidden"); });
  const server = createWebServer({ adapters: new Map([["codex", adapter]]), converter: { async convert() { throw new Error("unused"); } }, humanRequests: registry, humanResume: humanResume as any, noticeAnswerFetch: canonicalFetch, sessionObservationManagedExternally: true });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const post = (index: number) => fetch(`http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: records[index]!.requestId, result_ref: randomUUID(), answer: "forged callback text" }) });
  const resolveAll = () => { answers.set(records[0]!.requestId, "option_1"); answers.set(records[1]!.requestId, "Canonical comment"); };
  return { records, resultRefs, registry, pendingRequests, nativeReply, readState, answers, canonicalFetch, humanResume, adapter, post, resolveAll, forge: () => { forgedNativeBinding = true; } };
}

it("HTTP waits for canonical siblings then writes exact RPC once and acknowledges duplicates after native map removal", async () => {
  const f = await fixture(); f.answers.set(f.records[0]!.requestId, "option_1");
  const partial = await f.post(0);
  expect(partial.status).toBe(503); expect(await partial.json()).toMatchObject({ status: "pending", retry: true, continuation: "native_user_input" });
  expect(f.nativeReply).not.toHaveBeenCalled(); expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true);
  f.resolveAll(); const completed = await f.post(1);
  expect(completed.status).toBe(202); expect(await completed.json()).toMatchObject({ status: "resumed", retry: false, continuation: "native_user_input" });
  expect(f.nativeReply).toHaveBeenCalledExactlyOnceWith("http-fixture-thread", "http-native-request", { a: { answers: ["Два"] }, b: { answers: ["Canonical comment"] } });
  expect(f.pendingRequests).toHaveLength(0); f.readState.mockClear(); f.canonicalFetch.mockClear();
  const duplicate = await f.post(0);
  expect(duplicate.status).toBe(202); expect(await duplicate.json()).toMatchObject({ status: "resumed", duplicate: true, retry: false });
  expect(f.readState).not.toHaveBeenCalled(); expect(f.canonicalFetch).not.toHaveBeenCalled(); expect(f.nativeReply).toHaveBeenCalledTimes(1);
  expect((await f.registry.list()).map(r => r.resultRef)).toEqual(f.records.map(r => f.resultRefs.get(r.requestId)));
  expect(f.humanResume).not.toHaveBeenCalled(); expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it.each(["unknown", "throw"])("HTTP preserves ambiguous %s no-replay across duplicate callback", async mode => {
  const f = await fixture(); f.resolveAll();
  f.nativeReply.mockImplementationOnce(async () => { f.pendingRequests.splice(0); if (mode === "throw") throw new Error("receipt lost"); return { ok: false, admission: "unknown", admissionUnknown: true }; });
  const first = await f.post(1); expect(first.status).toBe(502);
  expect(await first.json()).toMatchObject({ status: "resume_failed", retry: false });
  const duplicate = await f.post(0); expect(duplicate.status).toBe(502);
  expect(await duplicate.json()).toMatchObject({ status: "resume_failed", duplicate: true, retry: false });
  expect(f.nativeReply).toHaveBeenCalledTimes(1); expect(f.humanResume).not.toHaveBeenCalled(); expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  expect((await f.registry.list()).every(r => r.status === "resume_failed" && r.resumeRetryable === false)).toBe(true);
});

it("HTTP rejects forged canonical native identity without admitting a response", async () => {
  const f = await fixture(); f.resolveAll(); f.forge();
  const response = await f.post(0); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ status: "pending", retry: true });
  expect(f.nativeReply).not.toHaveBeenCalled(); expect(f.humanResume).not.toHaveBeenCalled();
  expect((await f.registry.list()).every(r => r.status === "pending")).toBe(true);
});
