import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleJudge, type StopHookInput } from "../src/autopilot/index.js";
import { UserStyleStore } from "../src/autopilot/user-style.js";
import { createOpenAICompatibleSessionCompletionJudge, createAnthropicCompatibleSessionCompletionJudge } from "../src/autopilot/unfinished-session-launcher.js";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function store() { const root = await mkdtemp(join(tmpdir(), "herder-style-")); dirs.push(root); return new UserStyleStore(join(root, "user-style.json")); }
const observation = (text: string) => ({ text, harness: "codex", sessionId: "style-canary" });
const hook: StopHookInput = { hook_event_name: "Stop", session_id: "style-canary", cwd: "/project-a", turn_id: "1", last_user_message: "Отвечай кратко и проверяй результат.", last_assistant_message: "Осталась проверка.", transcript_path: null, stop_hook_active: false };

describe("autopilot user style", () => {
  it("persists only bounded consolidated style, redacts secrets and deduplicates human observations", async () => {
    const s = await store(); const c = await s.prepare([observation("Кратко. api_key=sk-1234567890123")]);
    expect(c.messages[0]).not.toContain("sk-1234567890123");
    await s.learn(c, { user_style_update: "Краткие ответы; password=private-value" });
    const raw = await readFile(s.path, "utf8");
    expect(raw).not.toContain("private-value"); expect(raw).not.toContain("Кратко. api_key");
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect((await new UserStyleStore(s.path).prepare([observation("Кратко. api_key=sk-1234567890123")])).messages).toEqual([]);
  });
  it("excludes automated messages and its own generated goals even in a later session", async () => {
    const s = await store(); const c = await s.prepare([observation("Проверь результат")]);
    await s.learn(c, { user_style_update: "Проверять результат", nextGoal: "Выполни проверку результата" });
    expect((await s.prepare([observation("Выполни проверку результата"), observation("Автопродолжение — проверка"), { ...observation("Новый шаг"), automated: true }])).messages).toEqual([]);
  });
  it("preserves an invalid cache and lets the existing judge continue without learning", async () => {
    const s = await store(); await writeFile(s.path, "broken-cache");
    const c = await s.prepare([observation("Кратко")]);
    expect(c.unavailable).toBe(true);
    await s.remember(c, { user_style_update: "Кратко", nextGoal: "Проверить" });
    expect(await readFile(s.path, "utf8")).toBe("broken-cache");
  });
  it("ignores oversized or unsupported updates and does not learn without fresh human evidence", async () => {
    const s = await store();
    await s.learn(await s.prepare(), { user_style_update: "Выдуманный стиль" });
    expect((await s.read()).summary).toBe("");
    await s.learn(await s.prepare([observation("Кратко")]), { user_style_update: "x".repeat(2401) });
    expect((await s.read()).revision).toBe(0);
  });
  it("does not let stale concurrent consolidation overwrite a newer correction", async () => {
    const s = await store(); const a = await s.prepare([observation("Сначала кратко")]); const b = await s.prepare([observation("Теперь подробно")]);
    await s.learn(b, { user_style_update: "Подробно" }); await s.learn(a, { user_style_update: "Кратко" });
    expect((await s.read()).summary).toBe("Подробно");
    expect((await s.prepare([observation("Сначала кратко")])).messages).toHaveLength(1);
  });
  it("passes learned preferences from one project into another judge request and asks for a prediction", async () => {
    const s = await store(); const bodies: any[] = [];
    const judge = createOpenAICompatibleJudge({ baseUrl: "https://judge.invalid", model: "configured", styleStore: s, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: "continue", nextGoal: "Проверь реальный результат", predicted_user_request: "Проверь, что работает", user_style_update: "Кратко; проверять реальный результат" }) } }] });
    } });
    await judge.decide({ hook, evidence: "test", remainingContinuations: 2 });
    await judge.decide({ hook: { ...hook, cwd: "/project-b", last_user_message: "Исправь найденную ошибку" }, evidence: "test2", remainingContinuations: 1 });
    const payload = JSON.parse(bodies[1].messages[1].content);
    expect(payload.user_style.summary).toBe("Кратко; проверять реальный результат");
    expect(bodies[1].messages[0].content).toContain("predicted_user_request");
    expect(bodies[1].messages[0].content).toContain("prediction is not authorization");
  });
  it.each([false, true])("feeds the same style into the batch planner (Anthropic=%s)", async anthropic => {
    const s = await store(); await s.learn(await s.prepare([observation("Коротко")]), { user_style_update: "Коротко" });
    let body: any;
    const content = JSON.stringify({ groups: [{ source_session_ids: ["S1"], primary_session_id: "S1", verdict: "unfinished", reason: "Осталась проверка", confidence: .9, topic: "Проверка результата", handoff: "Проверь результат" }], user_style_update: "Коротко; сначала результат", predicted_user_request: "Проверь результат" });
    const config = { baseUrl: "https://judge.invalid", model: "configured", token: "fixture", styleStore: s, fetchImpl: async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return Response.json(anthropic ? { content: [{ type: "text", text: content }] } : { choices: [{ message: { content } }] });
    } };
    const j = anthropic ? createAnthropicCompatibleSessionCompletionJudge(config) : createOpenAICompatibleSessionCompletionJudge(config);
    await j.plan!({ sessions: [{ session: { id: "native-1", harness: "codex", cwd: "/project-b", title: "Проверка", status: "idle", lastActivity: new Date().toISOString() } as any, transcriptTail: "Проверить результат", humanMessages: [observation("Сначала результат")] }] });
    expect(JSON.parse(body.messages.at(-1).content).user_style.summary).toBe("Коротко");
    expect((await s.read()).summary).toBe("Коротко; сначала результат");
  });
});
