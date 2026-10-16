import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAutopilotCore, drainPendingNotices, loadReceiptStore, persistReceiptStore, type StopHookInput } from "../src/autopilot/index.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";

const hook: StopHookInput = { hook_event_name: "Stop", harness: "opencode", session_id: "ses_real_opencode", cwd: "/workspace/Admin", turn_id: "evt_done", model: "minimax-coding-plan/MiniMax-M2.5", last_assistant_message: "Исправление проверено", transcript_path: null, stop_hook_active: false };
const binding = { incidentId: "inc_original", project: "admin" };

it("shows actual OpenCode execution rather than the protected Hermes producer", async () => {
 const send = vi.fn(async () => {});
 await createAutopilotCore({ judge: { decide: async () => ({ kind: "done", summary: "Исправление проверено" }) }, notify: { send }, receiptStore: new Map(), allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, harness: "opencode", notification: { project: "hermes", recipient: "me", kind: "notification" } }).handleStop(hook);
 const payload = send.mock.calls[0]![0] as any;
 expect(payload.project).toBe("hermes");
 expect(payload.event_type).toBe("agent.done");
 expect(payload.execution_identity).toEqual({harness:"opencode",session_id:hook.session_id,model:hook.model,cwd:hook.cwd,session_url:"https://agent.bezrabotnyi.com/#/session/opencode%3Ases_real_opencode"});
 expect(payload.body.startsWith("Исправление проверено\n\n")).toBe(true);
 for (const text of ["OpenCode", hook.session_id, hook.model!, hook.cwd, "https://agent.bezrabotnyi.com/#/session/opencode%3Ases_real_opencode"]) expect(payload.body).toContain(text);
});

it("keeps execution metadata outside long summaries in the durable notification outbox", async () => {
 const dir=await mkdtemp(join(tmpdir(),"herder-execution-display-"));
 try {
  const receipts=new Map(), send=vi.fn(async()=>{throw new Error("lost ACK");});
  const options={judge:{decide:async()=>({kind:"done",summary:"Проверенное исправление. ".repeat(500)})},notify:{send},receiptStore:receipts,allowSessions:new Set([hook.session_id]),maxContinuationsPerSession:3,harness:"opencode" as const};
  await createAutopilotCore(options).handleStop(hook);
  const payload=send.mock.calls[0]![0] as any;
  expect(payload.body.slice(0,800)).not.toContain("Открыть сессию");
  const path=join(dir,"receipts.json");await persistReceiptStore(path,receipts);
  const replay=vi.fn(async()=>{});
  await drainPendingNotices(await loadReceiptStore(path),{send:replay});
  expect((replay.mock.calls[0]![0] as any).execution_identity).toEqual(payload.execution_identity);
  expect(payload.execution_identity.harness).toBe("opencode");
 } finally {await rm(dir,{recursive:true,force:true});}
});

