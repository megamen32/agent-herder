import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { HerderEventBus } from "../src/herder-events.js";
import { createNoticePlaceNativeJudge } from "../src/automation/v1-noticeplace-judge.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const input = { hook: { hook_event_name: "Stop" as const, harness: "opencode" as const,
  session_id: "ses_repair", turn_id: "event-real", cwd: "/repo", model: "minimax-coding-plan/MiniMax-M3.1-Flash",
  last_user_message: "Почини и проверь", last_assistant_message: "Осталось проверить", transcript_path: null, stop_hook_active: false },
  evidence: "Native revision evidence", remainingContinuations: 2 };
const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
async function fixture(mode: "success" | "malformed" | "unknown", createEnvelope = "task_ref", replyText?: string) {
  const dir = await mkdtemp(join(tmpdir(), "v1-native-judge-")); dirs.push(dir);
  const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(dir, "jobs.json") });
  let taskReads = 0;
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "create") {
      if (mode === "unknown") throw Error("create response lost after admission");
      return { structuredContent: { [createEnvelope]: "own-task" } };
    }
    if (name === "compat_task") {
      expect(args).toEqual({ action: "get", task_ref: "own-task" });
      if (++taskReads === 1) return wrap({ taskId: "own-task", status: "working" });
      return wrap({ taskId: "own-task", status: "completed", result: { structuredContent: {
        create: { effect: "confirmed", session_ref: "judge-own-ref" }, prompt: { outcome: "confirmed" },
      } } });
    }
    if (name === "session" && args.action === "messages") return { structuredContent: { session_ref: "judge-own-ref", page: { messages: [
      { role: "user", text: "ignored user JSON" },
      { role: "assistant", text: replyText ?? (mode === "malformed" ? '{"kind":"continue","nextGoal":42}' : '{"kind":"continue","nextGoal":"Проверь результат"}') },
    ] } } };
    if (name === "session" && args.action === "archive") {
      expect(args.session_ref).toBe("judge-own-ref"); return { structuredContent: { archived: true } };
    }
    throw Error("unexpected native call");
  });
  const options = { port: { call }, instanceRef: "opencode-noticeplace-local" as const, jobs, stateDir: dir,
    revision: async () => "native-rev-7", timeoutMs: 1000, pollIntervalMs: 1 };
  return { dir, call, options, judge: createNoticePlaceNativeJudge(options) };
}

describe("NoticePlace native subscription judge", () => {
  it("creates one bounded ordinary prompt, validates exact assistant JSON, archives its own session", async () => {
    for (const envelope of ["task_ref", "taskId", "_herder_create_task"]) {
      const f = await fixture("success", envelope);
      expect(await f.judge.decide(input)).toEqual({ kind: "continue", nextGoal: "Проверь результат" });
      const created = f.call.mock.calls.find(([name]) => name === "create")![1];
      expect(created).toMatchObject({ action: "create", instance_ref: "opencode-noticeplace-local", request_key: expect.stringMatching(/^notice-native-judge:/) });
      expect(String(created.prompt)).toContain("Choose exactly one kind");
      expect(String(created.prompt).length).toBeLessThanOrEqual(24_000);
      expect(f.call.mock.calls.filter(([name]) => name === "create")).toHaveLength(1);
      expect(f.call.mock.calls.filter(([name, args]) => name === "session" && args.action === "archive")).toHaveLength(1);
      expect(f.call.mock.calls.some(([name]) => /automation|deliver|resume/.test(name))).toBe(false);
      const restarted = createNoticePlaceNativeJudge({ ...f.options, jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "jobs.json") }) });
      expect(await restarted.decide(input)).toEqual({ kind: "continue", nextGoal: "Проверь результат" });
      expect(f.call.mock.calls.filter(([name]) => name === "create")).toHaveLength(1);
    }
  });
  it("rejects malformed decision with the existing validator and archives only the confirmed judge", async () => {
    for (const reply of ['not JSON at all', '{"kind":"continue","nextGoal":42}']) {
      const f = await fixture("malformed", "_herder_create_task", reply);
      await expect(f.judge.decide(input)).rejects.toThrow("native_judge_failed_or_unknown");
      expect(f.call.mock.calls.filter(([name, args]) => name === "session" && args.action === "archive")).toHaveLength(1);
      await expect(f.judge.decide(input)).rejects.toThrow("native_judge_failed_or_unknown");
      expect(f.call.mock.calls.filter(([name]) => name === "create")).toHaveLength(1);
    }
  });
  it("pins unknown create durably and never repeats it across caller/factory restart", async () => {
    const f = await fixture("unknown");
    await expect(f.judge.decide(input)).rejects.toThrow("native_judge_failed_or_unknown");
    const restarted = createNoticePlaceNativeJudge({ ...f.options, jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(f.dir, "jobs.json") }) });
    await expect(restarted.decide(input)).rejects.toThrow("native_judge_failed_or_unknown");
    // The same native event/revision with changed metadata conflicts instead of minting another create key.
    await expect(restarted.decide({ ...input, remainingContinuations: 1 })).rejects.toThrow();
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.call.mock.calls[0]![0]).toBe("create");
  });
});
