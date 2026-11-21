import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { createDefaultAutopilotPolicy } from "../src/autopilot/policy.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { nativeAutopilotCommand } from "../src/autopilot/native-command.js";
import { createWebServer } from "../src/web/server.js";
import { canonicalFixture } from "./helpers/canonical-herder-fixture.js";
import { createCanonicalAutomationClient, unwrapCanonicalResult } from "../src/canonical-herder.js";
import { FleetGptAdminTransport } from "../src/mesh/fleet-gptadmin-transport.js";
import { registeredTransport } from "./fixtures/autopilot-command-owner.mjs";

const execute = promisify(execFile);
const id = "exact-thread";
let root: string, state: string, store: AutopilotSessionStore, policy: AutopilotPolicyStore;
let server: Server, base: string, registeredSelector: string;
let fixture: Awaited<ReturnType<typeof canonicalFixture>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "herder-rule-client-"));
  state = join(root, "state");
  await mkdir(state);
  vi.stubEnv("HOME", root);
  vi.stubEnv("HERDER_V1_ENTRY", undefined);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", state);
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(state, "human-stops.json"));
  vi.resetModules();
  const launcher = join(root, ".local/bin/agent-herder-v1");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\necho writer-start >> "' + join(root, "unexpected-spawn") + '"\nexit 93\n', {mode: 0o700});
  const config = join(root, ".config/agent-herder");
  await mkdir(config, { recursive: true });
  registeredSelector = join(config, "gptadmin-entry.json");
  await writeFile(registeredSelector, JSON.stringify({ profiles: [join(root, "owner.json")] }), {mode: 0o600});
  await writeFile(join(config, "v1-entry.json"), JSON.stringify({ profiles: [join(root, "decoy.json")] }), {mode: 0o600});
  for (const [file, instance] of [["owner.json","codex-local"], ["decoy.json","codex-decoy"]]) {
    await writeFile(join(root,file), JSON.stringify({owner:{kind:"codex", node:"local", instance,
      codex_autopilot:{state_dir:state}}}), {mode:0o600});
  }
  fixture = await canonicalFixture();
  const authority = fixture.config.authority;
  const registered = registeredTransport(root, registeredSelector, authority);
  const transport = new FleetGptAdminTransport({ endpoint: "http://127.0.0.1/fixture-hub", nativeHerderAuthority: authority,
    headersProvider: () => ({}), unwrapResponse: unwrapCanonicalResult, fetch: async (_url, options) => {
      const frame = JSON.parse(String(options?.body));
      if (frame.method === "notifications/initialized") return new Response(null, {status: 204});
      let result = {};
      if (frame.method === "tools/call") {
        expect(frame.params.name).toBe("exec");
        const code = /^return await mcp\.call\((.*)\);$/.exec(frame.params.arguments.code);
        if (!code) throw new Error("unexpected canonical request");
        const [target, tool, args] = JSON.parse("[" + code[1] + "]");
        result = await registered.call(target, tool, args);
      }
      return Response.json({jsonrpc: "2.0", id: frame.id, result});
    } });
  const canonicalClient = await createCanonicalAutomationClient({env: fixture.env, transportFactory: async () => transport});
  store = new AutopilotSessionStore(join(state, "sessions.json"));
  policy = new AutopilotPolicyStore(join(state, "autopilot-policy.json"));
  server = createWebServer({ adapters: new Map(), converter: { async convert() { throw new Error("unused"); } },
    autopilotSessionStore: store, autopilotPolicyStore: policy, canonicalClient, mcpAuthToken: "stand-operator" });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("AGENT_HERDER_URL", endpoint);
  base = endpoint + "/api/autopilot/sessions/codex/" + id;
});
afterEach(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  const spawned = await readFile(join(root, "unexpected-spawn"), "utf8").catch(() => "");
  await fixture.cleanup();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  expect(spawned, "autopilot started the alternate Rust writer").toBe("");
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
  const log = await readFile(join(root,"calls.jsonl"),"utf8").catch(() => "");
  expect(log.trim().split("\n").filter(Boolean).every(line => JSON.parse(line).action === "resolve")).toBe(true);
});