it("keeps a bound completion in the original incident outbox across caller failure and restart", async () => {
 const dir = await mkdtemp(join(tmpdir(), "herder-incident-outbox-"));
 try {
  const notify = { send: vi.fn(async () => {}) }, receipts = new Map();
  const publish = vi.fn(async () => { throw new Error("caller unavailable after storing observation"); });
  const judge = { decide: vi.fn(async () => ({ kind: "done", summary: "Исправление проверено", notify: false })) };
  const options = { judge, notify, receiptStore: receipts, allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, harness: "opencode" as const, noticeIncident: binding, incidentUpdates: { send: publish } };
  await createAutopilotCore(options).handleStop(hook);
  expect(notify.send).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledTimes(1);
  const first = publish.mock.calls[0]![0];
  await persistReceiptStore(join(dir, "receipts.json"), receipts);
  const restored = await loadReceiptStore(join(dir, "receipts.json"));
  const accepted = vi.fn(async () => {});
  await createAutopilotCore({ ...options, receiptStore: restored, incidentUpdates: { send: accepted } }).handleStop({ ...hook, last_assistant_message: "Другой preview" });
  expect(accepted).toHaveBeenCalledWith(first);
  expect(judge.decide).toHaveBeenCalledTimes(1);
  expect(notify.send).not.toHaveBeenCalled();
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it("persists exact incident binding and preserves it across legacy on/off", async () => {
 const dir = await mkdtemp(join(tmpdir(), "herder-incident-binding-"));
 try {
  const path = join(dir, "sessions.json"), store = new AutopilotSessionStore(path);
  const target = { harness: "opencode" as const, sessionId: hook.session_id, cwd: hook.cwd, noticeIncident: binding };
  await store.set(target, true);
  await new AutopilotSessionStore(path).set({ harness: target.harness, sessionId: target.sessionId, cwd: target.cwd }, false);
  expect(await store.get(target.harness, target.sessionId)).toMatchObject({ enabled: false, noticeIncident: binding });
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it("preserves old hook receipts without inventing a notification or re-running the judge", async () => {
 const dir = await mkdtemp(join(tmpdir(), "herder-old-notice-receipt-"));
 try {
  const notify = { send: vi.fn(async () => {}) }, judge = { decide: vi.fn(async () => ({ kind: "done", summary: "unused" })) };
  const receipts = new Map([[`${hook.session_id}:${hook.turn_id}:old`, { kind: "done" as const }]]);
  await persistReceiptStore(join(dir, "receipts.json"), receipts);
  await createAutopilotCore({ judge, notify, receiptStore: await loadReceiptStore(join(dir, "receipts.json")), allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, noticeIncident: binding }).handleStop(hook);
  expect(judge.decide).not.toHaveBeenCalled(); expect(notify.send).not.toHaveBeenCalled();
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it("refuses a missing original project token even when a legacy fallback token exists", async () => {
 const { writeFile, chmod } = await import("node:fs/promises");
 const { loadIncidentCallback } = await import("../src/autopilot/notice-incident.js");
 const dir = await mkdtemp(join(tmpdir(), "herder-callback-scope-"));
 try {
  const file = join(dir, "callback.json");
  await writeFile(file, JSON.stringify({ url: "http://127.0.0.1:8091", tokens: { other: "other-token" }, token: "fallback-token" })); await chmod(file, 0o600);
  await expect(loadIncidentCallback("admin", { GPTADMIN_HEALTH_CALLBACK_FILE: file })).rejects.toThrow("original project token");
  await writeFile(file, JSON.stringify({ url: "http://127.0.0.1:8091", token: "legacy-token" }));
  expect((await loadIncidentCallback("admin", { GPTADMIN_HEALTH_CALLBACK_FILE: file })).token).toBe("legacy-token");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it("carries the same original incident through human/choice question outboxes with actual native identity", async () => {
 const { HumanRequestRegistry } = await import("../src/human-request/index.js");
 const { buildAskHumanRequest } = await import("../src/human-request/notice-question.js");
 const dir = await mkdtemp(join(tmpdir(), "herder-incident-question-"));
 try {
  const registry = new HumanRequestRegistry(join(dir, "requests.json"));
  const receipts = new Map(), notify = { send: vi.fn(async () => {}) };
  let first: any;
  const deliver = vi.fn(async (question: any) => { first = question; throw new Error("Notice caller unavailable"); });
  const judge = { decide: vi.fn(async () => ({ kind: "choice", choices: [{ choiceId: "detailed", label: "Показать подробности", nextGoal: "Покажи подробности" }, { choiceId: "brief", label: "Показать кратко", nextGoal: "Покажи кратко" }] })) };
  const options = { judge, notify, humanRequests: registry, receiptStore: receipts, allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, harness: "opencode" as const, noticeIncident: binding };
  await createAutopilotCore({ ...options, deliverHumanQuestion: deliver }).handleStop(hook);
  expect(first.noticeIncident).toEqual(binding);
  expect(first.native_target).toEqual({ harness: "opencode", session_id: hook.session_id, cwd: hook.cwd });
  expect(first.question.message).toContain(hook.model);
  const file = join(dir, "receipts.json"); await persistReceiptStore(file, receipts);
  const restored = await loadReceiptStore(file), accepted = vi.fn(async () => {});
  expect(await drainPendingNotices(restored, notify, undefined, accepted)).toBe(1);
  await createAutopilotCore({ ...options, receiptStore: restored, deliverHumanQuestion: accepted }).handleStop(hook);
  expect(accepted).toHaveBeenCalledWith(first);
  expect(await registry.list()).toHaveLength(1); expect(judge.decide).toHaveBeenCalledTimes(1); expect(notify.send).not.toHaveBeenCalled();
  const envelope = buildAskHumanRequest(first, { project: "admin", recipient: "me" });
  expect(envelope.incident_id).toBe(binding.incidentId);
  expect(envelope.choices).toEqual([{ value: "detailed", label: "Показать подробности" }, { value: "brief", label: "Показать кратко" }]);
  expect(() => buildAskHumanRequest(first, { project: "hermes", recipient: "me" })).toThrow("original incident project");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it("accepts explicit incident context through the production arm HTTP handler", async () => {
 const { createWebServer } = await import("../src/web/server.js");
 const dir = await mkdtemp(join(tmpdir(), "herder-incident-arm-http-"));
 const store = new AutopilotSessionStore(join(dir, "sessions.json"));
 const web = createWebServer({ adapters: new Map(), converter: {} as never, autopilotSessionStore: store, sessionObservationManagedExternally: true });
 try {
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(web.address() as any).port}/api/autopilot/sessions/opencode/${hook.session_id}`;
  const put = (value: any) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(1_000) });
  const response = await put({ enabled: true, cwd: hook.cwd, noticeIncident: binding });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ noticeIncident: binding });
  expect((await put({ enabled: true, cwd: hook.cwd, noticeIncident: { incidentId: "" } })).status).toBe(400);
  expect((await put({ enabled: true, cwd: hook.cwd, noticeIncident: { ...binding, project: "hermes" } })).status).toBe(400);
  expect(await store.get("opencode", hook.session_id)).toMatchObject({ noticeIncident: binding });
 } finally { web.closeAllConnections(); await new Promise<void>((resolve) => web.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

it("reads the execution model from the native OpenCode assistant receipt", async () => {
 const { OpenCodeAdapter } = await import("../src/adapters/opencode.js");
 vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).includes("/message?") ? [
  { info: { id: "native-message", role: "assistant", providerID: "minimax-coding-plan", modelID: "MiniMax-M3.1-Flash-Preview" }, parts: [{ type: "text", text: "Исправление проверено" }] },
 ] : { id: hook.session_id, directory: hook.cwd })));
 try {
  const adapter = new OpenCodeAdapter({ baseUrl: "http://native-fixture", protocol: "v1" });
  expect((await adapter.getSessionMessages(hook.session_id, 12))?.at(-1)?.model).toBe("minimax-coding-plan/MiniMax-M3.1-Flash-Preview");
 } finally { vi.unstubAllGlobals(); }
});
