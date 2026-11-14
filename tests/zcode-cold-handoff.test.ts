import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertZcodeColdPreflightUnchanged, assertZcodePreparedContinuation, readZcodeColdPreflight,
  ZcodeColdContinuationError, type ZcodeColdFailure, type ZcodeColdPreflight,
} from "../src/adapters/zcode-cold-continuation.js";

const SESSION = "cold-exact-session";
const WORKSPACE = "/fixture/exact-project";
const MODEL = { providerId: "fixture-provider", modelId: "fixture-model", options: { temperature: 0.2 } };
const PERMISSION = { mode: "build", rules: { "*.ts": "allow" } };
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(empty = false) {
  const directory = mkdtempSync(join(tmpdir(), "herder-zcode-cold-"));
  directories.push(directory);
  const path = join(directory, "native.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`BEGIN;
      CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,revert TEXT,time_deleted INTEGER,
        permission TEXT,last_outcome TEXT,time_updated INTEGER);
      CREATE TABLE session_input(id TEXT PRIMARY KEY,session_id TEXT,kind TEXT,status TEXT,status_reason TEXT,
        promoted_message_id TEXT,admitted_sequence INTEGER,promoted_sequence INTEGER,time_updated INTEGER);
      CREATE TABLE turn_usage(turn_id TEXT PRIMARY KEY,session_id TEXT,user_message_id TEXT,status TEXT,
        started_at INTEGER,completed_at INTEGER,cancelled_by_user INTEGER,model_request_count INTEGER,
        model_retry_count INTEGER,tool_call_count INTEGER);
      CREATE TABLE session_runtime_presence(session_id TEXT,owner_id TEXT,process_id INTEGER);
      CREATE TABLE session_target(session_id TEXT,target_id TEXT,status TEXT,active_input_id TEXT,
        active_run_started_at INTEGER,active_run_last_seen_at INTEGER);
      CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER);
      CREATE TABLE tool_usage(id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER);
      CREATE TABLE session_entry(session_id TEXT,type TEXT,data TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,sequence INTEGER,
        time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,sequence INTEGER,
        time_created INTEGER,time_updated INTEGER,data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?)").run(
      SESSION, WORKSPACE, WORKSPACE, null, null, JSON.stringify(PERMISSION), empty ? null : "error", 300,
    );
    db.prepare("INSERT INTO session_entry VALUES(?,?,?)").run(
      SESSION, "runtime/model_selection", JSON.stringify({ modelSelection: MODEL }),
    );
    if (!empty) {
      db.prepare("INSERT INTO session_input VALUES(?,?,?,?,?,?,?,?,?)").run(
        "input-1", SESSION, "user", "promoted", null, "message-user", 1, 1, 100,
      );
      db.prepare("INSERT INTO turn_usage VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        "turn-1", SESSION, "message-user", "error", 100, 200, 0, 1, 0, 1,
      );
      db.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?)").run("model-request-1", SESSION, "turn-1", "error", 100, 190);
      db.prepare("INSERT INTO tool_usage VALUES(?,?,?,?,?,?)").run("tool-1", SESSION, "turn-1", "success", 110, 180);
      const message = db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?,?)");
      message.run("message-user", SESSION, "user", 1, 100, 200, JSON.stringify({ role: "user", source: "fixture" }));
      message.run("message-assistant", SESSION, "assistant", 2, 110, 200, JSON.stringify({ role: "assistant", error: "terminal fixture error" }));
      db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?,?)").run(
        "part-1", SESSION, "message-user", 1, 100, 200, JSON.stringify({ type: "text", text: "fixture input" }),
      );
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  return {
    path,
    read: () => readZcodeColdPreflight(path, SESSION),
    change(sql: string, ...values: Array<string | number | null>) {
      const writer = new DatabaseSync(path);
      try { writer.prepare(sql).run(...values); } finally { writer.close(); }
    },
  };
}

import { ZcodeAdapter } from "../src/adapters/zcode.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

class ColdClient implements ZcodeClientLike {
  cold = true;
  active = false;
  calls: string[] = [];
  handlers = new Set<(payload: unknown) => void>();
  onSubscribe?: () => void;
  failSubscribe = false;
  snapshot: any = { session: { sessionId: SESSION, status: "idle" },
    runtime: { pendingRequestIds: [], eventSeq: 1, stateRevision: 0 },
    settings: { model: { current: MODEL }, permission: PERMISSION } };
  queue: any = { sessionId: SESSION, revision: 7, logEpoch: "epoch", seq: 1,
    queue: { items: [], autoDrain: true },
    control: { phase: "error", activeWorks: [], apiRetry: null, stopState: "idle", canStop: false, sessionEnded: false } };
  async start() {}
  async close() { this.handlers.clear(); this.active = false; }
  listen(_channel: string, _event: string, _arg: unknown, handler: (payload: unknown) => void) {
    this.handlers.add(handler); return () => this.handlers.delete(handler);
  }
  emit() { for (const fn of this.handlers) fn({ subscriptionId: "subscription-1", topic: "conversation/" + SESSION,
    fromSeq: 0, toSeq: 1, payload: { kind: "snapshot", snapshot: this.queue } }); }
  async call(channel: string, method: string, args: unknown[]) { return this.callIfReady(channel, method, args); }
  async callIfReady(_channel: string, method: string, _args: unknown[]): Promise<unknown> {
    this.calls.push(method);
    if (method === "readSession") {
      if (this.cold) throw new Error("Session runtime is not ready");
      return this.snapshot;
    }
    if (method === "subscribeConversationV4") {
      this.cold = false; this.active = true; this.onSubscribe?.();
      if (this.failSubscribe) throw new Error("lost subscription acknowledgement");
      this.emit(); return { ack: { subscriptionId: "subscription-1" } };
    }
    if (method === "resyncConversationV4") { this.emit(); return {}; }
    if (method === "unsubscribeConversationV4") { this.active = false; return {}; }
    throw new Error("unexpected fake method " + method);
  }
}
function handoff(native: ReturnType<typeof fixture>) {
  const client = new ColdClient();
  const adapter = new ZcodeAdapter({ client, cwd: WORKSPACE, localDbPath: native.path });
  vi.spyOn(adapter, "nativeReadWithoutActivation", "get").mockReturnValue(true);
  vi.spyOn(getHumanStopStore(), "isHeld").mockResolvedValue(false);
  const send = vi.spyOn(adapter, "sendMessage").mockImplementation(async (id, options) => {
    expect(client.active).toBe(true);
    expect(id).toBe(SESSION);
    return { ok: true, admitted: true, inputId: options.inputId, nativeInputMessageId: "msg_new_exact" };
  });
  return { adapter, client, send };
}
const input = { queue: true, message: "one exact continuation", inputId: "process-wake:exact-rule" };

