import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON,
  HooksProhibitionsStore,
  defaultHooksProhibitions,
  parseHooksProhibitions,
} from "../src/hooks/state.js";
import { HooksService, hookProhibitionsEnabled, hookRuntimeActive } from "../src/hooks/service.js";
import { resolveAutopilotStateDir } from "../src/autopilot/state-dir.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-hooks-state-"));
  cleanups.push(dir);
  return dir;
}

describe("the lever of the prohibitions of the hooks: durable state", () => {
  it("lives in the runtime state directory, beside the other levers", () => {
    const path = HooksProhibitionsStore.forRuntime({ HOME: "/home/owner" }).path;
    expect(path).toBe("/home/owner/.local/state/agent-herder/autopilot-live/hooks-prohibitions.json");
    expect(join(resolveAutopilotStateDir({ HOME: "/home/owner" }), "automation-disarm.json")).toBe(
      "/home/owner/.local/state/agent-herder/autopilot-live/automation-disarm.json",
    );
  });

  it("starts with the optional hooks runtime off: an optional integration is opt-in", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const { state, known } = await store.readState();
    expect(known).toBe(true);
    expect(state.hooksEnabled).toBe(false);
    expect(state.prohibitionsEnabled).toBe(false);
    expect(state.disabledHooks).toEqual([]);
    expect(state.inactiveHooks).toEqual([]);
    expect(defaultHooksProhibitions().hooksEnabled).toBe(false);
    expect(defaultHooksProhibitions().prohibitionsEnabled).toBe(false);
  });

  it("reads a document of an older runtime as off: an update never turns the hooks back on", () => {
    const parsed = parseHooksProhibitions({ version: 1, prohibitionsEnabled: true, disabledHooks: [] });
    expect(parsed.hooksEnabled).toBe(false);
    expect(parsed.inactiveHooks).toEqual([]);
  });

  it("keeps the whole runtime off when only the prohibitions move", async () => {
    // The fleet sync and the automatic paths write the prohibitions. They
    // never write the switch of the runtime, so they can never turn the
    // optional hooks on.
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const applied = await store.apply({ source: "owner", prohibitionsEnabled: true, reason: "общие настройки" });
    expect(applied.ok).toBe(true);
    expect(applied.state.hooksEnabled).toBe(false);
    expect(applied.state.prohibitionsEnabled).toBe(true);
    expect(hookRuntimeActive(applied.state, true, "Stop")).toBe(false);
  });

  it("keeps a hook off on its own while the runtime is on", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const applied = await store.apply({ source: "owner", hooksEnabled: true, inactiveHooks: ["Stop"], reason: "Stop не нужен" });
    expect(applied.ok).toBe(true);
    expect(applied.state.hooksEnabled).toBe(true);
    expect(applied.state.inactiveHooks).toEqual(["Stop"]);
    expect(hookRuntimeActive(applied.state, true, "Stop")).toBe(false);
    expect(hookRuntimeActive(applied.state, true, "PreToolUse")).toBe(true);
  });

  it("keeps the decision of the owner after the runtime state is recreated", async () => {
    const dir = await stateDir();
    const applied = await HooksProhibitionsStore.at(dir).apply({
      source: "owner",
      actor: "owner",
      hooksEnabled: true,
      reason: "решение владельца",
    });
    expect(applied.ok).toBe(true);
    expect(applied.changed).toBe(true);

    // A restart of the process builds a new store over the same directory.
    const state = await HooksProhibitionsStore.at(dir).read();
    expect(state.hooksEnabled).toBe(true);
    expect(state.reason).toBe("решение владельца");
    expect(state.changedBy).toBe("owner");

    const raw = JSON.parse(await readFile(join(dir, "hooks-prohibitions.json"), "utf8")) as { hooksEnabled: boolean };
    expect(raw.hooksEnabled).toBe(true);
  });

  it("keeps the set of the hooks whose own prohibitions are off", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const applied = await store.apply({ source: "owner", hooksEnabled: true, prohibitionsEnabled: true, disabledHooks: ["Stop"] });
    expect(applied.ok).toBe(true);
    expect(applied.state.disabledHooks).toEqual(["Stop"]);
    // The rest of the hooks keep forbidding what they forbid.
    expect(hookProhibitionsEnabled(applied.state, true, "Stop")).toBe(false);
    expect(hookProhibitionsEnabled(applied.state, true, "PreToolUse")).toBe(true);
  });

  it("writes one record of the decision into the journal of the owner", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    await store.apply({ source: "owner", actor: "владелец панели", hooksEnabled: true, reason: "мешают" });
    const audit = await store.audit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe("владелец панели");
    expect(audit[0]?.reason).toBe("мешают");
    expect(audit[0]?.before.prohibitionsEnabled).toBe(false);
    expect(audit[0]?.after.prohibitionsEnabled).toBe(false);
    expect(audit[0]?.before.hooksEnabled).toBe(false);
    expect(audit[0]?.after.hooksEnabled).toBe(true);
    const raw = await readFile(join(dir, "hooks-prohibitions.audit.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("is idempotent: the same decision twice is one decision", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const first = await store.apply({ source: "owner", hooksEnabled: true, reason: "мешают" });
    expect(first.changed).toBe(true);

    const second = await store.apply({ source: "owner", hooksEnabled: true, reason: "мешают" });
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.etag).toBe(first.etag);
    expect(second.state.changedAt).toBe(first.state.changedAt);
    // The journal keeps one record of one decision, not one record of every retry.
    expect(await store.audit()).toHaveLength(1);
  });

  it("refuses a hook that does not exist and names the ones that do", async () => {
    const dir = await stateDir();
    const result = await HooksProhibitionsStore.at(dir).apply({
      source: "owner",
      disabledHooks: ["Stop", "NoSuchHook" as never],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unknown_hook");
    expect(result.reason).toContain("NoSuchHook");
    expect(result.reason).toContain("Stop");
  });

  it("refuses an automatic attempt to change the lever and names the reason", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    await store.apply({ source: "owner", hooksEnabled: true });
    const attempt = await store.apply({ source: "automation", hooksEnabled: false });
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe("automation_cannot_change_prohibitions");
    expect(attempt.reason).toBe(AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON);
    // The refused attempt changed nothing.
    expect((await store.read()).hooksEnabled).toBe(true);
  });

  it("reads a damaged state as unknown: the hooks forbid nothing", async () => {
    const dir = await stateDir();
    await writeFile(join(dir, "hooks-prohibitions.json"), "{not json", "utf8");
    const { state, known, reason } = await HooksProhibitionsStore.at(dir).readState();
    expect(known).toBe(false);
    expect(reason).toContain("повреждён");
    expect(hookProhibitionsEnabled(state, known, "Stop")).toBe(false);
  });

  it("refuses a document of an unknown format", () => {
    expect(() => parseHooksProhibitions({ version: 2, prohibitionsEnabled: true })).toThrow();
    expect(() => parseHooksProhibitions({ version: 1, prohibitionsEnabled: "yes" })).toThrow();
  });
});

