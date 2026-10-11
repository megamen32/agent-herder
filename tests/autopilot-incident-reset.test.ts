import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Focused integration: real arm/reset HTTP + durable state + production runner Stop.
// Detects binding loss / a stale enabled override; expected/max 2/10 seconds.
it.each(["opencode", "codex"] as const)("resets policy inheritance while retaining the original Notice incident through Stop (%s)", async (harness) => {
 const dir = await mkdtemp(join(tmpdir(), "herder-notice-reset-"));
 vi.resetModules();
 vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", dir);
 vi.stubEnv("AGENT_HERDER_AUTOPILOT_POLICY_STORE", join(dir, "autopilot-policy.json"));
 vi.stubEnv("AGENT_HERDER_HUMAN_REQUEST_STORE", join(dir, "human-requests.json"));
 vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(dir, "stops.json"));
 vi.stubEnv("ASK_HUMAN_ENV_FILE", join(dir, "absent-ask-human"));
 vi.stubEnv("GPTADMIN_HEALTH_CALLBACK_FILE", join(dir, "callback.json"));
 vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL", "http://judge-fixture");
 vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL", "judge-model");
 vi.stubEnv("NOTIFY_CENTER_EVENT_URL", "http://generic-fixture/v1/events");
 vi.stubEnv("NOTIFY_CENTER_TOKEN", "generic-token");
 vi.stubEnv("AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT", "me");
 await writeFile(join(dir, "callback.json"), JSON.stringify({ url: "http://127.0.0.1:8091", tokens: { admin: "admin-token" } }));
 await chmod(join(dir, "callback.json"), 0o600);
 const updates: string[] = [];
 const judgeCalls = vi.fn();
 const nativeFetch = globalThis.fetch;
 vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
  const address = String(url);
  if (address.startsWith("http://judge-fixture")) {
   judgeCalls();
   return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: "done", summary: "Исправление проверено" }) } }] });
  }
  if (address === "http://127.0.0.1:8091/v1/incidents/inc_original/health/progress") {
   expect((init!.headers as any).authorization).toBe("Bearer admin-token");
   updates.push(address); return Response.json({ incident_id: "inc_original" }, { status: 202 });
  }
  return nativeFetch(url, init);
 }));
 const { AutopilotSessionStore } = await import("../src/autopilot/session-store.js");
 const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
 const { createDefaultAutopilotPolicy, createCodexSelectorFromStopSession } = await import("../src/autopilot/policy.js");
 const autopilot = await import("../src/autopilot/index.js");
 const genericSend = vi.fn(async () => {});
 vi.spyOn(autopilot, "createNoticePlaceSink").mockReturnValue({ send: genericSend });
 const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
 const { createWebServer } = await import("../src/web/server.js");
 const store = new AutopilotSessionStore(join(dir, "sessions.json"));
 const policy = new AutopilotPolicyStore(join(dir, "autopilot-policy.json"));
 const enabledPolicy = { ...createDefaultAutopilotPolicy(), enabled: true, harnesses: [harness], scope: harness === "codex" ? { mode: "allowlist" as const, selectors: [createCodexSelectorFromStopSession({ sessionId: "ses_reset", cwd: "/workspace/Admin" })] } : { mode: "all_ingress" as const } };
 await policy.replacePolicy(enabledPolicy, null);
 const server = createWebServer({ adapters: new Map(), converter: {} as never, autopilotSessionStore: store, autopilotPolicyStore: policy, sessionObservationManagedExternally: true });
 try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/autopilot/sessions/${harness}/ses_reset`;
  const binding = { incidentId: "inc_original", project: "admin" };
  expect((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, cwd: "/workspace/Admin", noticeIncident: binding }), signal: AbortSignal.timeout(1_000) })).status).toBe(200);
  const reset = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(1_000) });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toMatchObject({ enabled: true, source: "policy" });
  const saved = await new AutopilotSessionStore(join(dir, "sessions.json")).get(harness, "ses_reset");
  expect(saved).toMatchObject({ cwd: "/workspace/Admin", noticeIncident: binding });
  expect(saved?.enabled).toBeUndefined();
  expect(await (await fetch(url)).json()).toMatchObject({ enabled: true, source: "policy" });
  const target = { harness, sessionId: "ses_reset", cwd: "/workspace/Admin", command: "stop" as const, turnId: "stop-after-reset", lastAssistantMessage: "Исправление проверено", model: "native-fixture-model" };
  expect(await runAutopilotCommand({ ...target, command: "status" })).toMatchObject({ enabled: true, source: "persisted" });
  expect(await runAutopilotCommand(target)).toMatchObject({ decision: "terminal" });
  expect(await runAutopilotCommand(target)).toMatchObject({ decision: "terminal" });
  expect(updates).toHaveLength(1); expect(judgeCalls).toHaveBeenCalledTimes(1); expect(genericSend).not.toHaveBeenCalled();
  // Reset remains idempotent, and a later policy disable is really inherited.
  expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
  const effective = await policy.readEffective();
  await policy.replacePolicy({ ...enabledPolicy, enabled: false }, effective.source === "persisted" ? effective.revision : null);
  expect(await runAutopilotCommand({ ...target, command: "status" })).toMatchObject({ enabled: false, source: "persisted" });
  expect(await runAutopilotCommand({ ...target, turnId: "disabled-stop" })).toMatchObject({ decision: "disabled" });
  expect((await store.get(harness, "ses_reset"))?.noticeIncident).toEqual(binding);
  expect(updates).toHaveLength(1); expect(genericSend).not.toHaveBeenCalled();
 } finally {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
  await rm(dir, { recursive: true, force: true });
 }
}, 10_000);
