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

  it("resolves only to a continuation and opaque reference", async () => {
    const { store, filePath } = await registry();
    const created = await store.create({ kind: "user", target: { harness: "opencode", sessionId: "s" }, notify: {
      project: "project-a", recipient: "recipient-a", kind: "human_request", severity: "explicit-severity", title: "explicit-title",
    } });
    expect(created.notify).toMatchObject({ project: "project-a", recipient: "recipient-a", kind: "human_request", severity: "explicit-severity", title: "explicit-title", dedupKey: `human-request:${created.requestId}` });
    const bound = await store.bindNotifyIncident(created.requestId, "incident-123");
    expect(bound.notify?.incidentId).toBe("incident-123");
    const resolved = await store.resolve(created.requestId, { continuation: "resume", resolutionRef: "notify://opaque/9" });

    expect(resolved).toMatchObject({ requestId: created.requestId, status: "resolved", continuation: "resume", resolutionRef: "notify://opaque/9" });
    expect(await store.get(created.requestId)).toEqual(resolved);
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("do-not-store");
    await expect(store.resolve(created.requestId, { continuation: "resume" })).rejects.toThrow("already resolved");
  });
});
