import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { setNativePermissionModeOnce } from "../src/permission-control/reply.js";
import { localSessionHostId, type HarnessAdapter, type HarnessPermissionState } from "../src/types/index.js";

const inspectorSource = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

function fixture(id: string) {
  let currentMode = "default";
  let scope: HarnessPermissionState["scope"] = "session";
  let pendingRequests: HarnessPermissionState["pendingRequests"] = [];
  const stateReads = vi.fn(async (): Promise<HarnessPermissionState> => ({
    target: { hostId: localSessionHostId(), harness: "zcode", sessionId: id },
    currentMode,
    scope,
    supportedModes: ["default", "yolo"],
    canSetMode: true,
    pendingRequests,
    observedAt: new Date().toISOString(),
  }));
  const setPermissions = vi.fn(async (_sessionId: string, options: { mode?: string }) => {
    currentMode = options.mode || currentMode;
    return { ok: true };
  });
  const adapter = { getPermissionState: stateReads, setPermissions } as unknown as HarnessAdapter;
  const request = (overrides: Partial<Parameters<typeof setNativePermissionModeOnce>[1]> = {}) => setNativePermissionModeOnce(adapter, {
    hostId: localSessionHostId(), harness: "zcode", sessionId: id, inputId: `input-${id}`,
    expectedCurrentMode: "default", mode: "yolo", ...overrides,
  });
  return { request, stateReads, setPermissions, get currentMode() { return currentMode; }, set scope(value) { scope = value; }, set pending(value) { pendingRequests = value; } };
}

it("writes one exact session mode and returns the durable accepted result for a duplicate", async () => {
  const f = fixture("mode-accepted");
  const first = await f.request();
  const duplicate = await f.request();
  expect(first).toMatchObject({ ok: true, state: "accepted", duplicate: false });
  expect(duplicate).toMatchObject({ ok: true, state: "accepted", duplicate: true });
  expect(f.currentMode).toBe("yolo");
  expect(f.setPermissions).toHaveBeenCalledTimes(1);
});

it("rejects stale state, workspace scope, unsupported modes, and pending requests before writing", async () => {
  const stale = fixture("mode-stale");
  expect((await stale.request({ expectedCurrentMode: "plan" })).state).toBe("not_attempted");
  expect(stale.setPermissions).not.toHaveBeenCalled();

  const workspace = fixture("mode-workspace");
  workspace.scope = "workspace";
  expect((await workspace.request()).state).toBe("not_attempted");
  expect(workspace.setPermissions).not.toHaveBeenCalled();

  const pending = fixture("mode-pending");
  pending.pending = [{ id: "approval", canRespond: true }];
  expect((await pending.request()).state).toBe("not_attempted");
  expect(pending.setPermissions).not.toHaveBeenCalled();

  const unsupported = fixture("mode-unsupported");
  expect((await unsupported.request({ mode: "unsafe" })).state).toBe("not_attempted");
  expect(unsupported.setPermissions).not.toHaveBeenCalled();
});

it("does not replay a claimed mode write when transport outcome is unknown", async () => {
  const f = fixture("mode-unknown");
  f.stateReads.mockImplementationOnce(async () => ({
    target: { hostId: localSessionHostId(), harness: "zcode", sessionId: "mode-unknown" },
    currentMode: "default", scope: "session", supportedModes: ["default", "yolo"], canSetMode: true,
    pendingRequests: [], observedAt: new Date().toISOString(),
  })).mockImplementation(async () => { throw new Error("readback unavailable"); });
  f.setPermissions.mockImplementationOnce(async () => { throw new Error("transport lost"); });
  const first = await f.request();
  const duplicate = await f.request();
  expect(first).toMatchObject({ ok: false, state: "unknown", duplicate: false });
  expect(duplicate).toMatchObject({ ok: false, state: "unknown", duplicate: true });
  expect(f.setPermissions).toHaveBeenCalledTimes(1);
});

it("rejects reuse of an inputId for a conflicting payload", async () => {
  const f = fixture("mode-conflict");
  await f.request();
  const conflict = await f.request({ mode: "default" });
  expect(conflict.ok).toBe(false);
  expect(conflict.duplicate).toBe(true);
  expect(f.setPermissions).toHaveBeenCalledTimes(1);
});

it("serves exact permission state and refuses stale mode writes at the HTTP boundary", async () => {
  const f = fixture("mode-http");
  const adapter = {
    type: "zcode",
    name: "fixture",
    getPermissionState: f.stateReads,
    setPermissions: f.setPermissions,
  } as unknown as HarnessAdapter;
  const server = createWebServer({
    adapters: new Map([["zcode", adapter]]),
    converter: {} as any,
    sessionObservationManagedExternally: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const path = `/api/sessions/zcode/mode-http/permissions`;
    const exact = await fetch(`${origin}${path}?hostId=${encodeURIComponent(localSessionHostId())}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ available: true, permissionState: { target: { hostId: localSessionHostId(), harness: "zcode", sessionId: "mode-http" }, scope: "session", currentMode: "default" } });
    const wrongHost = await fetch(`${origin}${path}?hostId=other-host`);
    expect(wrongHost.status).toBe(409);
    const stale = await fetch(`${origin}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: localSessionHostId(), inputId: "mode-http-stale", expectedCurrentMode: "plan", mode: "yolo" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, state: "not_attempted" });
    expect(f.setPermissions).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("limits the inspector selector to session-scoped supported modes and preserves unknown input IDs", () => {
  expect(inspectorSource).toContain("/permissions?hostId=${encodeURIComponent(session.hostId)}");
  expect(inspectorSource).toContain('permissionModeRead.permissionState.scope === "session" && permissionModeRead.permissionState.canSetMode');
  expect(inspectorSource).toContain("permissionModeRead.permissionState.supportedModes!.map((mode)");
  expect(inspectorSource).toContain("writePermissionModeAttempts(session.hostId, session.harness, session.id, prepared);");
  expect(inspectorSource).toContain("signal: AbortSignal.timeout(15_000)");
  expect(inspectorSource).toContain("inputId: attempt.inputId, expectedCurrentMode: attempt.expectedCurrentMode, mode: attempt.mode");
  expect(inspectorSource).toContain("Исход смены режима неизвестен. Идентификатор попытки сохранён");
});

