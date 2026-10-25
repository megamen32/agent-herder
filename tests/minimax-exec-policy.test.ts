import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery, verifyDurableUserDeliveryClaim } from "../src/user-message-delivery.js";
import type { SendMessageOptions } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";
import { localSessionHostId, type HarnessAdapter } from "../src/types/index.js";
import { MinimaxExecPolicyConflict, MinimaxExecPolicyStore } from "../src/permission-control/minimax-exec-policy.js";

const directories: string[] = [];
const inspectorSource = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herder-minimax-exec-policy-"));
  directories.push(directory);
  return new MinimaxExecPolicyStore(directory);
}
afterEach(async () => { while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }); });

describe("MiniMax Herder CLI execution policy", () => {
  it("labels the configured CLI policy separately from unknown native session mode", () => {
    expect(inspectorSource).toContain("Текущий native режим</span><strong>неизвестен");
    expect(inspectorSource).toContain("Для новых запусков через Herder");
    expect(inspectorSource).toContain("Политика применяется только к точному MiniMax CLI fallback");
    expect(inspectorSource).toContain("Herder не переключает транспорт молча");
  });

  it("keeps native mode separate and uses an exact target with CAS revisions", async () => {
    const store = await fixture();
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId: "mvs_policy_1" };
    const initial = await store.withSnapshot(target, policy => policy);
    expect(initial).toMatchObject({ target, scope: "next_herder_cli_exec", mode: "unset", revision: 0 });

    const configured = await store.update(target, initial.revision, "full");
    expect(configured).toMatchObject({ target, scope: "next_herder_cli_exec", mode: "full", revision: 1 });
    await expect(store.update(target, 0, "off")).rejects.toBeInstanceOf(MinimaxExecPolicyConflict);

    const another = await store.withSnapshot({ ...target, sessionId: "mvs_policy_2" }, policy => policy);
    expect(another).toMatchObject({ mode: "unset", revision: 0 });
  });

  it("serializes an admission snapshot with concurrent policy updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-lock-"));
    directories.push(directory);
    const store = new MinimaxExecPolicyStore(directory);
    const otherProcess = new MinimaxExecPolicyStore(directory);
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId: "mvs_policy_lock" };
    let admitted!: () => void;
    let release!: () => void;
    const admittedWait = new Promise<void>(resolve => { admitted = resolve; });
    const releaseWait = new Promise<void>(resolve => { release = resolve; });
    const jobId = `job_${"a".repeat(64)}`;
    const admission = store.withSnapshot(target, async (policy, reserve) => {
      await reserve(jobId);
      admitted();
      await releaseWait;
      return policy;
    });
    await admittedWait;
    const update = otherProcess.update(target, 0, "full");
    release();
    expect(await admission).toMatchObject({ mode: "unset", revision: 0 });
    await expect(update).rejects.toBeInstanceOf(MinimaxExecPolicyConflict);
    await otherProcess.releaseAdmission(target, jobId);
    expect(await otherProcess.update(target, 0, "full")).toMatchObject({ mode: "full", revision: 1 });
  });

  it("reconciles crash and failed-release markers only after durable and native idle proof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-reconcile-"));
    directories.push(directory);
    const policyDirectory = join(directory, "policy");
    const store = new MinimaxExecPolicyStore(policyDirectory);
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId: "mvs_policy_reconcile" };
    const missingJob = `job_${"b".repeat(64)}`;
    const terminalJob = `job_${"c".repeat(64)}`;
    await store.withSnapshot(target, async (_policy, reserve) => { await reserve(missingJob); await reserve(terminalJob); });
    const policyFile = join(policyDirectory, `${createHash("sha256").update(`${target.hostId}\0${target.harness}\0${target.sessionId}`).digest("hex")}.json`);
    expect(JSON.parse(await readFile(policyFile, "utf8")).activeJobs).toEqual([missingJob, terminalJob]);
    const proof = vi.fn()
      .mockRejectedValueOnce(new Error("native read unavailable"))
      .mockResolvedValueOnce({ hostId: "local", harness: "minimax-code", sessionId: target.sessionId, idle: false, reason: "live lease" })
      .mockResolvedValue({ hostId: "local", harness: "minimax-code", sessionId: target.sessionId, idle: true });
    const adapter = { getNativeIdleAdmissionProof: proof };
    const jobs = { get: (id: string) => id === terminalJob ? { id, state: "completed" } : null, list: () => [] };
    const delivery = new UserMessageDelivery(new Map([["minimax-code", adapter as never]]), { sendMessage: vi.fn() }, jobs as never,
      { pollMs: 1, maxWaitMs: 500, maxPending: 2 }, store);
    try {
      await expect(delivery.setMinimaxExecPolicy(target, 0, "full")).rejects.toThrow(/Could not read exact MiniMax lease state/);
      await expect(delivery.setMinimaxExecPolicy(target, 0, "full")).rejects.toThrow(/live lease/);
      expect(await delivery.getMinimaxExecPolicy(target)).toMatchObject({ mode: "unset", revision: 0 });
      await expect(delivery.setMinimaxExecPolicy(target, 0, "full")).resolves.toMatchObject({ mode: "full", revision: 1 });
      expect(proof).toHaveBeenCalledTimes(3);
    } finally { delivery.close(); }
  });

  it("fingerprints the saved policy before job start and blocks policy changes until terminal receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-exec-policy-jobs-"));
    directories.push(directory);
    const store = new MinimaxExecPolicyStore(join(directory, "policy"));
    const sessionId = "mvs_delivery_policy";
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId };
    await store.update(target, 0, "full");
    let releaseSend!: (result: { ok: boolean; admitted: boolean; turnId: string }) => void;
    let observedOptions: SendMessageOptions | undefined;
    const sendStarted = vi.fn();
    const adapter = {
      getSession: vi.fn(async (id: string) => ({ id, harness: "minimax-code", hostId: "local", status: "idle", cwd: "/tmp" })),
      sendMessage: vi.fn(),
    };
    const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(directory, "jobs.json") });
    const delivery = new UserMessageDelivery(new Map([["minimax-code", adapter as never]]), {
      sendMessage: async (_harness, _sessionId, options) => {
        sendStarted();
        observedOptions = options;
        return new Promise(resolve => { releaseSend = resolve; });
      },
    }, jobs, { pollMs: 1, maxWaitMs: 5_000, maxPending: 4 }, store);
    try {
      const input = { harness: "minimax-code", sessionId, inputId: "policy-bound-input", message: "benign", mode: "queue" as const };
      const receipt = await delivery.submitMinimaxExecPolicy(input);
      expect(receipt.delivery).toBe("deferred");
      await vi.waitFor(() => expect(sendStarted).toHaveBeenCalledOnce());
      expect(observedOptions?.durableUserDelivery?.minimaxExecPolicy).toEqual({ mode: "full", revision: 1 });
      expect(observedOptions?.durableUserDelivery?.requestFingerprint).toBe(receipt.job?.requestFingerprint);
      const claim = observedOptions!.durableUserDelivery!;
      const binding = { jobId: claim.jobId, inputId: claim.inputId, requestFingerprint: claim.requestFingerprint,
        harness: claim.harness, sessionId: claim.sessionId, targetHostId: "local", mode: claim.mode, minimaxExecPolicy: claim.minimaxExecPolicy };
      expect(verifyDurableUserDeliveryClaim(claim, binding, "benign")).toBe(true);
      expect(verifyDurableUserDeliveryClaim({ ...claim, minimaxExecPolicy: { mode: "off", revision: 1 } },
        { ...binding, minimaxExecPolicy: { mode: "off", revision: 1 } }, "benign")).toBe(false);
      const updateDuringJob = delivery.setMinimaxExecPolicy(target, 1, "off");
      await expect(updateDuringJob).rejects.toThrow(/still in flight|already admitted/);
      releaseSend({ ok: true, admitted: true, turnId: "turn-policy" });
      await vi.waitFor(() => expect(delivery.get("minimax-code", sessionId, input.inputId)?.job?.state).toBe("completed"));
      await expect(delivery.setMinimaxExecPolicy(target, 1, "off")).resolves.toMatchObject({ mode: "off", revision: 2 });
      await expect(delivery.submitMinimaxExecPolicy(input)).rejects.toThrow(/другого текста, режима или политики/);
      expect(sendStarted).toHaveBeenCalledOnce();
    } finally {
      releaseSend?.({ ok: true, admitted: true, turnId: "turn-policy-cleanup" });
      delivery.close();
    }
  });

  it("serves Herder policy separately from native mode and uses exact host/session CAS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-http-"));
    directories.push(directory);
    const sessionId = "mvs_policy_http";
    const adapter = {
      type: "minimax-code", name: "fixture",
      getSession: vi.fn(async (id: string) => ({ id, harness: "minimax-code", hostId: localSessionHostId(), cwd: "/tmp", status: "idle", meta: {} })),
    } as unknown as HarnessAdapter;
    const server = createWebServer({ adapters: new Map([["minimax-code", adapter]]), converter: {} as never,
      jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(directory, "jobs.json") }),
      sessionObservationManagedExternally: true });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const path = `/api/sessions/minimax-code/${sessionId}/herder-exec-policy`;
      const get = await fetch(`${origin}${path}`);
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ available: true, nativeMode: { state: "unknown" }, policy: { scope: "next_herder_cli_exec", mode: "unset", revision: 0 } });
      const put = await fetch(`${origin}${path}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: localSessionHostId(), expectedRevision: 0, mode: "full" }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ state: "configured", nativeMode: { state: "unknown" }, policy: { mode: "full", revision: 1 } });
      const stale = await fetch(`${origin}${path}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: localSessionHostId(), expectedRevision: 0, mode: "off" }),
      });
      expect(stale.status).toBe(409);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("keeps policy changes blocked after an UNKNOWN observation until the native send settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-unknown-"));
    directories.push(directory);
    const store = new MinimaxExecPolicyStore(join(directory, "policy"));
    const sessionId = "mvs_policy_unknown";
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId };
    let releaseSend!: (result: { ok: boolean; admitted: boolean; turnId: string }) => void;
    const sendStarted = vi.fn();
    const adapter = { getSession: vi.fn(async (id: string) => ({ id, harness: "minimax-code", hostId: "local", status: "idle", cwd: "/tmp" })) };
    const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(directory, "jobs.json") });
    const delivery = new UserMessageDelivery(new Map([["minimax-code", adapter as never]]), {
      sendMessage: async () => { sendStarted(); return new Promise(resolve => { releaseSend = resolve; }); },
    }, jobs, { pollMs: 1, maxWaitMs: 80, maxPending: 2 }, store);
    try {
      await store.update(target, 0, "full");
      const input = { harness: "minimax-code", sessionId, inputId: "policy-unknown-input", message: "benign", mode: "queue" as const };
      const receipt = await delivery.submitMinimaxExecPolicy(input);
      await vi.waitFor(() => expect(sendStarted).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(delivery.get("minimax-code", sessionId, input.inputId)?.job?.state).toBe("completed"));
      expect(delivery.get("minimax-code", sessionId, input.inputId)?.job?.result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      await expect(delivery.setMinimaxExecPolicy(target, 1, "off")).rejects.toThrow(/still in flight|already admitted/);
      releaseSend({ ok: true, admitted: true, turnId: "late-turn" });
      await vi.waitFor(() => expect(delivery.setMinimaxExecPolicy(target, 1, "off")).resolves.toMatchObject({ mode: "off", revision: 2 }));
      await expect(delivery.submitMinimaxExecPolicy(input)).rejects.toThrow(/другого текста, режима или политики/);
      expect(delivery.get("minimax-code", sessionId, input.inputId)?.job?.result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      expect(sendStarted).toHaveBeenCalledOnce();
      void receipt;
    } finally {
      releaseSend?.({ ok: true, admitted: true, turnId: "cleanup-turn" });
      delivery.close();
    }
  });

  it("shares the pending native-send hold across delivery instances for one terminal UNKNOWN job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-shared-hold-"));
    directories.push(directory);
    const policyDir = join(directory, "policy");
    const store1 = new MinimaxExecPolicyStore(policyDir);
    const store2 = new MinimaxExecPolicyStore(policyDir);
    const sessionId = "mvs_shared_delivery_hold";
    const target = { hostId: "local", harness: "minimax-code" as const, sessionId };
    await store1.update(target, 0, "full");
    let releaseSend!: (result: { ok: boolean; admitted: boolean; turnId: string }) => void;
    const sendStarted = vi.fn();
    const adapter = {
      getSession: vi.fn(async (id: string) => ({ id, harness: "minimax-code", hostId: "local", status: "idle", cwd: "/tmp" })),
      getNativeIdleAdmissionProof: vi.fn(async () => ({ hostId: "local", harness: "minimax-code", sessionId, idle: true })),
    };
    const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(directory, "jobs.json") });
    const supervisor = { sendMessage: async () => { sendStarted(); return new Promise(resolve => { releaseSend = resolve; }); } };
    const adapters = new Map([["minimax-code", adapter as never]]);
    const first = new UserMessageDelivery(adapters, supervisor, jobs, { pollMs: 1, maxWaitMs: 80, maxPending: 2 }, store1);
    const second = new UserMessageDelivery(adapters, supervisor, jobs, { pollMs: 1, maxWaitMs: 1_000, maxPending: 2 }, store2);
    try {
      const input = { harness: "minimax-code", sessionId, inputId: "shared-pending-input", message: "benign", mode: "queue" as const };
      const receipt = await first.submitMinimaxExecPolicy(input);
      await vi.waitFor(() => expect(sendStarted).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(first.get("minimax-code", sessionId, input.inputId)?.job?.state).toBe("completed"));
      expect(first.get("minimax-code", sessionId, input.inputId)?.job?.result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      await expect(second.setMinimaxExecPolicy(target, 1, "off")).rejects.toThrow(/native send is still in flight/);
      expect(adapter.getNativeIdleAdmissionProof).not.toHaveBeenCalled();

      releaseSend({ ok: true, admitted: true, turnId: "late-shared-turn" });
      let updated: Awaited<ReturnType<typeof second.setMinimaxExecPolicy>> | undefined;
      await vi.waitFor(async () => {
        try { updated = await second.setMinimaxExecPolicy(target, 1, "off"); }
        catch { return false; }
        return updated.mode === "off";
      });
      expect(updated).toMatchObject({ mode: "off", revision: 2 });
      expect(sendStarted).toHaveBeenCalledOnce();
      expect(first.get("minimax-code", sessionId, input.inputId)?.job?.result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      void receipt;
    } finally {
      releaseSend?.({ ok: true, admitted: true, turnId: "cleanup-shared-turn" });
      first.close(); second.close();
    }
  });

  it("returns a legacy default-policy job without creating or replaying a new launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-minimax-policy-legacy-"));
    directories.push(directory);
    const store = new MinimaxExecPolicyStore(join(directory, "policy"));
    const sessionId = "mvs_policy_legacy";
    const adapter = { getSession: vi.fn(async (id: string) => ({ id, harness: "minimax-code", hostId: "local", status: "idle", cwd: "/tmp" })) };
    const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(directory, "jobs.json") });
    const send = vi.fn(async () => ({ ok: true, admitted: true, turnId: "turn-legacy" }));
    const delivery = new UserMessageDelivery(new Map([["minimax-code", adapter as never]]), { sendMessage: send }, jobs,
      { pollMs: 1, maxWaitMs: 1_000, maxPending: 2 }, store);
    const input = { harness: "minimax-code", sessionId, inputId: "legacy-input", message: "same", mode: "queue" as const };
    try {
      const oldJob = delivery.submit(input);
      await vi.waitFor(() => expect(delivery.get("minimax-code", sessionId, input.inputId)?.job?.state).toBe("completed"));
      const receipt = await delivery.submitMinimaxExecPolicy(input);
      expect(receipt.job?.id).toBe(oldJob.job?.id);
      expect(send).toHaveBeenCalledOnce();
    } finally { delivery.close(); }
  });
});
