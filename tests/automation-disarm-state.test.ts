import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
  AutomationDisarmStore,
} from "../src/automation-disarm/state.js";
import { resolveAutopilotStateDir } from "../src/autopilot/state-dir.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-state-"));
  cleanups.push(dir);
  return dir;
}

describe("owner-level automation lever: durable state", () => {
  it("lives in the runtime state directory, beside the live launch policy", () => {
    const path = AutomationDisarmStore.forRuntime({ HOME: "/home/owner" }).path;
    expect(path).toBe("/home/owner/.local/state/agent-herder/autopilot-live/automation-disarm.json");
    // The lever is a sibling of the live launch policy, not a memory-only flag.
    expect(join(resolveAutopilotStateDir({ HOME: "/home/owner" }), "automation-launch-policy.json")).toBe(
      "/home/owner/.local/state/agent-herder/autopilot-live/automation-launch-policy.json",
    );
  });

  it("keeps the forbidden state after the runtime state is recreated", async () => {
    const dir = await stateDir();
    const store = AutomationDisarmStore.at(dir);
    const applied = await store.apply({ source: "owner", disarmed: true, reason: "владелец остановил автоматику" });
    expect(applied.ok).toBe(true);

    // A restart of the process builds a new store over the same directory.
    const afterRestart = AutomationDisarmStore.at(dir);
    const state = await afterRestart.read();
    expect(state.disarmed).toBe(true);
    expect(state.reason).toBe("владелец остановил автоматику");
    expect(state.changedBy).toBe("owner");

    // The decision itself is on disk, not only in process memory.
    const raw = JSON.parse(await readFile(join(dir, "automation-disarm.json"), "utf8")) as { disarmed: boolean };
    expect(raw.disarmed).toBe(true);
  });

  it("refuses an automatic attempt to lift the lever and names the reason", async () => {
    const dir = await stateDir();
    const store = AutomationDisarmStore.at(dir);
    await store.apply({ source: "owner", disarmed: true });

    const attempt = await store.apply({ source: "automation", disarmed: false });
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe("automation_cannot_change_disarm");
    expect(attempt.reason).toBe(AUTOMATION_CANNOT_CHANGE_DISARM_REASON);
    expect(attempt.reason).toContain("только явное действие владельца");

    // The refused attempt changed nothing.
    expect((await store.read()).disarmed).toBe(true);
  });

  it("keeps the logical work keys of the owner decision", async () => {
    const dir = await stateDir();
    const store = AutomationDisarmStore.at(dir);
    await store.apply({ source: "owner", disarmed: false, workKeys: ["codex\0/work\0card", "project\0my-card"] });
    const state = await store.read();
    expect(state.disarmed).toBe(false);
    expect(state.blockedWorkKeys).toEqual(["codex\0/work\0card", "project\0my-card"]);
  });

  it("reads an unreadable owner file as forbidden", async () => {
    const dir = await stateDir();
    await writeFile(join(dir, "automation-disarm.json"), "{not json", "utf8");
    const state = await AutomationDisarmStore.at(dir).read();
    expect(state.disarmed).toBe(true);
    expect(state.reason).toContain("повреждён");
  });
});
