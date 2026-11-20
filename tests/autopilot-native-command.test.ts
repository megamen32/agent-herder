import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { createDefaultAutopilotPolicy } from "../src/autopilot/policy.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { createWebServer } from "../src/web/server.js";

const execute = promisify(execFile);
const id = "exact-thread";
let root: string, state: string, store: AutopilotSessionStore, policy: AutopilotPolicyStore;
let server: Server, base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "herder-rule-client-"));
  state = join(root, "state");
  await mkdir(state);
  vi.stubEnv("HOME", root);
  vi.stubEnv("HERDER_V1_ENTRY", join(root, "selector.json"));
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", state);
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(state, "human-stops.json"));
  vi.resetModules();
  const launcher = join(root, ".local/bin/agent-herder-v1");
  await mkdir(dirname(launcher), { recursive: true });
  await copyFile(new URL("./fixtures/autopilot-command-owner.mjs", import.meta.url), launcher);
  await chmod(launcher, 0o700);
  await writeFile(join(root, "selector.json"), JSON.stringify({ profiles: [join(root, "owner.json")] }), { mode: 0o600 });
  await writeFile(join(root, "owner.json"), JSON.stringify({ owner: { kind: "codex", node: "local", instance: "codex-local",
    codex_autopilot: { state_dir: state } } }), { mode: 0o600 });
  store = new AutopilotSessionStore(join(state, "sessions.json"));
  policy = new AutopilotPolicyStore(join(state, "autopilot-policy.json"));
  server = createWebServer({ adapters: new Map(), converter: { async convert() { throw new Error("unused"); } },
    autopilotSessionStore: store, autopilotPolicyStore: policy });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("AGENT_HERDER_URL", endpoint);
  base = endpoint + "/api/autopilot/sessions/codex/" + id;
});
afterEach(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function cli(command: "on" | "status" | "off" | "stop") {
  const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
  return runAutopilotCommand({ harness: "codex", sessionId: id, cwd: root, command });
}
async function inspector(enabled?: boolean) {
  const res = await fetch(base + "?cwd=" + encodeURIComponent(root), enabled === undefined ? {} : {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, cwd: root }),
  });
  const data = await res.json();
  expect(res.status, JSON.stringify(data)).toBe(200);
  return data;
}

it.each(["absent", "old", "current"])("uses one exact Rust rule across the CLI and inspector with %s policy", async format => {
  if (format !== "absent") {
    const { judgeMode, harnesses, ...old } = createDefaultAutopilotPolicy();
    await writeFile(join(state, "autopilot-policy.json"), JSON.stringify({ schemaVersion: 1, revision: "global-off",
      updatedAt: new Date().toISOString(), policy: format === "old" ? old : { ...old, judgeMode, harnesses } }), { mode: 0o600 });
  }
  const target = { harness: "codex" as const, sessionId: "exact-thread-neighbour", cwd: root };
  const neighbour = await store.set(target, false);
  const active = { enabled: true, executor: "rust", rule_ref: "autopilot-rule:exact", revision: 1 };
  expect(await cli("on")).toMatchObject(active);
  const personal = await store.get("codex", id);
  expect(await inspector()).toMatchObject(active);
  expect(await inspector(true)).toMatchObject(active);
  expect(await cli("status")).toMatchObject(active);
  expect(await store.get("codex", id)).toEqual(personal);
  expect(await cli("stop")).toMatchObject({ decision: "rust-executor" });
  const paused = { ...active, enabled: false, revision: 2 };
  expect(await inspector(false)).toMatchObject(paused);
  expect(await cli("status")).toMatchObject(paused);
  expect(await cli("off")).toMatchObject(paused);
  expect(await inspector()).toMatchObject(paused);
  expect(await store.get("codex", target.sessionId)).toEqual(neighbour);
  await store.set(target, true);
  expect(await new AutopilotSessionStore(join(state, "sessions.json")).get("codex", id))
    .toMatchObject({ executor: "rust", enabled: false });
  expect(await inspector(true)).toMatchObject({ ...active, revision: 3 });
  expect(await cli("off")).toMatchObject({ ...paused, revision: 4 });
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(c => ["create", "pause", "update"].includes(c.action)).map(c => c.action))
    .toEqual(["create", "pause", "update", "pause"]);
  expect(calls.filter(c => c.action === "list").every(c => c.session_ref === "ses_exact")).toBe(true);
});

it("prints the acknowledged state of a refused slash-command on", async () => {
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/autopilot-command-launcher.sh"), 'echo \'{"ok":true,"enabled":false,"human_stop_held":true}\'\n');
  const { stdout } = await execute("bash", [join(import.meta.dirname, "../skills/autopilot/scripts/run.sh"), "on"], {
    env: { PATH: process.env.PATH, HOME: root, PLUGIN_ROOT: root, CODEX_THREAD_ID: id },
  });
  expect(stdout).toContain("выключен");
});

