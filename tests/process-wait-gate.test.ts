import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessWaitGate, processWaitBlocks, type ProcessWaitDecision } from "../src/process-wait-gate.js";
import { createAutopilotCore, type AutopilotDecision, type StopHookInput } from "../src/autopilot/index.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "herder-process-wait-gate-"));
  roots.push(root);
  return root;
}

const input: StopHookInput = {
  hook_event_name: "Stop", session_id: "build-session", cwd: "/tmp/fixture", turn_id: "build-turn",
  last_assistant_message: "The build is registered and running.", transcript_path: null,
  stop_hook_active: false, harness: "zcode",
};

describe("canonical process wait source", () => {
  it("does not cache a false result across registration or completion", async () => {
    let blocked = false;
    const query = vi.fn(async () => ({ blocked, reason: blocked ? "process_wait_active" : "no_process_wait" }));
    const gate = createProcessWaitGate({ query, nodeRef: "execution-node" });
    expect(await gate.blocks("codex", "native-id")).toBe(false);
    blocked = true;
    expect(await gate.blocks("codex", "native-id")).toBe(true);
    blocked = false;
    expect(await gate.blocks("codex", "native-id")).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toEqual({ harness: "codex", nativeSessionId: "native-id", nodeRef: "execution-node" });
  });

  it("defers malformed responses and unavailable canonical readers", async () => {
    const unavailable = createProcessWaitGate({ query: async () => { throw new Error("offline"); } });
    expect(await unavailable.blocks("codex", "native")).toBe(true);
    const malformed = createProcessWaitGate({ query: async () => ({ blocked: "false" } as unknown as ProcessWaitDecision) });
    expect(await malformed.blocks("codex", "native")).toBe(true);
    expect(await processWaitBlocks({ blocks: async () => { throw new Error("reader failed"); } }, "codex", "native")).toBe(true);
  });

  it("does not infer permission from an unavailable explicitly configured selector", async () => {
    const root = await directory();
    const gate = createProcessWaitGate({ selector: join(root, "missing-selector.json") });
    expect(await gate.blocks("codex", "native")).toBe(true);
  });

  it("recognizes a verified legacy manifest without starting a runtime", async () => {
    const root = await directory();
    const manifest = join(root, "manifest.json");
    const bytes = JSON.stringify({ source_commit: "legacy", profiles: [] });
    await writeFile(manifest, bytes, { mode: 0o600 });
    const selector = join(root, "selector.json");
    await writeFile(selector, JSON.stringify({
      manifest, manifest_sha256: createHash("sha256").update(bytes).digest("hex"), profiles: [],
    }), { mode: 0o600 });
    const gate = createProcessWaitGate({ selector, launcher: join(root, "must-not-start") });
    expect(await gate.blocks("codex", "native")).toBe(false);
    await writeFile(manifest, "{}");
    expect(await gate.blocks("codex", "native")).toBe(true);
  });
});

describe("process waits defer automatic model work", () => {
  it("skips all new Stop judgements while armed and allows work after canonical completion", async () => {
    let blocked = true;
    const judge = { decide: vi.fn(async () => ({ kind: "continue", nextGoal: "Read the receipt." } satisfies AutopilotDecision)) };
    const receipts = new Map();
    const core = createAutopilotCore({
      judge, notify: { send: vi.fn(async () => undefined) }, allowSessions: new Set([input.session_id]),
      receiptStore: receipts, maxContinuationsPerSession: 3, harness: "zcode",
      processWaits: { blocks: async () => blocked },
    });
    expect(await core.handleStop(input)).toEqual({});
    expect(await core.handleStop({ ...input, turn_id: "later-idle-turn" })).toEqual({});
    expect(judge.decide).not.toHaveBeenCalled();
    expect(receipts.size).toBe(0);
    blocked = false;
    await core.handleStop(input);
    expect(judge.decide).toHaveBeenCalledTimes(1);
  });

  it("does not continue when a wait is armed during an already running judge request", async () => {
    let blocked = false;
    let finish!: (decision: AutopilotDecision) => void;
    const judge = { decide: vi.fn(() => new Promise<AutopilotDecision>(resolve => { finish = resolve; })) };
    const receipts = new Map();
    const core = createAutopilotCore({
      judge, notify: { send: vi.fn(async () => undefined) }, allowSessions: new Set([input.session_id]),
      receiptStore: receipts, maxContinuationsPerSession: 3, processWaits: { blocks: async () => blocked },
    });
    const pending = core.handleStop(input);
    await vi.waitFor(() => expect(judge.decide).toHaveBeenCalledTimes(1));
    blocked = true;
    finish({ kind: "continue", nextGoal: "This continuation must be deferred." });
    expect(await pending).toEqual({});
    expect(receipts.size).toBe(0);
  });

  it("defers a Stop judgement when the canonical query fails", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "continue", nextGoal: "Must not run" } satisfies AutopilotDecision)) };
    const core = createAutopilotCore({
      judge, notify: { send: vi.fn(async () => undefined) }, allowSessions: new Set([input.session_id]),
      receiptStore: new Map(), maxContinuationsPerSession: 3,
      processWaits: { blocks: async () => { throw new Error("scope busy"); } },
    });
    expect(await core.handleStop(input)).toEqual({});
    expect(judge.decide).not.toHaveBeenCalled();
  });

  it("preserves recovery state and avoids inventory/planner tokens while the process owns the wait", async () => {
    const root = await directory();
    let blocked = true;
    const session: AgentSession = {
      id: "waiting-build", harness: "zcode", status: "idle", title: "Build in progress",
      cwd: root, lastActivity: new Date(Date.now() - 10 * 60_000).toISOString(), needsPermission: false,
    };
    const adapter: HarnessAdapter = {
      type: "zcode", name: "process wait fixture", async init() {},
      async listSessions() { return [session]; },
      async getSession(id) { return id === session.id ? session : null; },
      async getMessages() { return [
        { id: "user", role: "user", text: "Build the project", parts: [{ type: "text", text: "Build the project" }] },
        { id: "assistant", role: "assistant", text: "Waiting for the registered process", parts: [{ type: "text", text: "Waiting for the registered process" }] },
      ]; },
      resumeSession: vi.fn(async () => ({ ok: true })),
      sendMessage: vi.fn(async () => ({ ok: true })),
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    await store.markRecoveryEligible(session, "turn.failed", { turnId: "old-turn" });
    const before = await store.list();
    const judge = {
      decide: vi.fn(async () => ({ verdict: "unfinished" as const, reason: "fixture", confidence: 1 })),
      plan: vi.fn(async () => ({ groups: [{
        sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed" as const,
        reason: "Fixture completion", confidence: 1, topic: "Build", handoff: "",
      }] })),
    };
    const humanStopStore = new HumanStopStore(join(root, "human-stops.json"));
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "autostart.json"), {}),
      humanStopStore, judge, processWaits: { blocks: async () => blocked }, discoveryIdleMs: 0,
    });
    expect(await launcher.armSession(session)).toBe(false);
    await launcher.auditInventory();
    expect(judge.decide).not.toHaveBeenCalled();
    expect(judge.plan).not.toHaveBeenCalled();
    expect(adapter.resumeSession).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect((await store.list()).length).toBe(before.length);
    expect(await humanStopStore.isHeld("zcode", session.id)).toBe(false);
    blocked = false;
    expect(await launcher.armSession(session)).toBe(true);
  });
});
