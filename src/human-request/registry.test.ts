import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
