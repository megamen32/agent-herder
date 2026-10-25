import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

it("answers an approval only on the same Codex RPC connection and exact thread", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket" });
  const internals = adapter as any;
  const writes: unknown[] = [];
  internals.threads.set("thread-fixture", { id: "thread-fixture" });
  internals.ensureReady = async () => undefined;
  internals.request = async () => ({ thread: { id: "thread-fixture" }, approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
  internals.isTransportWritable = () => true;
  internals.writeMessage = (message: unknown) => writes.push(message);
  internals.handleServerRequest({
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "item-fixture", command: "cat marker.txt", reason: "Read test marker" },
  });

  const state = await adapter.getPermissionState("thread-fixture");
  expect(state).toMatchObject({
    target: { harness: "codex", sessionId: "thread-fixture" },
    scope: "session",
    canSetMode: false,
    pendingRequests: [{ id: "77", turnId: "turn-fixture", itemId: "item-fixture", command: "cat marker.txt", canRespond: true,
      nativeMethod: "item/commandExecution/requestApproval" }],
  });
  expect(await adapter.respondPermission("another-thread", "77", "allow")).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
  const replying = adapter.respondPermission("thread-fixture", "77", "allow");
  internals.consumeMessage({ method: "serverRequest/resolved", params: { threadId: "thread-fixture", requestId: 77 } });
  expect(await replying).toEqual({ ok: true });
  expect(writes).toEqual([{ id: 77, result: { decision: "accept" } }]);
  expect(await adapter.respondPermission("thread-fixture", "77", "allow")).toMatchObject({ ok: false });
  expect(writes).toHaveLength(1);
  await adapter.dispose();
});

it("does not translate a Codex permission-subset request into allow-all", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket" });
  const internals = adapter as any;
  const writes: unknown[] = [];
  internals.threads.set("thread-fixture", { id: "thread-fixture" });
  internals.ensureReady = async () => undefined;
  internals.request = async () => ({ thread: { id: "thread-fixture" }, approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
  internals.isTransportWritable = () => true;
  internals.writeMessage = (message: unknown) => writes.push(message);
  internals.handleServerRequest({ id: 78, method: "item/permissions/requestApproval", params: { threadId: "thread-fixture" } });
  expect(await adapter.getPermissionState("thread-fixture")).toMatchObject({
    pendingRequests: [{ id: "78", canRespond: false, nativeMethod: "item/permissions/requestApproval", unsupportedReason: expect.any(String) }],
  });
  expect(await adapter.respondPermission("thread-fixture", "78", "allow")).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
  await adapter.dispose();
});

it("keeps Codex mode switching unavailable for a thread not created by this owner", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket" });
  const internals = adapter as any;
  const calls: Array<{ method: string; params: unknown }> = [];
  internals.ensureReady = async () => undefined;
  internals.request = async (method: string, params: unknown) => { calls.push({ method, params }); return { thread: { id: "thread-fixture" } }; };
  expect(await adapter.setPermissions("thread-fixture", { mode: "fullAuto" })).toMatchObject({ ok: false, nonRetryable: true, error: expect.stringContaining("created by this live app-server owner") });
  expect(calls).toHaveLength(0);
  const state = await adapter.getPermissionState("thread-fixture");
  expect(state).toMatchObject({ scope: "session", canSetMode: false, supportedModes: [] });
  expect(state?.currentMode).toBeUndefined();
  await adapter.dispose();
});

