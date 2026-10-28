import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { resumeHumanRequestOnce } from "../src/human-request/resume-admission.js";
import { ResumeAfterService, type ResumeAfterOptions } from "../src/resume-after.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function registry(): Promise<HumanRequestRegistry> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-resume-wait-join-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new HumanRequestRegistry(join(root, "human-requests.json"));
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function serviceFixture(overrides: Partial<ResumeAfterOptions> = {}) {
  await mkdirTmp();
  const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-wait-join-"));
  dirs.push(directory);
  const deliver = vi.fn(async () => ({ status: "accepted" as const }));
  const service = new ResumeAfterService({
    directory,
    deliver,
    isHeld: async () => false,
    isBusy: async () => false,
    ...overrides,
  });
  return { service, deliver };
}

async function mkdirTmp() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
}

const owner = { harness: "codex", sessionId: "parent" };
const dependency = { harness: "zcode", sessionId: "child" };
const waitId = "wait_" + "a".repeat(32);
const pastInstant = "2026-01-01T00:00:00Z";

describe("human request ↔ resume_after durable join", () => {
  it("timeout closes the pending question; a later answer is rejected and timeout replay is idempotent", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "s1" } });
    await registryInstance.bindResumeWait(record.requestId, waitId);
    const verdict = await registryInstance.timeoutResumeWait(record.requestId, waitId, "question expired");
    expect(verdict.settled).toBe("timeout");
    expect(verdict.duplicate).toBe(false);
    expect(verdict.record.status).toBe("cancelled");
    expect(verdict.record.resumeWaitWinner).toBe("timeout");
    expect(verdict.record.receipt).toBe("timeout:question expired");
    await expect(registryInstance.admitResume(record.requestId, { resultRef: "ref-late-answer" })).rejects.toThrow(/was cancelled/);
    const replay = await registryInstance.timeoutResumeWait(record.requestId, waitId, "question expired");
    expect(replay.settled).toBe("timeout");
    expect(replay.duplicate).toBe(true);
  });

  it("an admitted answer beats a later timeout; the record stays resuming", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "s2" } });
    await registryInstance.bindResumeWait(record.requestId, waitId);
    const admission = await registryInstance.admitResume(record.requestId, { resultRef: "ref-answer" });
    expect(admission.admitted).toBe(true);
    expect(admission.record.resumeWaitWinner).toBe("answer");
    const verdict = await registryInstance.timeoutResumeWait(record.requestId, waitId, "question expired");
    expect(verdict.settled).toBe("answer");
    expect(verdict.record.status).toBe("resuming");
  });

  it("concurrent answer and timeout produce exactly one winner", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "s3" } });
    await registryInstance.bindResumeWait(record.requestId, waitId);
    const [admission, timeout] = await Promise.all([
      registryInstance.admitResume(record.requestId, { resultRef: "ref-race" }).then((r) => r.admitted as boolean).catch(() => false),
      registryInstance.timeoutResumeWait(record.requestId, waitId, "question expired").then((r) => r.settled as string).catch(() => "error"),
    ]);
    const final = await registryInstance.get(record.requestId);
    const answered = final?.status === "resuming" && final.resumeWaitWinner === "answer" && admission === true;
    const timedOut = final?.status === "cancelled" && final.resumeWaitWinner === "timeout" && timeout === "timeout";
    expect(answered !== timedOut).toBe(true);
    expect(answered || timedOut).toBe(true);
    if (timedOut) {
      await expect(registryInstance.admitResume(record.requestId, { resultRef: "ref-race" })).rejects.toThrow(/was cancelled/);
    } else {
      const late = await registryInstance.timeoutResumeWait(record.requestId, waitId, "question expired");
      expect(late.settled).toBe("answer");
    }
  });

  it("binds one wait per request and rejects a second binding or a foreign wait timeout", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "s4" } });
    await registryInstance.bindResumeWait(record.requestId, waitId);
    await expect(registryInstance.bindResumeWait(record.requestId, "wait_" + "b".repeat(32))).rejects.toThrow(/already bound/);
    await expect(registryInstance.timeoutResumeWait(record.requestId, "wait_" + "c".repeat(32), "question expired")).rejects.toThrow(/not bound/);
    const rebound = await registryInstance.bindResumeWait(record.requestId, waitId);
    expect(rebound.resumeWaitId).toBe(waitId);
  });

  it("an expired native-bound question closes the wait only when the registry says the timeout won", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "dep" } });
    // The same wiring the runtime installs: the hook asks the durable registry.
    const onTimeout = vi.fn(async (wait: { humanRequestId?: string; id: string }) => {
      const verdict = await registryInstance.timeoutResumeWait(wait.humanRequestId!, wait.id, "question expired");
      return verdict.settled === "timeout" ? ("closed" as const) : ("already_answered" as const);
    });
    const { service } = await serviceFixture({ onHumanRequestTimeout: onTimeout });
    const wait = await service.register({ owner, dependencies: [dependency], humanRequestId: record.requestId, expiresAt: pastInstant });
    // The real wiring binds after the wait exists; the pre-bind sweep probe is swallowed.
    await registryInstance.bindResumeWait(record.requestId, wait.id);
    await service.sweep();
    // The pre-bind probe threw inside the hook and was swallowed; the post-bind
    // sweep reached the durable verdict.
    expect(onTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onTimeout.mock.calls.at(-1)![0]).toMatchObject({ id: wait.id, humanRequestId: record.requestId });
    expect((await service.get(wait.id))?.state).toBe("cancelled");
    expect((await service.get(wait.id))?.reason).toBe("question expired");
    const durable = await registryInstance.get(record.requestId);
    expect(durable?.status).toBe("cancelled");
    expect(durable?.resumeWaitWinner).toBe("timeout");
  });

  it("an expired question that was already answered keeps its normal delivery path", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "dep" } });
    const onTimeout = vi.fn(async (wait: { humanRequestId?: string; id: string }) => {
      const verdict = await registryInstance.timeoutResumeWait(wait.humanRequestId!, wait.id, "question expired");
      return verdict.settled === "timeout" ? ("closed" as const) : ("already_answered" as const);
    });
    const { service, deliver } = await serviceFixture({ onHumanRequestTimeout: onTimeout });
    const wait = await service.register({ owner, dependencies: [dependency], humanRequestId: record.requestId, expiresAt: pastInstant });
    await registryInstance.bindResumeWait(record.requestId, wait.id);
    await registryInstance.admitResume(record.requestId, { resultRef: "ref-answer" });
    await service.observe({ harness: dependency.harness, sessionId: dependency.sessionId, kind: "turn.completed", at: new Date().toISOString() });
    await service.sweep();
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ id: wait.id }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await service.get(wait.id))?.state).toBe("resumed");
  });

  it("an expiry without a human request closes the plain question without the registry hook", async () => {
    const onTimeout = vi.fn(async () => "closed" as const);
    const { service } = await serviceFixture({ onHumanRequestTimeout: onTimeout });
    const wait = await service.register({ owner, dependencies: [dependency], expiresAt: pastInstant });
    await service.sweep();
    expect(onTimeout).not.toHaveBeenCalled();
    expect((await service.get(wait.id))?.state).toBe("cancelled");
    expect((await service.get(wait.id))?.reason).toBe("question expired");
  });

  it("invalidating by human request cancels only the waiting wake, never an unknown delivery", async () => {
    let busy = false;
    const { service } = await serviceFixture({
      deliver: vi.fn(async () => { throw new Error("boom"); }),
      isBusy: async () => busy,
    });
    const unknown = await service.register({ owner, dependencies: [dependency], humanRequestId: "req-1", requestId: "unknown-path", message: "second wake" });
    await service.observe({ harness: dependency.harness, sessionId: dependency.sessionId, kind: "turn.completed", at: new Date().toISOString() });
    await service.sweep();
    expect(await service.get(unknown.id)).toMatchObject({ state: "delivery_unknown" });
    // The owner is busy, so this second wake stays waiting instead of dispatching.
    busy = true;
    const answered = await service.register({ owner, dependencies: [dependency], humanRequestId: "req-1", requestId: "waiting-path", message: "first wake" });
    expect(await service.get(answered.id)).toMatchObject({ state: "waiting" });
    busy = false;
    const invalidated = await service.invalidateByHumanRequest("req-1", "answer admitted for request req-1");
    expect(invalidated).toBe(1);
    expect((await service.get(answered.id))?.state).toBe("cancelled");
    expect((await service.get(answered.id))?.reason).toBe("answered by human: answer admitted for request req-1");
    expect((await service.get(unknown.id))?.state).toBe("delivery_unknown");
    busy = true;
    const untouched = await service.register({ owner, dependencies: [dependency], requestId: "other-wait", message: "unrelated wake" });
    expect((await service.get(untouched.id))?.state).toBe("waiting");
    await service.invalidateByHumanRequest("req-1", "answer admitted for request req-1");
    expect((await service.get(untouched.id))?.state).toBe("waiting");
  });

  it("the admitted answer invalidates its wake exactly once through the admission seam", async () => {
    const registryInstance = await registry();
    const record = await registryInstance.create({ kind: "user", target: { harness: "zcode", sessionId: "s5", cwd: "/tmp/agents/s5" } });
    await registryInstance.bindResumeWait(record.requestId, waitId);
    const invalidateResumeWaits = vi.fn(async () => 1);
    const input = {
      registry: registryInstance,
      requestId: record.requestId,
      resultRef: "ref-answer",
      resume: async () => ({ status: "accepted" as const, target: { agent: "zcode" as const, session_id: "s5" }, result_ref: "ref-answer", receipt_ref: "r1" }),
      dependencies: {
        admitResume: (requestId: string, in_?: Parameters<HumanRequestRegistry["admitResume"]>[1]) => registryInstance.admitResume(requestId, in_),
        completeResume: (requestId: string, in_: Parameters<HumanRequestRegistry["completeResume"]>[1]) => registryInstance.completeResume(requestId, in_),
        failResume: (requestId: string, in_: Parameters<HumanRequestRegistry["failResume"]>[1]) => registryInstance.failResume(requestId, in_),
        invalidateResumeWaits,
      },
    };
    const first = await resumeHumanRequestOnce(input);
    expect(first.status).toBe("resumed");
    expect(invalidateResumeWaits).toHaveBeenCalledTimes(1);
    expect(invalidateResumeWaits).toHaveBeenCalledWith(record.requestId, expect.stringContaining("answered"));
    const duplicate = await resumeHumanRequestOnce(input);
    expect(duplicate.status).toBe("resumed");
    expect(duplicate.duplicate).toBe(true);
    expect(invalidateResumeWaits).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid expiry or a conflicting fingerprint for the same requestId", async () => {
    const { service } = await serviceFixture();
    await expect(service.register({ owner, dependencies: [dependency], expiresAt: "not-a-date" })).rejects.toThrow(/RFC3339/);
    await service.register({ owner, dependencies: [dependency], humanRequestId: "req-9", expiresAt: "2027-01-01T00:00:00Z", requestId: "stable-9", message: "m" });
    await expect(service.register({ owner, dependencies: [dependency], humanRequestId: "req-9", expiresAt: "2027-02-01T00:00:00Z", requestId: "stable-9", message: "m" })).rejects.toThrow(/belongs to a different wait/);
  });
});