describe("the lever of the prohibitions of the hooks: the view of the panel", () => {
  it("names every hook, its state and what it does", async () => {
    const dir = await stateDir();
    const service = new HooksService(HooksProhibitionsStore.at(dir), (await import("../src/hooks/service.js")).HooksActivityStore.at(dir));
    const view = await service.readView();
    expect(view.hooks.map((hook) => hook.kind)).toEqual(["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]);
    expect(view.hooks.find((hook) => hook.kind === "Stop")?.humanName).toContain("Stop");
    // The whole optional runtime is off: no hook of the herder runs.
    expect(view.hooksEnabled).toBe(false);
    expect(view.hooks.find((hook) => hook.kind === "Stop")?.state).toBe("не выполняется");
    expect(view.hooks.find((hook) => hook.kind === "SessionStart")?.state).toBe("не выполняется");

    // With the runtime on and the prohibitions off, the hooks run and forbid
    // nothing. That is a different state from a hook that does not run.
    const on = await service.applyProhibitions({ source: "owner", hooksEnabled: true, reason: "владелец включил" });
    expect(on.view.hooksEnabled).toBe(true);
    expect(on.view.hooks.find((hook) => hook.kind === "Stop")?.state).toBe("выполняется, не запрещает");
    expect(on.view.hooks.find((hook) => hook.kind === "SessionStart")?.state).toBe("выполняется, не запрещает");

    const prohibiting = await service.applyProhibitions({ source: "owner", prohibitionsEnabled: true, reason: "запреты" });
    expect(prohibiting.view.hooks.find((hook) => hook.kind === "Stop")?.state).toBe("выполняется, может запрещать");
  });

  it("shows the last refusal of the hook that refused", async () => {
    const dir = await stateDir();
    const service = new HooksService(HooksProhibitionsStore.at(dir), (await import("../src/hooks/service.js")).HooksActivityStore.at(dir));
    await service.recordActivity({
      hook: "Stop",
      outcome: "refused",
      reason: "сессия не остановлена: хук продолжил ход",
      sessionId: "codex:1",
    });
    const view = await service.readView();
    const stop = view.hooks.find((hook) => hook.kind === "Stop");
    expect(stop?.lastRefusal?.reason).toBe("сессия не остановлена: хук продолжил ход");
    expect(stop?.lastFiredAt).toBeTruthy();
    // A refusal is a record of one hook, not a record of every call.
    expect(view.hooks.find((hook) => hook.kind === "PreToolUse")?.lastRefusal).toBeUndefined();
  });

  it("answers the hooks with the light state they ask for", async () => {
    const dir = await stateDir();
    const service = new HooksService(HooksProhibitionsStore.at(dir), (await import("../src/hooks/service.js")).HooksActivityStore.at(dir));
    const before = await service.readProhibitions("Stop");
    expect(before.known).toBe(true);
    expect(before.hooksEnabled).toBe(false);
    expect(before.active).toBe(false);
    expect(before.prohibitionsEnabled).toBe(false);

    await service.applyProhibitions({ source: "owner", hooksEnabled: true, prohibitionsEnabled: false, reason: "мешают" });
    const after = await service.readProhibitions("Stop");
    expect(after.hooksEnabled).toBe(true);
    expect(after.active).toBe(true);
    expect(after.prohibitionsEnabled).toBe(false);
    expect(after.disabledHooks).toEqual([]);

    // A hook that the owner switched off on its own is quiet even when the
    // runtime of the other hooks is on.
    await service.applyProhibitions({ source: "owner", inactiveHooks: ["Stop"], reason: "Stop не нужен" });
    const quiet = await service.readProhibitions("Stop");
    expect(quiet.hooksEnabled).toBe(true);
    expect(quiet.active).toBe(false);
    expect((await service.readProhibitions("PreToolUse")).active).toBe(true);
  });
});