it("uses the exact registered instance when several Codex owners share the state directory", async () => {
  const second = join(root, "second.json");
  await writeFile(second, JSON.stringify({ owner: { kind: "codex", node: "other", instance: "codex-2", codex_autopilot: { state_dir: state } } }), { mode: 0o600 });
  await writeFile(registeredSelector, JSON.stringify({ profiles: [join(root, "owner.json"), second] }));
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

it("never starts the default selector or takes over after a registered transport failure", async () => {
  await writeFile(join(root, "transport-down"), "");
  await expect(cli("on")).rejects.toThrow("registered_transport_unavailable");
  expect(await store.get("codex", id)).toBeNull();
  await rm(join(root, "transport-down"));
  expect(await cli("on")).toMatchObject({ executor: "rust", enabled: true, revision: 1 });
  const row = await store.get("codex", id);
  await writeFile(join(root,"transport-down"), "");
  await expect(cli("status")).rejects.toThrow("registered_transport_unavailable");
  await expect(cli("on")).rejects.toThrow("registered_transport_unavailable");
  expect(await store.get("codex", id)).toEqual(row);
  await expect(cli("off")).rejects.toThrow("registered_transport_unavailable");
  expect(await store.get("codex", id)).toMatchObject({ executor:"rust", enabled:false });
  expect((await fetch(base + "?cwd=" + encodeURIComponent(root))).status).toBe(503);
});

it("rejects incorrect panel credentials before changing a session", async () => {
  vi.stubEnv("AGENT_HERDER_HTTP_TOKEN", "wrong-stand-token");
  await expect(cli("on")).rejects.toThrow();
  expect(await store.get("codex",id)).toBeNull();
  vi.stubEnv("AGENT_HERDER_HTTP_TOKEN", "stand-operator");
  expect(await cli("on")).toMatchObject({executor:"rust",enabled:true});
});

it("rejects fields outside the registered autopilot protocol before contacting the hub", async () => {
  const authority = fixture.config.authority;
  const send = vi.fn(async () => { throw new Error("unexpected outbound call"); });
  const transport = new FleetGptAdminTransport({endpoint: "http://127.0.0.1/fixture-hub", headersProvider: () => ({}),
    nativeHerderAuthority: authority, fetch: send});
  const rule = {kind: "autopilot", instructions: "Check the last turn"};
  const update = {action: "update", revision: 2, rule_ref: "rule", rule};
  for (const [tool, args] of [
    ["discover", {action: "instances", profiles: ["wrong"]}],
    ["session", {action: "register", native_session_id: id, instance_ref: "instance", request_key: "key", message: "extra"}],
    ["automation", {action: "list", session_ref: ""}],
    ["automation", {...update, revision: 0}],
    ["automation", {...update, rule: {...rule, kind: "timer"}}],
    ["automation", {...update, rule: {...rule, instructions: " "}}],
    ["automation", {...update, rule: {...rule, instructions: "я".repeat(2049)}}],
    ["automation", {action: "create", session_ref: "s", request_key: "key", rule: {...rule, target: "other"}}],
  ] as const) await expect(transport.call(authority, tool, args)).rejects.toThrow("native_herder_call_not_allowed");
  expect(send).not.toHaveBeenCalled();
});

it("keeps a saved Rust pause effective when the panel restarts without its canonical client", async () => {
  const target = {harness: "codex" as const, sessionId: id, cwd: root};
  await cli("on");
  await expect(nativeAutopilotCommand(undefined, "off", target, store, policy)).rejects.toThrow("owner unavailable");
  expect(await store.get("codex", id)).toMatchObject({executor: "rust", enabled: false});
  await policy.replacePolicy({...createDefaultAutopilotPolicy(), judgeMode: "self"}, null);
  expect(await nativeAutopilotCommand(undefined, "status", target, store, policy)).toBeUndefined();
});
