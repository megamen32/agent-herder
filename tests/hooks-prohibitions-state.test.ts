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

  it("starts with the prohibitions on: the current behaviour of the product", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const { state, known } = await store.readState();
    expect(known).toBe(true);
    expect(state.prohibitionsEnabled).toBe(true);
    expect(state.disabledHooks).toEqual([]);
    expect(defaultHooksProhibitions().prohibitionsEnabled).toBe(true);
    // The optional runtime of the hooks is off until the owner turns it on.
    expect(state.hooksEnabled).toBe(false);
    expect(defaultHooksProhibitions().hooksEnabled).toBe(false);
    expect(defaultHooksProhibitions().inactiveHooks).toEqual([]);
  });

  it("keeps the decision of the owner after the runtime state is recreated", async () => {
    const dir = await stateDir();
    const applied = await HooksProhibitionsStore.at(dir).apply({
      source: "owner",
      actor: "owner",
      prohibitionsEnabled: false,
      reason: "хуки мешают",
    });
    expect(applied.ok).toBe(true);
    expect(applied.changed).toBe(true);

    // A restart of the process builds a new store over the same directory.
    const state = await HooksProhibitionsStore.at(dir).read();
    expect(state.prohibitionsEnabled).toBe(false);
    expect(state.reason).toBe("хуки мешают");
    expect(state.changedBy).toBe("owner");

    const raw = JSON.parse(await readFile(join(dir, "hooks-prohibitions.json"), "utf8")) as { prohibitionsEnabled: boolean };
    expect(raw.prohibitionsEnabled).toBe(false);
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

  it("reads a document of an older runtime as off: the hooks come back by nobody", () => {
    const state = parseHooksProhibitions({ version: 1, prohibitionsEnabled: true });
    expect(state.hooksEnabled).toBe(false);
    expect(state.inactiveHooks).toEqual([]);
  });

  it("keeps the hooks that do not run at all apart from the prohibitions", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const applied = await store.apply({ source: "owner", hooksEnabled: true, inactiveHooks: ["Stop"] });
    expect(applied.ok).toBe(true);
    expect(applied.state.inactiveHooks).toEqual(["Stop"]);
    // The hook does not run at all, and the other hooks still do.
    expect(hookRuntimeActive(applied.state, true, "Stop")).toBe(false);
    expect(hookRuntimeActive(applied.state, true, "PreToolUse")).toBe(true);
    expect(hookProhibitionsEnabled(applied.state, true, "Stop")).toBe(false);
  });

  it("refuses a hook that does not exist in the list of the inactive hooks", async () => {
    const dir = await stateDir();
    const result = await HooksProhibitionsStore.at(dir).apply({
      source: "owner",
      inactiveHooks: ["NoSuchHook" as never],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unknown_hook");
    expect(result.reason).toContain("NoSuchHook");
  });

  it("writes one record of the decision into the journal of the owner", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    await store.apply({ source: "owner", actor: "владелец панели", prohibitionsEnabled: false, reason: "мешают" });
    const audit = await store.audit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe("владелец панели");
    expect(audit[0]?.reason).toBe("мешают");
    expect(audit[0]?.before.prohibitionsEnabled).toBe(true);
    expect(audit[0]?.after.prohibitionsEnabled).toBe(false);
    const raw = await readFile(join(dir, "hooks-prohibitions.audit.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("is idempotent: the same decision twice is one decision", async () => {
    const dir = await stateDir();
    const store = HooksProhibitionsStore.at(dir);
    const first = await store.apply({ source: "owner", prohibitionsEnabled: false, reason: "мешают" });
    expect(first.changed).toBe(true);

    const second = await store.apply({ source: "owner", prohibitionsEnabled: false, reason: "мешают" });
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
    await store.apply({ source: "owner", prohibitionsEnabled: false });
    const attempt = await store.apply({ source: "automation", prohibitionsEnabled: true });
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe("automation_cannot_change_prohibitions");
    expect(attempt.reason).toBe(AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON);
    // The refused attempt changed nothing.
    expect((await store.read()).prohibitionsEnabled).toBe(false);
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
    // The runtime of the hooks is off until the owner turns it on: no hook runs.
    expect(view.hooksEnabled).toBe(false);
    expect(view.hooks.find((hook) => hook.kind === "Stop")?.state).toBe("не выполняется");
    expect(view.hooks.find((hook) => hook.kind === "SessionStart")?.state).toBe("не выполняется");
    // The view names the timeout contract of every harness.
    expect(Array.isArray(view.timeouts)).toBe(true);
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
    const before = await service.readProhibitions();
    expect(before.known).toBe(true);
    // The lever of the owner is untouched, but the answer the hooks get is the
    // effective one: the runtime is off, so no hook forbids anything.
    expect(before.prohibitionsEnabled).toBe(false);
    // The hooks ask for the light state: while the runtime is off, no hook runs.
    expect(before.hooksEnabled).toBe(false);
    expect(before.active).toBe(false);
    expect((await service.readProhibitions("Stop")).active).toBe(false);

    await service.applyProhibitions({ source: "owner", prohibitionsEnabled: false, reason: "мешают" });
    const after = await service.readProhibitions();
    expect(after.prohibitionsEnabled).toBe(false);
    expect(after.disabledHooks).toEqual([]);
  });
});
