import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAutopilotCore, drainPendingNotices, loadReceiptStore, persistReceiptStore, type StopHookInput } from "../src/autopilot/index.js";
import { createIncidentUpdateSink, deliverIncidentQuestion } from "../src/autopilot/notice-incident.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";

// Focused integration; the bounded release provides the coupled Notice source.
it.runIf(Boolean(process.env.NOTICEPLACE_TEST_ROOT))("updates one original Notice HTTP/DB/Telegram card through lost ACK, restart and a bound native question", async () => {
 const dir = await mkdtemp(join(tmpdir(), "herder-notice-coupled-"));
 const child = spawn("/usr/bin/python3", ["-B", "tests/fixtures/autopilot-notice-peer.py", dir, process.env.NOTICEPLACE_TEST_ROOT!], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
 let stderr = ""; child.stderr.on("data", (part) => { stderr += String(part); });
 const lines = createInterface({ input: child.stdout });
 try {
  const peer = await new Promise<{ url: string; incidentId: string }>((resolve, reject) => {
   const timer = setTimeout(() => reject(new Error(`Notice fixture setup timed out: ${stderr}`)), 4_000);
   lines.once("line", (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
   child.once("exit", () => { clearTimeout(timer); reject(new Error(`Notice fixture exited: ${stderr}`)); });
  });
  const file = join(dir, "callback.json");
  await writeFile(file, JSON.stringify({ url: peer.url, tokens: { admin: "admin-token" } })); await chmod(file, 0o600);
  const env = { GPTADMIN_HEALTH_CALLBACK_FILE: file }, binding = { incidentId: peer.incidentId, project: "admin" };
  const sink = createIncidentUpdateSink(env), notify = { send: vi.fn(async () => {}) }, receipts = new Map();
  const hook: StopHookInput = { hook_event_name: "Stop", harness: "opencode", session_id: "ses_real_opencode", cwd: dir, turn_id: "turn-done", model: "minimax-coding-plan/MiniMax-M2.5", last_assistant_message: "Исправление проверено", transcript_path: null, stop_hook_active: false };
  const judge = { decide: vi.fn(async () => ({ kind: "done", summary: "Исправление проверено" })) };
  const storePath = join(dir, "receipts.json");
  await createAutopilotCore({ judge, notify, receiptStore: receipts, allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, harness: "opencode", noticeIncident: binding,
    checkpointReceipts: () => persistReceiptStore(storePath, receipts),
    incidentUpdates: { async send(update) { expect((await loadReceiptStore(storePath)).size).toBe(1); await sink.send(update); throw new Error("simulated lost HTTP ACK after actual stored progress"); } },
  }).handleStop(hook);
  expect(notify.send).not.toHaveBeenCalled();
  const restarted = await loadReceiptStore(storePath);
  expect(await drainPendingNotices(restarted, notify, sink)).toBe(1);
  expect(judge.decide).toHaveBeenCalledTimes(1);
  const questionErrors: string[] = [];
  const requests = new HumanRequestRegistry(join(dir, "requests.json"));
  await createAutopilotCore({ judge: { decide: async () => ({ kind: "human", title: "Нужно уточнение", body: "Какой результат показать?", severity: "medium" }) }, notify, receiptStore: restarted, allowSessions: new Set([hook.session_id]), maxContinuationsPerSession: 3, harness: "opencode", noticeIncident: binding,
    humanRequests: requests, deliverHumanQuestion: async (question) => { try { await deliverIncidentQuestion(question, env); } catch (error) { questionErrors.push(String(error)); throw error; } },
  }).handleStop({ ...hook, turn_id: "turn-question" });
  expect(questionErrors).toEqual([]);
  let proof: any;
  await vi.waitFor(async () => {
   proof = await (await fetch(`${peer.url}/fixture-proof`, { signal: AbortSignal.timeout(1_000) })).json();
   expect(proof.questions).toBe(1);
   expect(proof.calls.filter((call: any) => call.method === "editMessageText").length, JSON.stringify(proof)).toBeGreaterThan(1);
  }, { timeout: 2_000 });
  expect(proof.incidents).toBe(1);
  expect(proof.progress).toBe(1);
  expect(proof.calls.filter((call: any) => call.method === "sendMessage")).toHaveLength(1);
  expect(proof.calls.filter((call: any) => call.method.startsWith("editMessage")).every((call: any) => String(call.message_id) === "42")).toBe(true);
  expect(JSON.stringify(proof.calls)).toContain("OpenCode");
  expect(notify.send).not.toHaveBeenCalled();
 } finally {
  child.stdin.end("stop\n");
  await new Promise<void>((resolve) => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => { child.kill(); resolve(); }, 1_500); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  lines.close(); await rm(dir, { recursive: true, force: true });
 }
}, 12_000);
