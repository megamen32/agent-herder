import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getHumanStopStore, type HumanStopStore } from "../src/human-stop-store.js";

const roots: string[] = [];

async function fixtureStore(): Promise<{ root: string; path: string; store: HumanStopStore }> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-human-stop-"));
  roots.push(root);
  const path = join(root, "human-stops.json");
  const store = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: path });
  return { root, path, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HumanStopStore", () => {
  it("persists an exact harness/native ID fence across store instances", async () => {
    const { path, store } = await fixtureStore();
    await store.hold(
      { harness: "codex", id: "thread-a", cwd: "/tmp/project", title: "Export" },
      { id: "turn-interrupt-1", at: "2026-10-06T08:00:00.000Z", reason: "interrupted", turnId: "turn-1" },
    );

    expect(await getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: path }).isHeld("codex", "thread-a")).toBe(true);
    expect(await store.isHeld("zcode", "thread-a")).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("ignores replayed stop IDs after explicit release and accepts a newer stop", async () => {
    const { store } = await fixtureStore();
    const target = { harness: "zcode", id: "session-a", cwd: "/tmp/project", title: "Task" };
    const first = { id: "native-event-1", at: new Date(Date.now() - 5_000).toISOString(), reason: "cancelled", turnId: "turn-1" };
    await store.hold(target, first);
    await expect(store.release("zcode", "session-a")).resolves.toBe(true);
    await expect(store.observe({ ...target, status: "stopped", lastActivity: first.at, meta: { automationStop: first } } as never)).resolves.toBe(false);

    await store.hold(target, { id: "native-event-2", at: new Date(Date.now() + 2_000).toISOString(), reason: "cancelled", turnId: "turn-2" });
    expect(await store.isHeld("zcode", "session-a")).toBe(true);
  });

  it("does not recreate a cleared fence for a late event from the stopped turn", async () => {
    const { store } = await fixtureStore();
    const target = { harness: "codex", id: "thread-late-stop" };
    await store.hold(target, { id: "human-stop", at: "2026-10-06T08:00:00.000Z", reason: "interrupted", turnId: "turn-old" });
    await expect(store.release("codex", target.id)).resolves.toBe(true);

    await store.hold(target, {
      id: "late-native-event-new-event-id",
      at: new Date(Date.now() + 1_000).toISOString(),
      reason: "late-cancel-notification",
      turnId: "turn-old",
    });
    expect(await store.isHeld("codex", target.id)).toBe(false);

    await store.hold(target, {
      id: "new-human-interruption",
      at: new Date(Date.now() + 2_000).toISOString(),
      reason: "interrupted",
      turnId: "turn-new",
    });
    expect(await store.isHeld("codex", target.id)).toBe(true);
  });

  it("keeps the newest named-session context while observing a repeated stop event", async () => {
    const { store } = await fixtureStore();
    const first = { harness: "zcode", id: "session-context", cwd: "/tmp/old", title: "Before rename" };
    const stop = { id: "event-context", at: "2026-10-06T08:00:00.000Z", reason: "cancelled", turnId: "turn-context" };
    await store.hold(first, stop);
    await store.hold({ ...first, cwd: "/tmp/new", title: "After rename" }, stop);
    expect(await store.findHeldNamed("zcode", "after rename", "/tmp/new")).toMatchObject({ id: "session-context" });

    await expect(store.observe({
      ...first,
      cwd: "/tmp/newer",
      title: "Latest native title",
      status: "stopped",
      lastActivity: stop.at,
      meta: { automationStop: stop },
    } as never)).resolves.toBe(true);
    expect(await store.findHeldNamed("zcode", "latest native title", "/tmp/newer")).toMatchObject({ active: true });
  });

  it("enriches a stop written before native lookup with its later turn identity", async () => {
    const { path, store } = await fixtureStore();
    const target = { harness: "codex", id: "minimal-stop" };
    const stop = { id: "atomic-stop-id", at: new Date().toISOString(), reason: "interrupted" };
    await store.hold(target, stop);
    await store.hold({ ...target, cwd: "/tmp/work", title: "Rich native session" }, { ...stop, turnId: "native-turn-7" });

    const file = JSON.parse(await readFile(path, "utf8")) as { sessions: Array<{ stop: { id: string; turnId?: string }; title?: string; cwd?: string }> };
    expect(file.sessions[0]).toMatchObject({
      stop: { id: "atomic-stop-id", turnId: "native-turn-7" },
      cwd: "/tmp/work",
      title: "Rich native session",
    });
  });

  it("does not clear an active human hold when recording Herder's own interrupt", async () => {
    const { store } = await fixtureStore();
    await store.hold({ harness: "codex", id: "thread-c" }, {
      id: "human-stop", at: "2026-10-06T08:00:00.000Z", reason: "interrupted", turnId: "human-turn",
    });
    await store.ignoreNativeStop("codex", "thread-c", {
      id: "herder-cancel", at: "2026-10-06T08:01:00.000Z", reason: "internal-cancel", turnId: "auto-turn",
    });
    expect(await store.isHeld("codex", "thread-c")).toBe(true);
    await expect(store.observe({
      id: "thread-c", harness: "codex", status: "stopped", cwd: "/tmp/project", title: "Task",
      lastActivity: "2026-10-06T08:01:00.000Z", meta: { automationStop: {
        id: "herder-cancel", at: "2026-10-06T08:01:00.000Z", reason: "internal-cancel", turnId: "auto-turn",
      } },
    } as never)).resolves.toBe(true);
    await expect(store.release("codex", "thread-c")).resolves.toBe(true);
    await expect(store.observe({
      id: "thread-c", harness: "codex", status: "stopped", cwd: "/tmp/project", title: "Task",
      lastActivity: "2026-10-06T08:01:00.000Z", meta: { automationStop: {
        id: "herder-cancel", at: "2026-10-06T08:01:00.000Z", reason: "internal-cancel", turnId: "auto-turn",
      } },
    } as never)).resolves.toBe(false);
  });

  it("makes a just-written hold visible to concurrent readers of the same store", async () => {
    const { store } = await fixtureStore();
    const hold = store.hold({ harness: "codex", id: "thread-pending" }, {
      id: "pending-stop", at: "2026-10-06T08:00:00.000Z", reason: "interrupted",
    });
    await expect(store.isHeld("codex", "thread-pending")).resolves.toBe(true);
    await hold;
  });

  it("clears only for a strictly newer real prompt, not the stopped turn or automation", async () => {
    const { path, store } = await fixtureStore();
    const target = { harness: "codex", id: "thread-b", cwd: "/tmp/project", title: "Task" };
    const stop = { id: "stop-1", at: "2026-10-06T08:00:00.000Z", reason: "interrupted", turnId: "turn-1" };
    await store.hold(target, stop);

    await expect(store.release("codex", "thread-b", { id: "prompt-old", at: stop.at, turnId: "turn-1" })).resolves.toBe(false);
    await expect(store.release("codex", "thread-b", {
      id: "agent-herder:auto:generated", at: "2026-10-06T08:01:00.000Z", turnId: "turn-2", automated: true,
    })).resolves.toBe(false);

    const session = {
      ...target,
      status: "idle",
      lastActivity: "2026-10-06T08:01:01.000Z",
      meta: { latestUserPrompt: { id: "prompt-2", at: "2026-10-06T08:01:00.000Z", turnId: "turn-2", origin: "real_user" } },
    } as never;
    await expect(store.observe(session)).resolves.toBe(false);
    expect(await store.isHeld("codex", "thread-b")).toBe(false);
    const file = JSON.parse(await readFile(path, "utf8")) as { sessions: Array<{ ignoredStopIds: string[]; clearedBy?: string }> };
    expect(file.sessions[0]).toMatchObject({ clearedBy: "new-user-prompt", ignoredStopIds: ["stop-1"] });
  });

  it("does not release on synthetic prompt markers and resolves held named sessions", async () => {
    const { store } = await fixtureStore();
    const target = { harness: "zcode", id: "named-session", cwd: "/tmp/project", title: "Nightly Report" };
    const stop = { id: "stop-1", at: "2026-10-06T08:00:00.000Z", reason: "cancelled", turnId: "turn-1" };
    await store.hold(target, stop);
    await expect(store.observe({
      ...target, status: "idle", lastActivity: "2026-10-06T08:01:00.000Z",
      meta: { latestUserPrompt: { id: "prompt-2", at: "2026-10-06T08:01:00.000Z", turnId: "turn-2", synthetic: true } },
    } as never)).resolves.toBe(true);
    expect(await store.findHeldNamed("zcode", "nightly report", "/tmp/project")).toMatchObject({ id: "named-session", active: true });
    expect(await store.findHeldNamed("zcode", "nightly report", "/tmp/other")).toBeUndefined();
  });
});