describe("ZCode controlled AHAP cold preparation", () => {
  it("reports typed cold eligibility without activating or treating historical error as idle", async () => {
    const native = fixture(), h = handoff(native);
    vi.spyOn(h.adapter, "getSession").mockResolvedValue({
      id: SESSION, harness: "zcode", cwd: WORKSPACE, hostId: "fixture", title: "fixture",
      status: "error", needsPermission: false, lastActivity: new Date().toISOString(), meta: { nativeLoaded: false },
    });
    const result = await h.adapter.getQueuedContinuationState(SESSION);
    expect(result).toMatchObject({ status: "error", meta: { nativeStateObserved: false, nativeLoaded: false,
      nativeColdContinuation: { state: "cold_preparable", sessionId: SESSION, contract: "cold-queue-subscription-v1" } } });
    expect(h.client.calls).toEqual(["readSession"]);
    expect(h.client.cold).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("holds one owned subscription through one exact keyed send and then releases it", async () => {
    const h = handoff(fixture());
    const result = await h.adapter.sendHerderQueuedMessage(SESSION, input);
    expect(result).toMatchObject({ ok: true, admitted: true, inputId: input.inputId, nativeInputMessageId: "msg_new_exact" });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(SESSION, input);
    expect(h.client.calls.filter(x => x === "subscribeConversationV4")).toHaveLength(1);
    expect(h.client.calls.filter(x => x === "unsubscribeConversationV4")).toHaveLength(1);
    expect(h.client.active).toBe(false);
    expect(h.client.calls).not.toContain("ensureSessionReady");
    expect(h.client.calls).not.toContain("resumeSession");
    expect(h.client.calls).not.toContain("setAutoDrain");
    expect(h.client.calls).not.toContain("setMode");
  });

  it("refuses a pending persistent input before any lifecycle call", async () => {
    const native = fixture(); native.change("UPDATE session_input SET status='admitted'");
    const h = handoff(native), result = await h.adapter.sendHerderQueuedMessage(SESSION, input);
    expect(result).toMatchObject({ notSubmitted: true, admitted: false });
    expect(h.client.calls).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps an arriving input after activation UNKNOWN without sending or draining", async () => {
    const native = fixture(), h = handoff(native);
    h.client.onSubscribe = () => native.change("UPDATE session_input SET status='admitted'");
    const result = await h.adapter.sendHerderQueuedMessage(SESSION, input);
    expect(result).toMatchObject({ ok: false, admission: "unknown", admissionUnknown: true });
    expect(result.notSubmitted).not.toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.client.calls.filter(x => x === "subscribeConversationV4")).toHaveLength(1);
    expect(h.client.active).toBe(false);
  });

  it("does not replay an unacknowledged lifecycle boundary", async () => {
    const h = handoff(fixture()); h.client.failSubscribe = true;
    const result = await h.adapter.sendHerderQueuedMessage(SESSION, input);
    expect(result).toMatchObject({ admission: "unknown", admissionUnknown: true });
    expect(result.notSubmitted).not.toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.client.calls.filter(x => x === "subscribeConversationV4")).toHaveLength(1);
    expect(h.client.handlers.size).toBe(0);
  });

  it("checks native model, permission and queue after preparation before sending", async () => {
    for (const mutate of [
      (h: ReturnType<typeof handoff>) => { h.client.snapshot.settings.model.current = { ...MODEL, modelId: "changed" }; },
      (h: ReturnType<typeof handoff>) => { h.client.snapshot.settings.permission = { mode: "yolo" }; },
      (h: ReturnType<typeof handoff>) => { h.client.queue.queue.items = [{ queueItemId: "somebody-elses-input" }]; },
    ]) {
      const h = handoff(fixture()); mutate(h);
      const result = await h.adapter.sendHerderQueuedMessage(SESSION, input);
      expect(result).toMatchObject({ admissionUnknown: true });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.client.active).toBe(false);
    }
  });

  it("uses the same bounded native lease for a warm idle continuation", async () => {
    const h = handoff(fixture()); h.client.cold = false;
    expect(await h.adapter.sendHerderQueuedMessage(SESSION, input)).toMatchObject({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.client.calls.filter(x => x === "subscribeConversationV4")).toHaveLength(1);
    expect(h.client.active).toBe(false);
  });

  it("preserves UNKNOWN when the later keyed send has no exact receipt", async () => {
    const h = handoff(fixture());
    h.send.mockResolvedValue({ ok: false, admitted: false, notSubmitted: true, inputId: input.inputId });
    expect(await h.adapter.sendHerderQueuedMessage(SESSION, input)).toMatchObject({ admissionUnknown: true, admission: "unknown" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.client.active).toBe(false);
  });
});
