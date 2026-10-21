import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Focused integration: real arm/reset HTTP + durable state + production runner Stop.
// Detects binding loss / a stale enabled override; expected/max 5/15 seconds.
// The Stop judging lives in the process-owned BackgroundAutopilotStop; hooks
// (and any direct runner call) only notify /api/autopilot/stop and exit.
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
 const { runAutopilotCommand, evaluateAutopilotStop } = await import("../src/autopilot-runner.js");
 const { BackgroundAutopilotStop } = await import("../src/autopilot/background-stop.js");
 const { HerderJobRegistry } = await import("../src/herder-jobs.js");
 const { HerderEventBus } = await import("../src/herder-events.js");
 const { createWebServer } = await import("../src/web/server.js");
 const store = new AutopilotSessionStore(join(dir, "sessions.json"));
 const policy = new AutopilotPolicyStore(join(dir, "autopilot-policy.json"));
 const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(dir, "jobs.json") });
 const deliverGoal = vi.fn(async () => ({ status: "accepted" }));
 const snapshotSession = { id: "ses_reset", harness, cwd: "/workspace/Admin", status: "idle", lastActivity: new Date().toISOString(), needsPermission: false };
 const snapshotAdapter = {
  type: harness,
  name: "fixture",
  async init() {},
  async listSessions() { return [snapshotSession]; },
  async getSession() { return snapshotSession; },
  async getSessionMessages() {
   return [
    { id: "u1", role: "user" as const, text: "Почини и проверь", parts: [] },
    { id: "a1", role: "assistant" as const, text: "Исправление проверено", parts: [] },
   ];
  },
  async stopSession() { return { ok: true }; },
 } as never;
 const backgroundStop = new BackgroundAutopilotStop({
  jobs,
  adapters: new Map([[harness, snapshotAdapter]]),
  evaluate: evaluateAutopilotStop,
  held: async () => false,
  allowed: async input => (await runAutopilotCommand({ ...input, command: "status" })).enabled === true,
  deliver: deliverGoal,
 });
 const enabledPolicy = { ...createDefaultAutopilotPolicy(), enabled: true, harnesses: [harness], scope: harness === "codex" ? { mode: "allowlist" as const, selectors: [createCodexSelectorFromStopSession({ sessionId: "ses_reset", cwd: "/workspace/Admin" })] } : { mode: "all_ingress" as const } };
 await policy.replacePolicy(enabledPolicy, null);
 const server = createWebServer({ adapters: new Map(), converter: {} as never, autopilotSessionStore: store, autopilotPolicyStore: policy, sessionObservationManagedExternally: true, jobs, backgroundAutopilotStop: backgroundStop });
 try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("AGENT_HERDER_URL", `http://127.0.0.1:${(server.address() as any).port}`);
  const waitCompleted = async (stopJobId: string) => {
   const deadline = Date.now() + 8_000;
   while (jobs.get(stopJobId)?.state !== "completed") {
    if (Date.now() > deadline) throw new Error(`stop job did not complete: ${JSON.stringify(jobs.get(stopJobId))}`);
    await new Promise(prepare => setTimeout(prepare, 10));
   }
  };
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/autopilot/sessions/${harness}/ses_reset`;
  // The center accepts progress only for the selected plan of the incident,
  // so the binding carries that plan.
  const binding = { incidentId: "inc_original", project: "admin", planId: "repair" };
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
  // The runner call only queues the Stop; the background consumer performs the judging.
  const firstNotify = await runAutopilotCommand(target);
  expect(firstNotify).toMatchObject({ decision: "queued" });
  await waitCompleted((firstNotify as { jobId?: string }).jobId ?? "");
  const replayNotify = await runAutopilotCommand(target);
  await waitCompleted((replayNotify as { jobId?: string }).jobId ?? "");
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
}, 20_000);
