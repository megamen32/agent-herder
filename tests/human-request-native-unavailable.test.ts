import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry, resumeHumanRequestOnce } from "../src/human-request/index.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";
import { createWebServer } from "../src/web/server.js";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "herder-native-unavailable-"));
  directories.push(dir);
  const path = join(dir, "requests.json");
  const registry = new HumanRequestRegistry(path);
  const record = await registry.create({ kind: "user", target: { agent: "opencode", sessionId: "original", cwd: dir }, answerSource: "notice_question" });
  const resultRef = randomUUID();
  return { path, registry, record, resultRef };
}

const unavailable = async (request: ResumeTransportRequest): Promise<ResumeReceipt> => ({ status: "failed", reason: "native-unavailable", target: request.target, result_ref: request.result_ref, idempotency_key: request.idempotency_key });
const accepted = async (request: ResumeTransportRequest): Promise<ResumeReceipt> => ({ status: "accepted", receipt_ref: "native://one", target: request.target, result_ref: request.result_ref, idempotency_key: request.idempotency_key });

it("re-admits only the canonical unavailable answer atomically after restart, keeping key, target and answer time", async () => {
  const f = await fixture();
  const original = await resumeHumanRequestOnce({ registry: f.registry, requestId: f.record.requestId, resultRef: f.resultRef, resume: unavailable });
  expect(original).toMatchObject({ status: "resume_failed", receipt: "agent-resume:native-unavailable", retry: true });
  const resume = vi.fn(accepted);
  const restarted = new HumanRequestRegistry(f.path);
  const conflict = await resumeHumanRequestOnce({ registry: restarted, requestId: f.record.requestId, resultRef: randomUUID(), resume });
  expect(conflict).toMatchObject({ status: "resume_failed", retry: false });
  expect(resume).not.toHaveBeenCalled();
  const outputs = await Promise.all(Array.from({ length: 5 }, () => resumeHumanRequestOnce({ registry: new HumanRequestRegistry(f.path), requestId: f.record.requestId, resultRef: f.resultRef, resume })));
  expect(outputs.every((outcome) => outcome.status === "resumed" || outcome.status === "in_flight")).toBe(true);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0][0]).toMatchObject({ result_ref: f.resultRef, idempotency_key: original.idempotencyKey, target: { agent: "opencode", session_id: "original", cwd: f.record.target.cwd }, human_requested_at: Date.parse(original.record.admittedAt!) });
  expect((await restarted.get(f.record.requestId))?.attemptId).toBe(original.record.attemptId);
});

it("never re-invokes an unknown admission or an expired in-flight transport", async () => {
  const f = await fixture();
  const resume = vi.fn(async (request: ResumeTransportRequest): Promise<ResumeReceipt> => ({ status: "ambiguous", reason: "native-unavailable", target: request.target, result_ref: request.result_ref }));
  await resumeHumanRequestOnce({ registry: f.registry, requestId: f.record.requestId, resultRef: f.resultRef, resume });
  await resumeHumanRequestOnce({ registry: new HumanRequestRegistry(f.path), requestId: f.record.requestId, resultRef: f.resultRef, resume });
  expect(resume).toHaveBeenCalledTimes(1);
  const other = await fixture();
  await other.registry.admitResume(other.record.requestId, { resultRef: other.resultRef });
  const outcome = await resumeHumanRequestOnce({ registry: other.registry, requestId: other.record.requestId, resultRef: other.resultRef, resume, now: new Date(Date.now() + 600_000) });
  expect(outcome.status).toBe("in_flight");
  expect(resume).toHaveBeenCalledTimes(1);
});

it("recovers a historical definite native-unavailable receipt without replacing its answer", async () => {
  const f = await fixture();
  const admitted = await f.registry.admitResume(f.record.requestId, { resultRef: f.resultRef });
  await f.registry.failResume(f.record.requestId, { attemptId: admitted.record.attemptId!, receipt: "agent-resume:native-unavailable" });
  const resume = vi.fn(accepted);
  const outcome = await resumeHumanRequestOnce({ registry: new HumanRequestRegistry(f.path), requestId: f.record.requestId, resultRef: f.resultRef, resume });
  expect(outcome).toMatchObject({ status: "resumed", idempotencyKey: admitted.idempotencyKey });
  expect(resume).toHaveBeenCalledTimes(1);
});

it("does not let an old unavailable query receipt reopen a live restored admission", async () => {
  const f = await fixture();
  await resumeHumanRequestOnce({ registry: f.registry, requestId: f.record.requestId, resultRef: f.resultRef, resume: unavailable });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const resume = vi.fn(async (request: ResumeTransportRequest) => { entered(); await gate; return accepted(request); });
  const restored = resumeHumanRequestOnce({ registry: f.registry, requestId: f.record.requestId, resultRef: f.resultRef, resume });
  await started;
  try {
    const duplicate = await resumeHumanRequestOnce({ registry: new HumanRequestRegistry(f.path), requestId: f.record.requestId, resultRef: f.resultRef, resume, queryReceipt: unavailable });
    expect(duplicate.status).toBe("in_flight");
    expect((await resumeHumanRequestOnce({ registry: f.registry, requestId: f.record.requestId, resultRef: f.resultRef, resume })).status).toBe("in_flight");
    expect(resume).toHaveBeenCalledTimes(1);
  } finally { release(); await restored; }
});

it("returns the production HTTP retry receipt, then resumes the same answer once after native recovery", async () => {
  const f = await fixture();
  let restored = false;
  const resume = vi.fn((request: ResumeTransportRequest) => restored ? accepted(request) : unavailable(request));
  const server = createWebServer({ adapters: new Map(), converter: { async convert() { throw new Error("unused"); } }, humanRequests: f.registry, humanResume: resume, sessionObservationManagedExternally: true });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/human-requests/ask-user-completion`;
  const body = JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: f.record.requestId, result_ref: f.resultRef });
  const post = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
  const failed = await post();
  expect(failed.status).toBe(502);
  expect(await failed.json()).toMatchObject({ request_id: f.record.requestId, status: "resume_failed", continuation: "resume", reason: "agent-resume:native-unavailable", retry: true });
  restored = true;
  for (let i = 0; i < 2; i++) {
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ request_id: f.record.requestId, status: "resumed" });
  }
  expect(resume).toHaveBeenCalledTimes(2);
  expect(resume.mock.calls[1][0]).toEqual(resume.mock.calls[0][0]);
});
