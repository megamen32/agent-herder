import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";

describe("autopilot session overrides", () => {
  it("enables, reports, and disables one exact harness session durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-sessions-"));
    const path = join(root, "sessions.json");
    const store = new AutopilotSessionStore(path);
    const target = { harness: "opencode" as const, sessionId: "ses-1", cwd: "/workspace/app" };

    expect(await store.get(target.harness, target.sessionId)).toBeNull();
    expect(await store.set(target, true)).toMatchObject({ ...target, enabled: true });
    expect(await new AutopilotSessionStore(path).get("opencode", "ses-1")).toMatchObject({
      ...target,
      enabled: true,
    });

    expect(await store.set({ ...target, cwd: "/workspace/moved" }, false)).toMatchObject({
      harness: "opencode",
      sessionId: "ses-1",
      cwd: "/workspace/moved",
      enabled: false,
    });
    expect(await store.get("opencode", "ses-1")).toMatchObject({ enabled: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      sessions: [{ harness: "opencode", sessionId: "ses-1", enabled: false }],
    });
  });

  it("keeps equal native IDs isolated by harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-harnesses-"));
    const store = new AutopilotSessionStore(join(root, "sessions.json"));

    await store.set({ harness: "codex", sessionId: "same-id", cwd: "/codex" }, true);
    await store.set({ harness: "claude", sessionId: "same-id", cwd: "/claude" }, true);
    await store.set({ harness: "hermes", sessionId: "same-id", cwd: "/hermes" }, false);

    expect(await store.get("codex", "same-id")).toMatchObject({ enabled: true, cwd: "/codex" });
    expect(await store.get("claude", "same-id")).toMatchObject({ enabled: true, cwd: "/claude" });
    expect(await store.get("hermes", "same-id")).toMatchObject({ enabled: false, cwd: "/hermes" });
  });
});