it("leaves the saved self and full-goal sessions on their existing evaluator", async () => {
  await policy.replacePolicy({ ...createDefaultAutopilotPolicy(), judgeMode: "self" }, null);
  expect(await cli("on")).toMatchObject({ enabled: true });
  expect(await store.get("codex", id)).not.toHaveProperty("executor");
  await rm(join(state, "autopilot-policy.json"));
  const { GoalStore } = await import("../src/autopilot/goal-store.js");
  await new GoalStore(state).arm({ identity: { harness: "codex", sessionId: id, cwd: root },
    goal: { eventId: "human", text: "Complete my assignment" },
    requirements: [] });
  expect(await cli("off")).toMatchObject({ enabled: false });
  expect(await cli("on")).toMatchObject({ enabled: true });
  expect(await new GoalStore(state).snapshot({ harness: "codex", sessionId: id, cwd: root })).toMatchObject({ armed: true, stopped: false });
  expect(await store.get("codex", id)).not.toHaveProperty("executor");
  await expect(readFile(join(root, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fences a lost pause acknowledgement and reconciles it on the next read", async () => {
  await cli("on");
  await writeFile(join(root, "lose-pause"), "");
  await expect(cli("off")).rejects.toThrow();
  expect(await store.get("codex", id)).toMatchObject({ enabled: false, executor: "rust" });
  const { evaluateAutopilotStop, legacyAutopilotStatus } = await import("../src/autopilot-runner.js");
  const target = { harness: "codex" as const, sessionId: id, cwd: root };
  expect(await evaluateAutopilotStop(target)).toMatchObject({ enabled: false, decision: "rust-executor" });
  expect(await legacyAutopilotStatus(target)).toMatchObject({ enabled: false });
  expect(await cli("status")).toMatchObject({ enabled: false, revision: 2 });
  expect(await inspector(false)).toMatchObject({ enabled: false, revision: 2 });
});

it("serializes simultaneous on commands and pauses before resetting an override", async () => {
  const [first, second] = await Promise.all([cli("on"), inspector(true)]);
  expect(first).toMatchObject({ enabled: true, revision: 1 });
  expect(second).toMatchObject({ rule_ref: first.rule_ref, revision: 1 });
  const reset = await fetch(base, { method: "DELETE" });
  expect(reset.ok).toBe(true);
  expect(await store.get("codex", id)).toBeNull();
  const durable = JSON.parse(await readFile(join(root, "rule.json"), "utf8"));
  expect(durable).toMatchObject({ enabled: false, revision: 2 });
  expect(await cli("on")).toMatchObject({ rule_ref: first.rule_ref, revision: 3 });
});

it("returns the saved legacy status and refuses a human-stopped on from either surface", async () => {
  await store.set({ harness: "codex", sessionId: id, cwd: root }, true);
  expect(await inspector()).toMatchObject({ enabled: true, source: "session" });
  const { getHumanStopStore } = await import("../src/human-stop-store.js");
  await getHumanStopStore().hold({ harness: "codex", id, cwd: root },
    { id: "stop", reason: "operator", at: new Date().toISOString(), turnId: "turn" });
  expect(await cli("on")).toMatchObject({ enabled: false, human_stop_held: true });
  expect(await inspector(true)).toMatchObject({ enabled: false, human_stop_held: true });
  await expect(readFile(join(root, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the exact registered instance when several Codex owners share the state directory", async () => {
  const second = join(root, "second.json");
  await writeFile(second, JSON.stringify({ owner: { kind: "codex", node: "other", instance: "codex-2", codex_autopilot: { state_dir: state } } }), { mode: 0o600 });
  await writeFile(join(root, "selector.json"), JSON.stringify({ profiles: [join(root, "owner.json"), second] }));
  await expect(cli("on")).rejects.toThrow("Exact Codex instance required");
  expect(await store.get("codex", id)).toBeNull();
  await writeFile(join(root, "registered"), "");
  expect(await cli("on")).toMatchObject({ executor: "rust", enabled: true, revision: 1 });
  await writeFile(join(root, "busy-once"), "");
  expect(await cli("status")).toMatchObject({ revision: 1, enabled: true });
  await writeFile(join(root, "concurrent-pause"), "");
  expect(await inspector(false)).toMatchObject({ revision: 2, enabled: false });
});

it("retains a saved TypeScript executor on the selected session", async () => {
  await store.set({ harness: "codex", sessionId: id, cwd: root, executor: "typescript" }, false);
  expect(await cli("on")).toMatchObject({ enabled: true });
  expect(await store.get("codex", id)).toMatchObject({ executor: "typescript" });
  await expect(readFile(join(root, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves foreign harness rows and another Rust rule's exact policy timestamp on writes", async () => {
  const foreign = { harness: "minimax-code", sessionId: "other-harness", cwd: root, enabled: true,
    updatedAt: "2026-11-21T01:00:00+03:00", futureField: [1, 2] };
  const otherRule = { harness: "codex", sessionId: "other-rule", cwd: root, enabled: true,
    executor: "rust", updatedAt: "2026-11-20T22:00:00+00:00" };
  const path = join(state, "sessions.json");
  await writeFile(path, JSON.stringify({ version: 1, sessions: [foreign, otherRule] }));
  expect(await cli("status")).toMatchObject({ enabled: false });
  await store.set({ harness: "codex", sessionId: id, cwd: root }, false);
  expect(JSON.parse(await readFile(path, "utf8")).sessions).toEqual(expect.arrayContaining([foreign, otherRule]));
});
