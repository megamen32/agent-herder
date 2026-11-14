import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,
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
      const message = db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?)");
      message.run("message-user", SESSION, 1, 100, 200, JSON.stringify({ role: "user", source: "fixture" }));
      message.run("message-assistant", SESSION, 2, 110, 200, JSON.stringify({ role: "assistant", error: "terminal fixture error" }));
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

function rejects(fn: () => unknown, code: ZcodeColdFailure) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ZcodeColdContinuationError);
  expect(error).toMatchObject({ code });
}

function prepared(before: ZcodeColdPreflight) {
  return {
    snapshot: {
      session: { sessionId: before.sessionId, status: "idle" },
      runtime: { activeTurnId: null as string | null, activeTurnKind: null as string | null, pendingRequestIds: [] as string[] },
      settings: { model: { current: structuredClone(before.modelSelection) }, permission: { ...structuredClone(before.permission), rulesRevision: 7 } as Record<string, unknown> },
    },
    queue: {
      sessionId: before.sessionId, revision: 7,
      queue: { items: [] as unknown[], autoDrain: true },
      control: { activeWorks: [] as unknown[], apiRetry: null as unknown, stopState: "idle",
        canStop: false, sessionEnded: false, phase: "error" },
    },
  };
}

describe("ZCode cold continuation eligibility and final native proof", () => {
  it("accepts a settled terminal error and requires independently idle runtime plus empty queue", () => {
    const native = fixture();
    const before = native.read();
    expect(before).toMatchObject({
      sessionId: SESSION, workspace: { workspacePath: WORKSPACE, workspaceIdentity: WORKSPACE, workspaceKey: WORKSPACE },
      modelSelection: MODEL, permission: PERMISSION, lastTurnId: "turn-1", messageCount: 2,
    });
    expect(before.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const live = prepared(before);
    expect(() => assertZcodePreparedContinuation(before, live.snapshot, live.queue)).not.toThrow();
    expect(() => assertZcodeColdPreflightUnchanged(before, native.read())).not.toThrow();
  });

  it("accepts an exactly empty cold conversation with persisted model and permission", () => {
    expect(fixture(true).read()).toMatchObject({ lastTurnId: null, messageCount: 0, modelSelection: MODEL, permission: PERMISSION });
  });

  it("rejects pending, admitted or unknown input admission", () => {
    const native = fixture();
    for (const status of ["pending", "admitted", "unknown"]) {
      native.change("UPDATE session_input SET status=?", status);
      rejects(native.read, "pending_native_input");
    }
  });

  it("rejects a promoted input unless its exact message has a settled turn", () => {
    const native = fixture();
    native.change("UPDATE session_input SET promoted_message_id=?", "different-message");
    rejects(native.read, "promoted_input_unsettled");
    native.change("UPDATE session_input SET promoted_message_id=?", "message-user");
    native.change("DELETE FROM turn_usage");
    rejects(native.read, "promoted_input_unsettled");
  });

  it("rejects unfinished turns and inconsistent completion timestamps", () => {
    const native = fixture();
    native.change("UPDATE turn_usage SET status=?,completed_at=?", "running", null);
    rejects(native.read, "unfinished_native_turn");
    native.change("UPDATE turn_usage SET status=?,completed_at=?", "error", 99);
    rejects(native.read, "unfinished_native_turn");
  });

  it("rejects unfinished model requests and tool calls even after a terminal turn", () => {
    const native = fixture();
    for (const table of ["model_usage", "tool_usage"]) {
      native.change("UPDATE " + table + " SET status=?,completed_at=?", "running", 190);
      rejects(native.read, "unfinished_native_work");
      native.change("UPDATE " + table + " SET status=?,completed_at=?", "error", null);
      rejects(native.read, "unfinished_native_work");
      native.change("UPDATE " + table + " SET status=?,completed_at=?", "error", 190);
    }
  });

  it("rejects latest human cancellation by either native cancellation field", () => {
    const native = fixture();
    native.change("UPDATE turn_usage SET cancelled_by_user=1");
    rejects(native.read, "native_human_stop");
    native.change("UPDATE turn_usage SET cancelled_by_user=0,status=?", "cancelled");
    rejects(native.read, "native_human_stop");
  });

  it("rejects persisted runtime ownership", () => {
    const native = fixture();
    native.change("INSERT INTO session_runtime_presence VALUES(?,?,?)", SESSION, "native-runtime-owner", 1234);
    rejects(native.read, "native_runtime_owner");
  });

  it("rejects a retained native goal", () => {
    const native = fixture();
    native.change("INSERT INTO session_target VALUES(?,?,?,?,?,?)", SESSION, "goal-1", "paused", null, null, null);
    rejects(native.read, "native_goal");
  });

  it("rejects absent, duplicate or malformed persisted model selection", () => {
    const native = fixture();
    for (const value of ["bad-json", "[]", "{}", JSON.stringify({ modelSelection: { providerId: "fixture-provider" } })]) {
      native.change("UPDATE session_entry SET data=?", value);
      rejects(native.read, "model_unverified");
    }
    native.change("UPDATE session_entry SET data=?", JSON.stringify({ modelSelection: MODEL }));
    native.change("INSERT INTO session_entry VALUES(?,?,?)", SESSION, "runtime/model_selection", JSON.stringify({ modelSelection: MODEL }));
    rejects(native.read, "model_unverified");
    native.change("DELETE FROM session_entry");
    rejects(native.read, "model_unverified");
  });

  it("rejects unverified persisted permission", () => {
    const native = fixture();
    for (const value of [null, "bad-json", "[]", "{}", JSON.stringify({ mode: "unrecognized" })]) {
      native.change("UPDATE session SET permission=?", value);
      rejects(native.read, "permission_unverified");
    }
  });

  it("rejects reverted, deleted, missing or differently scoped sessions", () => {
    const native = fixture();
    native.change("UPDATE session SET revert=?", "{}");
    rejects(native.read, "session_unverified");
    native.change("UPDATE session SET revert=NULL,time_deleted=1");
    rejects(native.read, "session_unverified");
    native.change("UPDATE session SET time_deleted=NULL,workspace_id=?", "/fixture/other-project");
    rejects(native.read, "workspace_unverified");
    native.change("UPDATE session SET workspace_id=NULL,directory=?", "relative/project");
    rejects(native.read, "workspace_unverified");
    rejects(() => readZcodeColdPreflight(native.path, "different-session"), "session_unverified");
  });

  it("requires matching idle runtime and complete empty V4 queue after preparation", () => {
    const before = fixture().read();
    const runtimeMutations = [
      (value: ReturnType<typeof prepared>) => { value.snapshot.session.sessionId = "other"; },
      (value: ReturnType<typeof prepared>) => { value.snapshot.session.status = "busy"; },
      (value: ReturnType<typeof prepared>) => { value.snapshot.runtime.activeTurnId = "new-turn"; },
      (value: ReturnType<typeof prepared>) => { value.snapshot.runtime.activeTurnKind = "user"; },
      (value: ReturnType<typeof prepared>) => { value.snapshot.runtime.pendingRequestIds.push("pending"); },
    ];
    for (const mutate of runtimeMutations) {
      const live = prepared(before); mutate(live);
      rejects(() => assertZcodePreparedContinuation(before, live.snapshot, live.queue), "runtime_not_idle");
    }
    const queueMutations = [
      (value: ReturnType<typeof prepared>) => { value.queue.sessionId = "other"; },
      (value: ReturnType<typeof prepared>) => { value.queue.revision = Number.NaN; },
      (value: ReturnType<typeof prepared>) => { value.queue.queue.items.push({ id: "pending-input" }); },
      (value: ReturnType<typeof prepared>) => { value.queue.control.activeWorks.push({ id: "work" }); },
      (value: ReturnType<typeof prepared>) => { value.queue.control.apiRetry = { scheduled: true }; },
      (value: ReturnType<typeof prepared>) => { value.queue.control.stopState = "stopping"; },
      (value: ReturnType<typeof prepared>) => { value.queue.control.canStop = true; },
      (value: ReturnType<typeof prepared>) => { value.queue.control.sessionEnded = true; },
      (value: ReturnType<typeof prepared>) => { value.queue.control.phase = "running"; },
    ];
    for (const mutate of queueMutations) {
      const live = prepared(before); mutate(live);
      rejects(() => assertZcodePreparedContinuation(before, live.snapshot, live.queue), "queue_not_empty");
    }
    const live = prepared(before);
    rejects(() => assertZcodePreparedContinuation(before, live.snapshot, {}), "queue_not_empty");
  });

  it("requires unchanged model and every persisted permission field after preparation", () => {
    const before = fixture().read();
    const live = prepared(before);
    rejects(() => assertZcodePreparedContinuation(before, { ...live.snapshot, settings: {} }, live.queue), "model_changed");
    live.snapshot.settings.model.current = { providerId: "different-provider", modelId: "different-model" };
    rejects(() => assertZcodePreparedContinuation(before, live.snapshot, live.queue), "model_changed");
    const permissionChanged = prepared(before);
    permissionChanged.snapshot.settings.permission.mode = "yolo";
    rejects(() => assertZcodePreparedContinuation(before, permissionChanged.snapshot, permissionChanged.queue), "permission_changed");
    const rulesChanged = prepared(before);
    rulesChanged.snapshot.settings.permission.rules = { "*": "allow" };
    rejects(() => assertZcodePreparedContinuation(before, rulesChanged.snapshot, rulesChanged.queue), "permission_changed");
  });

  it("detects exact-session changes and message or part edits without count or timestamp changes", () => {
    const native = fixture();
    const before = native.read();
    rejects(() => assertZcodeColdPreflightUnchanged(before, { ...before, sessionId: "other" }), "persisted_state_changed");
    native.change("UPDATE message SET data=? WHERE id=?", JSON.stringify({ role: "assistant", error: "different native bytes" }), "message-assistant");
    const messageChanged = native.read();
    expect(messageChanged.messageCount).toBe(before.messageCount);
    rejects(() => assertZcodeColdPreflightUnchanged(before, messageChanged), "persisted_state_changed");
    native.change("UPDATE part SET data=? WHERE id=?", JSON.stringify({ type: "text", text: "edited part with same row timestamps" }), "part-1");
    rejects(() => assertZcodeColdPreflightUnchanged(messageChanged, native.read()), "persisted_state_changed");
  });
});
