import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanRequestRegistry } from "./registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function registry(): Promise<{ store: HumanRequestRegistry; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-human-request-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "requests.json");
  return { store: new HumanRequestRegistry(filePath), filePath };
}

describe("HumanRequestRegistry", () => {
  it("creates an opaque request and reloads its routing correlation durably", async () => {
    const { store, filePath } = await registry();
    const created = await store.create({ kind: "secret", target: { harness: "codex", sessionId: "session-7" }, contextRef: "sss://opaque/42" });

    expect(created.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ kind: "secret", status: "pending", continuation: "resume", target: { harness: "codex", sessionId: "session-7" } });
    expect(JSON.stringify(created)).not.toContain("password");

    const reloaded = new HumanRequestRegistry(filePath);
    expect(await reloaded.get(created.requestId)).toEqual(created);
  });

  it.each(["secret", "plaintext", "result", "response", "body"])("rejects plaintext/result field %s", async (field) => {
    const { store } = await registry();
    await expect(store.create({ kind: "user", target: { harness: "codex", sessionId: "s" }, [field]: "do-not-store" } as never)).rejects.toThrow();
  });

  it("claims exactly once and persists the resume lifecycle", async () => {
    const { store, filePath } = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "s", cwd: "/workspace", marker: "marker-1" }, notify: {
      project: "project-a", recipient: "recipient-a", kind: "human_request", severity: "explicit-severity", title: "explicit-title",
    } });
    expect(created.notify).toMatchObject({ project: "project-a", recipient: "recipient-a", kind: "human_request", severity: "explicit-severity", title: "explicit-title", dedupKey: `human-request:${created.requestId}` });
    const bound = await store.bindNotifyIncident(created.requestId, "incident-123");
    expect(bound.notify?.incidentId).toBe("incident-123");
    const claimed = await store.claimResume(created.requestId, { resultRef: "notify://opaque/9" });

    expect(claimed).toMatchObject({ requestId: created.requestId, status: "resuming", continuation: "resume", resultRef: "notify://opaque/9" });
    expect(claimed.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.claimResume(created.requestId, { resultRef: "notify://opaque/other" })).toEqual(claimed);
    const resumed = await store.completeResume(created.requestId, { attemptId: claimed.attemptId!, receipt: "receipt://opaque/9" });
    expect(resumed).toMatchObject({ status: "resumed", attemptId: claimed.attemptId, receipt: "receipt://opaque/9" });
    expect(await store.claimResume(created.requestId)).toEqual(resumed);
    expect(await store.get(created.requestId)).toEqual(resumed);
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("do-not-store");
    expect(persisted).toContain("receipt://opaque/9");
    expect(persisted).not.toContain("notify://opaque/other");
  });

  it("returns an in-progress claim for duplicate resolve triggers", async () => {
    const { store } = await registry();
    const created = await store.create({ kind: "user", target: { harness: "codex", sessionId: "s" } });
    const first = await store.resolve(created.requestId, { continuation: "resume", resolutionRef: "result://opaque/1" });
    const duplicate = await store.resolve(created.requestId, { continuation: "resume", resolutionRef: "result://opaque/2" });

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: "resuming", resultRef: "result://opaque/1" });
  });

  it("persists one stable admission key and reports which caller may resume", async () => {
    const { store, filePath } = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "s", cwd: "/workspace" } });

    const admitted = await store.admitResume(created.requestId, { resultRef: "result://opaque/1" });
    expect(admitted.admitted).toBe(true);
    expect(admitted.recovered).toBe(false);
    expect(admitted.record).toMatchObject({
      status: "resuming",
      attemptId: admitted.record.attemptId,
      idempotencyKey: `human-request:${created.requestId}:${admitted.record.attemptId}`,
    });
    expect(admitted.record.resumeLeaseExpiresAt).toBeTypeOf("string");

    const duplicate = await store.admitResume(created.requestId, { resultRef: "result://opaque/2" });
    expect(duplicate.admitted).toBe(false);
    expect(duplicate.idempotencyKey).toBe(admitted.idempotencyKey);
    expect(duplicate.record).toEqual(admitted.record);
    expect(await readFile(filePath, "utf8")).not.toContain("result://opaque/2");

    const terminal = await store.completeResume(created.requestId, { attemptId: admitted.record.attemptId!, receipt: "receipt://opaque" });
    const afterTerminal = await store.admitResume(created.requestId, { resultRef: "result://opaque/3" });
    expect(afterTerminal.admitted).toBe(false);
    expect(afterTerminal.record).toEqual(terminal);
  });

  it("admits one caller across concurrent admissions of the same request", async () => {
    const { store } = await registry();
    const created = await store.create({ kind: "user", target: { agent: "zcode", sessionId: "s", cwd: "/workspace" } });

    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) => store.admitResume(created.requestId, { resultRef: `result://opaque/${index}` })));

    expect(receipts.filter((receipt) => receipt.admitted)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.idempotencyKey)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.record.attemptId)).size).toBe(1);
    await expect(store.get(created.requestId)).resolves.toMatchObject({ status: "resuming" });
  });

  it("starts the wait for an attempt admitted before leases existed", async () => {
    const { store, filePath } = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "s", cwd: "/workspace" } });
    // Reproduce the pre-lease format: resuming with an attempt id and no lease.
    const stored = JSON.parse(await readFile(filePath, "utf8")) as { version: number; requests: Array<Record<string, unknown>> };
    const record = stored.requests[0]!;
    record.status = "resuming";
    record.attemptId = "attempt-legacy";
    record.resultRef = "result://opaque/1";
    await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const backfilled = await store.admitResume(created.requestId, { resultRef: "result://opaque/1" });
    expect(backfilled.admitted).toBe(false);
    expect(backfilled.record).toMatchObject({
      status: "resuming",
      attemptId: "attempt-legacy",
      idempotencyKey: `human-request:${created.requestId}:attempt-legacy`,
    });
    expect(backfilled.record.resumeLeaseExpiresAt).toBeTypeOf("string");
    expect(backfilled.idempotencyKey).toBe(backfilled.record.idempotencyKey);
  });

  it("takes an expired in-flight lease over with the same attempt and key", async () => {
    const { store } = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "s", cwd: "/workspace" } });
    const admitted = await store.admitResume(created.requestId, { resultRef: "result://opaque/1", leaseMs: 1_000, now: new Date("2026-10-11T10:00:00.000Z") });

    const duringLease = await store.admitResume(created.requestId, { resultRef: "result://opaque/1", now: new Date("2026-10-11T10:00:00.500Z") });
    expect(duringLease.admitted).toBe(false);

    const afterLease = await store.admitResume(created.requestId, { resultRef: "result://opaque/1", now: new Date("2026-10-11T10:05:00.000Z") });
    expect(afterLease.admitted).toBe(true);
    expect(afterLease.recovered).toBe(true);
    expect(afterLease.idempotencyKey).toBe(admitted.idempotencyKey);
    expect(afterLease.record.attemptId).toBe(admitted.record.attemptId);
  });

  it("allows only the owning attempt to complete or fail", async () => {
    const { store } = await registry();
    const created = await store.create({ kind: "secret", target: { agent: "claude", sessionId: "s", cwd: "/tmp" } });
    const claimed = await store.claimResume(created.requestId, { attemptId: "attempt-1" });

    await expect(store.completeResume(created.requestId, { attemptId: "attempt-2", receipt: "receipt://wrong" })).rejects.toThrow("attemptId");
    const failed = await store.failResume(created.requestId, { attemptId: claimed.attemptId!, receipt: "receipt://failure" });
    expect(failed).toMatchObject({ status: "resume_failed", attemptId: "attempt-1", receipt: "receipt://failure" });
    expect(await store.failResume(created.requestId, { attemptId: "attempt-1", receipt: "receipt://other" })).toEqual(failed);
  });
});
