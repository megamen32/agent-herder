import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageStore } from "../src/lineage-store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("LineageStore", () => {
  it("persists parent-child records and reloads them after process state is discarded", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-lineage-"));
    const filePath = join(root, "lineage.json");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const record = {
      sessionKey: "claude-acp:child",
      parentKey: "claude-acp:parent",
      role: "worker",
      task: "Implement parser",
      provider: "claude-acp",
      createdAt: "2026-07-19T00:00:00.000Z",
      source: "supervisor" as const,
    };

    const first = new LineageStore(filePath);
    await first.record(record);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1, records: [record] });

    const second = new LineageStore(filePath);
    expect(await second.get(record.sessionKey)).toEqual(record);
    expect(await second.children(record.parentKey!)).toEqual([record]);
  });

  it("persists transport recovery checkpoints without losing parent lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-lineage-recovery-"));
    const filePath = join(root, "lineage.json");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new LineageStore(filePath);
    await store.record({
      sessionKey: "codex:child",
      parentKey: "codex:parent",
      provider: "codex",
      createdAt: "2026-07-19T00:00:00.000Z",
      source: "supervisor",
    });

    await store.recordRecovery("codex:child", {
      nativeSessionId: "thread-child",
      transport: "codex-app-server",
      transportGeneration: 2,
      lastAcknowledgedEvent: "turn/completed:turn-2",
      recoveryAttempts: 1,
      lastError: "transport disconnected",
    });

    expect(await store.get("codex:child")).toMatchObject({
      parentKey: "codex:parent",
      nativeSessionId: "thread-child",
      transportGeneration: 2,
      recoveryAttempts: 1,
    });
  });
});