function settingsFixture(id: string, approvalPolicy: string, sandboxType: string) {
  return {
    thread: { id, cwd: "/tmp/codex-owned", status: "idle", canAcceptDirectInput: true },
    approvalPolicy,
    sandbox: sandboxType === "workspaceWrite"
      ? { type: sandboxType, writableRoots: ["/tmp/codex-owned"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: sandboxType },
    activePermissionProfile: null,
  };
}

async function ownedAdapterFixture(options: { timeout?: number; update?: (internals: any, params: any) => Promise<unknown> } = {}) {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket", requestTimeoutMs: options.timeout ?? 30 });
  const internals = adapter as any;
  const requests: Array<{ method: string; params: any }> = [];
  internals.ensureReady = async () => undefined;
  internals.isReady = () => true;
  internals.request = async (method: string, params: any = {}) => {
    requests.push({ method, params });
    if (method === "thread/start") return settingsFixture("owned-thread", "on-request", "workspaceWrite");
    if (method === "thread/name/set") return {};
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/tmp/codex-owned", status: "idle" } };
    if (method === "thread/loaded/list") return { data: ["owned-thread"], nextCursor: null };
    if (method === "thread/settings/update") {
      return options.update ? options.update(internals, params) : {};
    }
    return {};
  };
  const session = await adapter.createSession({ name: "owned fixture", cwd: "/tmp/codex-owned" });
  return { adapter, internals, requests, session };
}

it("uses only this owner's settings notification to read and change the exact Full Access profile", async () => {
  const { adapter, internals, requests, session } = await ownedAdapterFixture({
    update: async (server, params) => {
      expect(params).toMatchObject({
        threadId: "owned-thread", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
      });
      expect(params.permissions).toBeUndefined();
      expect(server.permissionSettingsWaiters.has("owned-thread")).toBe(true);
      server.consumeMessage({ method: "thread/settings/updated", params: {
        threadId: "owned-thread",
        threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null },
      } });
      return {};
    },
  });
  try {
    expect(await adapter.getPermissionState(session.id)).toMatchObject({
      target: { sessionId: "owned-thread" }, scope: "session", currentMode: "default",
      supportedModes: ["default", "fullAuto"], canSetMode: true,
    });
    await expect(adapter.setPermissions(session.id, { mode: "fullAuto" })).resolves.toMatchObject({ ok: true, sessionId: "owned-thread" });
    expect(await adapter.getPermissionState(session.id)).toMatchObject({
      currentMode: "fullAuto", scope: "session", canSetMode: true,
    });
    expect(requests.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
    expect(requests.some((call) => call.method === "thread/resume" || call.method === "turn/start" || call.method === "turn/steer")).toBe(false);
  } finally { await adapter.dispose(); }
});

it("does not acquire permission-mode ownership from thread/list, thread/read, or incidental resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-foreign-mode-"));
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket", codexDir: root });
  const internals = adapter as any;
  const calls: string[] = [];
  internals.ensureReady = async () => undefined;
  internals.isReady = () => true;
  internals.request = async (method: string, params: any = {}) => {
    calls.push(method);
    if (method === "thread/list") return { data: [{ id: "foreign-thread", cwd: "/tmp/foreign", name: "foreign", status: "idle" }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/tmp/foreign", status: "idle" } };
    if (method === "thread/resume") return settingsFixture("foreign-thread", "on-request", "workspaceWrite");
    return {};
  };
  try {
    await adapter.listSessions();
    const beforeResume = await adapter.getPermissionState("foreign-thread");
    expect(beforeResume).toMatchObject({ canSetMode: false, supportedModes: [] });
    expect(beforeResume?.currentMode).toBeUndefined();
    await expect(adapter.resumeSession("foreign-thread")).resolves.toEqual({ ok: true });
    const afterResume = await adapter.getPermissionState("foreign-thread");
    expect(afterResume).toMatchObject({ canSetMode: false, supportedModes: [] });
    expect(afterResume?.currentMode).toBeUndefined();
    await expect(adapter.setPermissions("foreign-thread", { mode: "fullAuto" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(calls).not.toContain("thread/settings/update");
    expect(internals.ownedPermissionThreads.has("foreign-thread")).toBe(false);
  } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("invalidates owned permission settings when its app-server owner generation disconnects", async () => {
  const { adapter, internals, session } = await ownedAdapterFixture();
  try {
    expect(await adapter.getPermissionState(session.id)).toMatchObject({ canSetMode: true, currentMode: "default" });
    internals.clearTransportState(new Error("fixture owner disconnected"), { reason: "fixture" }, false);
    const state = await adapter.getPermissionState(session.id);
    expect(state).toMatchObject({ canSetMode: false, supportedModes: [] });
    expect(state?.currentMode).toBeUndefined();
  } finally { await adapter.dispose(); }
});

it("refuses a mode change while an exact native approval is pending", async () => {
  const { adapter, internals, requests, session } = await ownedAdapterFixture();
  try {
    internals.handleServerRequest({
      id: 91, method: "item/commandExecution/requestApproval",
      params: { threadId: session.id, turnId: "turn-fixture", itemId: "item-fixture", command: "cat marker.txt" },
    });
    await expect(adapter.setPermissions(session.id, { mode: "fullAuto" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(requests.filter((call) => call.method === "thread/settings/update" || call.method === "thread/loaded/list")).toHaveLength(0);
  } finally { await adapter.dispose(); }
});

it.each([["unknown", undefined], ["named", { id: "profile-fixture" }]] as const)("does not treat %s effective-profile provenance as writable mode state", async (_label, profile) => {
  const { adapter, internals, requests, session } = await ownedAdapterFixture();
  try {
    internals.ownedPermissionThreads.get(session.id).native.activePermissionProfile = profile;
    await expect(adapter.setPermissions(session.id, { mode: "fullAuto" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(requests.filter((call) => call.method === "thread/settings/update" || call.method === "thread/loaded/list")).toHaveLength(0);
  } finally { await adapter.dispose(); }
});

it.each([
  ["notification missing", "missing"],
  ["notification belongs to another thread", "foreign"],
  ["notification reports another profile", "mismatch"],
  ["RPC fails", "rpc-error"],
] as const)("fails closed when the settings update %s and never retries", async (_label, outcome) => {
  const { adapter, internals, requests, session } = await ownedAdapterFixture({
    timeout: 15,
    update: async (server, params) => {
      if (outcome === "rpc-error") throw new Error("native settings update failed");
      if (outcome === "foreign") server.consumeMessage({ method: "thread/settings/updated", params: {
        threadId: "other-thread", threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null },
      } });
      if (outcome === "mismatch") server.consumeMessage({ method: "thread/settings/updated", params: {
        threadId: params.threadId, threadSettings: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" }, activePermissionProfile: null },
      } });
      return {};
    },
  });
  try {
    await expect(adapter.setPermissions(session.id, { mode: "fullAuto" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(requests.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
    expect(requests.some((call) => call.method === "thread/resume" || call.method === "turn/start")).toBe(false);
  } finally { await adapter.dispose(); }
});

it("rejects unsupported Codex modes before native RPC", async () => {
  const { adapter, requests, session } = await ownedAdapterFixture();
  try {
    await expect(adapter.setPermissions(session.id, { mode: "plan" })).resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(requests.filter((call) => call.method === "thread/settings/update" || call.method === "thread/loaded/list")).toHaveLength(0);
  } finally { await adapter.dispose(); }
});
