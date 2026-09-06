import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWakeLedger, BrowserWakeService } from "../src/browser-wake.js";
import { BrowserWorkerDispatchError, BrowserWorkerReceiptSchema, BrowserWorkerRequestSchema, createConfiguredBrowserWorkerClient } from "../src/browser-worker.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllGlobals();
});

function request(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: "agent-herder.browser-worker.v1",
    worker: "mac-mini-browserclaw",
    target: "E-Frontier",
    templateId: "secretary.inbox.v1",
    sourceRefs: ["opaque-ref-1"],
    runId: "run-1",
    idempotencyId: "idem-1",
    deadlineMs: 5_000,
    ...overrides,
  };
}

describe("browser wake contract", () => {
  it("rejects prompt bodies, cookies, page handles, telegram PII, and transcript fields", () => {
    expect(() => BrowserWorkerRequestSchema.parse({
      ...request(),
      promptBody: "write a prompt",
      cookies: ["session=secret"],
      pageHandle: "browser-page-1",
      telegramUser: "@privateperson",
      transcript: "full transcript",
    })).toThrow();
  });

  it("rejects unbounded receipt fields and missing opaque receipt refs", () => {
    const receipt = {
      worker: "mac-mini-browserclaw",
      target: "E-Frontier",
      templateId: "secretary.inbox.v1",
      runId: "run-1",
      idempotencyId: "idem-1",
      receiptRef: "receipt:idem-1",
      status: "completed",
      acceptedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(BrowserWorkerReceiptSchema.parse(receipt)).toMatchObject({ receiptRef: "receipt:idem-1" });
    expect(() => BrowserWorkerReceiptSchema.parse({ ...receipt, receiptRef: undefined })).toThrow();
    expect(() => BrowserWorkerReceiptSchema.parse({ ...receipt, transcript: "x".repeat(20_000) })).toThrow();
  });

  it("returns the same receipt on duplicate claims without calling the worker twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    let calls = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        calls += 1;
        return {
          worker: input.worker,
          target: input.target,
          templateId: input.templateId,
          runId: input.runId,
          idempotencyId: input.idempotencyId,
          receiptRef: `receipt:${input.idempotencyId}`,
          status: "completed",
          acceptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const first = await service.wake(request({ idempotencyId: "idem-dupe", runId: "run-dupe" }));
    const second = await service.wake(request({ idempotencyId: "idem-dupe", runId: "run-dupe" }));

    expect(first.receipt).toBeDefined();
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(root, "browser-wake.json"), "utf8"))).toMatchObject({
      version: 1,
      records: [{ request: { idempotencyId: "idem-dupe" }, status: "completed" }],
    });
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-conflict-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    let calls = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        calls += 1;
        return {
          worker: input.worker,
          target: input.target,
          templateId: input.templateId,
          runId: input.runId,
          idempotencyId: input.idempotencyId,
          receiptRef: `receipt:${input.idempotencyId}`,
          status: "completed",
          acceptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await service.wake(request({ idempotencyId: "idem-conflict", runId: "run-original" }));
    await expect(service.wake(request({ idempotencyId: "idem-conflict", runId: "run-reused" }))).rejects.toThrow(/idempotency/i);
    expect(calls).toBe(1);
  });

  it("reclaims a stale claimed record after its dispatch deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-stale-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    const claimedAt = new Date(Date.now() - 10_000).toISOString();
    const claimedRequest = BrowserWorkerRequestSchema.parse(request({ idempotencyId: "idem-stale", runId: "run-stale", deadlineMs: 5_000 }));
    await ledger.put({
      request: claimedRequest,
      status: "claimed",
      attempts: 1,
      requestedAt: claimedAt,
      updatedAt: claimedAt,
    });
    let calls = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        calls += 1;
        return {
          worker: input.worker,
          target: input.target,
          templateId: input.templateId,
          runId: input.runId,
          idempotencyId: input.idempotencyId,
          receiptRef: `receipt:${input.idempotencyId}`,
          status: "completed",
          acceptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const result = await service.wake(request({ idempotencyId: "idem-stale", runId: "run-stale", deadlineMs: 5_000 }));

    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
  });

  it("propagates job cancellation into the in-flight worker dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-cancel-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(_input, signal) {
        started();
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); }, { once: true });
        });
      },
    });
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
    const controller = new AbortController();
    const pending = service.wake(request({ idempotencyId: "idem-cancel", runId: "run-cancel" }), controller.signal);
    await startedGate;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await ledger.get("idem-cancel")).toMatchObject({ status: "claimed", attempts: 1 });
  });

  it("rejects a receipt whose target does not match the allowed BrowserClaw target", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-target-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        return {
          worker: input.worker,
          target: "Other-Target",
          templateId: input.templateId,
          runId: input.runId,
          idempotencyId: input.idempotencyId,
          receiptRef: `receipt:${input.idempotencyId}`,
          status: "completed",
          acceptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(service.wake(request({ idempotencyId: "idem-target", runId: "run-target" }))).rejects.toThrow(/dispatch failed/i);
  });

  it("fails closed when the worker client is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-offline-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    const service = new BrowserWakeService(ledger, null);
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(service.wake(request({ idempotencyId: "idem-offline", runId: "run-offline" }))).rejects.toThrow(/unavailable/i);
  });

  it("retries a retryable failed dispatch with the same idempotency key", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-retry-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    let calls = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        calls += 1;
        if (calls === 1) throw new BrowserWorkerDispatchError("worker_unavailable");
        return {
          worker: input.worker,
          target: input.target,
          templateId: input.templateId,
          runId: input.runId,
          idempotencyId: input.idempotencyId,
          receiptRef: `receipt:${input.idempotencyId}`,
          status: "completed",
          acceptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(service.wake(request({ idempotencyId: "idem-retry", runId: "run-retry" }))).rejects.toThrow();
    const result = await service.wake(request({ idempotencyId: "idem-retry", runId: "run-retry" }));

    expect(result.status).toBe("completed");
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("bounds retryable failures at the configured attempt limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-attempts-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    let calls = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake() {
        calls += 1;
        throw new BrowserWorkerDispatchError("worker_unavailable");
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.wake(request({ idempotencyId: "idem-limit", runId: "run-limit" }))).rejects.toThrow();
    }
    const exhausted = await service.wake(request({ idempotencyId: "idem-limit", runId: "run-limit" }));

    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("replays a lost post-side-effect response through the worker idempotency contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browser-wake-worker-idempotency-"));
    const ledger = new BrowserWakeLedger(join(root, "browser-wake.json"));
    const workerReceipts = new Map<string, ReturnType<typeof makeCompletedReceipt>>();
    let workerCalls = 0;
    let browserSideEffects = 0;
    const service = new BrowserWakeService(ledger, {
      async dispatchWake(input) {
        workerCalls += 1;
        const previous = workerReceipts.get(input.idempotencyId);
        if (previous) return previous;
        browserSideEffects += 1;
        const receipt = makeCompletedReceipt(input);
        workerReceipts.set(input.idempotencyId, receipt);
        if (workerCalls === 1) throw new BrowserWorkerDispatchError("worker_timeout");
        return receipt;
      },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(service.wake(request({ idempotencyId: "idem-worker", runId: "run-worker" }))).rejects.toThrow();
    const replay = await service.wake(request({ idempotencyId: "idem-worker", runId: "run-worker" }));

    expect(replay.status).toBe("completed");
    expect(workerCalls).toBe(2);
    expect(browserSideEffects).toBe(1);
  });

  it("rejects a non-local worker endpoint without an authorization token", () => {
    expect(() => createConfiguredBrowserWorkerClient({
      AGENT_HERDER_BROWSER_WORKER_URL: "http://mac-mini.example.invalid/browser-wake",
    })).toThrow(/token/i);
  });

  it("aborts the configured HTTP worker request when its caller cancels", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createConfiguredBrowserWorkerClient({ AGENT_HERDER_BROWSER_WORKER_URL: "http://127.0.0.1:18788/browser-wake" });
    const controller = new AbortController();
    const pending = client!.dispatchWake(BrowserWorkerRequestSchema.parse(request()), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ errorClass: "worker_timeout" });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("uses the configured worker token and bounded request deadline", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      worker: "mac-mini-browserclaw",
      target: "E-Frontier",
      templateId: "secretary.inbox.v1",
      runId: "run-1",
      idempotencyId: "idem-1",
      receiptRef: "receipt:idem-1",
      status: "completed",
      acceptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createConfiguredBrowserWorkerClient({
      AGENT_HERDER_BROWSER_WORKER_URL: "http://127.0.0.1:18788/browser-wake",
      AGENT_HERDER_BROWSER_WORKER_TOKEN: "worker-token",
    });
    const parsed = BrowserWorkerRequestSchema.parse(request());

    await client!.dispatchWake(parsed);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer worker-token" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

function makeCompletedReceipt(input: { worker: "mac-mini-browserclaw"; target: "E-Frontier"; templateId: "secretary.inbox.v1"; runId: string; idempotencyId: string }) {
  return {
    worker: input.worker,
    target: input.target,
    templateId: input.templateId,
    runId: input.runId,
    idempotencyId: input.idempotencyId,
    receiptRef: `receipt:${input.idempotencyId}`,
    status: "completed" as const,
    acceptedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}
