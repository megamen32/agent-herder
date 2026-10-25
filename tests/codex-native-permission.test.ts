import { expect, it } from "vitest";
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

it("keeps Codex Full Access unavailable when the native mode canary cannot confirm the exact profile", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-test-socket" });
  const internals = adapter as any;
  const calls: Array<{ method: string; params: unknown }> = [];
  internals.ensureReady = async () => undefined;
  internals.request = async (method: string, params: unknown) => { calls.push({ method, params }); return { thread: { id: "thread-fixture" } }; };
  expect(await adapter.setPermissions("thread-fixture", { mode: "fullAuto" })).toMatchObject({ ok: false, error: expect.stringContaining("did not confirm Full Access") });
  expect(calls).toHaveLength(0);
  const state = await adapter.getPermissionState("thread-fixture");
  expect(state).toMatchObject({ scope: "session", canSetMode: false, supportedModes: [] });
  expect(state?.currentMode).toBeUndefined();
  await adapter.dispose();
});
