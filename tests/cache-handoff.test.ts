import { describe, expect, it, vi } from "vitest";
import { AnthropicMiniMaxSummarizer, CacheHandoffService, cacheWindowFor, semanticTranscript } from "../src/cache-handoff.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";

const oldSession: AgentSession = {
  id: "old", harness: "codex", status: "stopped", title: "Большая задача", cwd: "/repo",
  lastActivity: "2026-10-03T10:00:00.000Z", model: "gpt-5.6-sol", needsPermission: false,
};

function adapter(messages: SessionMessageView[], harness: "codex" | "opencode" = "codex") {
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const createSession = vi.fn(async (options) => ({
    id: "new", harness, status: "idle" as const, title: options.name,
    cwd: options.cwd, model: options.model, lastActivity: "2026-10-03T11:00:00.000Z", needsPermission: false,
  }));
  const value: HarnessAdapter = {
    type: harness, name: "fixture", async init() {}, async listSessions() { return [{ ...oldSession, harness }]; },
    async getSession() { return oldSession; }, createSession, sendMessage,
    async getSessionMessages() { return messages; }, async resumeSession() { return { ok: true }; },
    async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return { value, createSession, sendMessage };
}

describe("cache-aware session handoff", () => {
  it("summarizes directly through MiniMax M3.1 without exposing the transcript in a process command", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Короткий handoff" }] }), { status: 200 });
    };
    const summarizer = new AnthropicMiniMaxSummarizer("secret", "https://api.minimax.io/anthropic", "MiniMax-M3.1-Flash-Preview", fetchImpl);
    await expect(summarizer.summarize("ПОЛЬЗОВАТЕЛЬ: продолжи")).resolves.toBe("Короткий handoff");
    expect(requests[0]).toMatchObject({ url: "https://api.minimax.io/anthropic/v1/messages", body: { model: "MiniMax-M3.1-Flash-Preview" } });
    expect(JSON.stringify(requests[0].body)).toContain("ПОЛЬЗОВАТЕЛЬ: продолжи");
  });

  it("uses the documented 30 minute window only for current OpenAI Codex models", () => {
    expect(cacheWindowFor({ harness: "codex", model: "gpt-5.6-sol" })).toEqual({ ttlMs: 1_800_000, source: "openai-30m" });
    expect(cacheWindowFor({ harness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3-Flash" })).toEqual({ ttlMs: 300_000, source: "zai-measured-5m" });
    expect(cacheWindowFor({ harness: "opencode", model: "minimax/MiniMax-M3.1-Flash-Preview" })).toEqual({ ttlMs: 300_000, source: "minimax-dynamic-5m" });
    expect(cacheWindowFor({ harness: "opencode", model: "minimax/MiniMax-M3" }, { AGENT_HERDER_CACHE_TTL_MINUTES: '{"opencode:minimax/MiniMax-M3":12}' })).toEqual({ ttlMs: 720_000, source: "configured" });
  });

  it("removes tool calls, tool results, and reasoning before MiniMax", () => {
    expect(semanticTranscript([
      { id: "u", role: "user", text: "Почини", parts: [{ type: "text", text: "Почини token=abcdefghijklmno" }] },
      { id: "a", role: "assistant", text: "hidden", parts: [
        { type: "thinking", text: "private" }, { type: "tool_call", name: "exec", input: "secret" },
        { type: "tool_result", output: "huge log" }, { type: "text", text: "<think>secret plan</think>Исправил A" },
      ] },
    ])).toBe("ПОЛЬЗОВАТЕЛЬ: Почини token=[СЕКРЕТ УДАЛЁН]\n\nАГЕНТ: Исправил A");
  });

  it("summarizes a stale session and continues in a new same-model Codex session", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
    const summarizer = { summarize: vi.fn(async () => "Цель: доделать. Следующий шаг: проверить тест.") };
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), summarizer);
    const result = await service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"));
    expect(result).toMatchObject({ kind: "rolled_over", session: { id: "new", model: "gpt-5.6-sol", cwd: "/repo" } });
    expect(fixture.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol", cwd: "/repo" }));
    expect(fixture.sendMessage).toHaveBeenCalledWith("new", expect.objectContaining({ message: expect.stringContaining("Цель: доделать") }));
  });

  it("keeps the same session when TTL is unknown or the cache is still fresh", async () => {
    const fixture = adapter([]);
    const summarizer = { summarize: vi.fn(async () => "unused") };
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), summarizer);
    expect((await service.maybeRollover({ ...oldSession, harness: "zcode", model: "unpublished-model" }, new Date("2026-10-03T12:00:00Z"))).kind).toBe("unknown");
    expect((await service.maybeRollover(oldSession, new Date("2026-10-03T10:29:00Z"))).kind).toBe("fresh");
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("selects the original OpenCode model before delivering the handoff", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }], "opencode");
    const openCodeSession = { ...oldSession, harness: "opencode" as const, model: "minimax/MiniMax-M3.1-Flash-Preview" };
    fixture.createSession.mockResolvedValue({ ...openCodeSession, id: "new", model: undefined, status: "idle" });
    const changeModel = vi.fn(async () => ({ ok: true }));
    fixture.value.changeModel = changeModel;
    const service = new CacheHandoffService(new Map([["opencode", fixture.value]]), { summarize: async () => "handoff" });
    expect((await service.maybeRollover(openCodeSession, new Date("2026-10-03T10:06:00Z"))).kind).toBe("rolled_over");
    expect(changeModel).toHaveBeenCalledWith("new", "minimax/MiniMax-M3.1-Flash-Preview");
    expect(changeModel.mock.invocationCallOrder[0]).toBeLessThan(fixture.sendMessage.mock.invocationCallOrder[0]);
  });
});
