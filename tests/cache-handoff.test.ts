import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicMiniMaxSummarizer, CacheHandoffService, cacheWindowFor, continuationModelFor, movePinnedContinuation, semanticTranscript, unfinishedProbeDelayMs } from "../src/cache-handoff.js";
import { LineageStore } from "../src/lineage-store.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";

const oldSession: AgentSession = {
  id: "old", harness: "codex", status: "stopped", title: "Большая задача", cwd: "/repo",
  lastActivity: "2026-10-03T10:00:00.000Z", model: "gpt-5.6-sol", needsPermission: false,
};

function adapter(messages: SessionMessageView[], harness: "codex" | "opencode" = "codex") {
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const setSessionPinned = vi.fn(async (sessionId: string, _pinned: boolean) => ({ ok: true, sessionId, error: undefined as string | undefined }));
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
    setSessionPinned,
  };
  return { value, createSession, sendMessage, setSessionPinned };
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

  it("derives a TTL-aware unfinished-session probe cadence", () => {
    expect(unfinishedProbeDelayMs({ harness: "codex", model: "gpt-5.6-sol" })).toBe(600_000);
    expect(unfinishedProbeDelayMs({ harness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3-Flash" })).toBe(240_000);
    expect(unfinishedProbeDelayMs({ harness: "codex", model: "legacy-unknown" })).toBe(240_000);
    expect(unfinishedProbeDelayMs(
      { harness: "zcode", model: "custom/model" },
      { AGENT_HERDER_CACHE_TTL_MINUTES: '{"zcode:custom/model":12}' } as NodeJS.ProcessEnv,
    )).toBe(600_000);
  });

  it("moves retired or quota-exhausted Z.AI plans to the individual Flash route", () => {
    expect(continuationModelFor({ harness: "zcode", model: "account:zai-start-plan/GLM-5.3-Flash" }))
      .toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
    expect(continuationModelFor({ harness: "zcode", model: "account:zai-individual-coding-plan/GLM-5.3" }))
      .toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
    expect(continuationModelFor({ harness: "codex", model: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
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

  it("does not create or send a cache replacement for a durably human-stopped source", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cache-human-stop-"));
    try {
      const fixture = adapter([{ id: "u", role: "user", text: "synthetic task", parts: [{ type: "text", text: "synthetic task" }] }]);
      const stops = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: join(root, "human-stops.json") });
      await stops.hold(oldSession, {
        id: "interrupt-1", at: "2026-10-03T10:30:00.000Z", reason: "interrupted", turnId: "turn-1",
      });
      const summarizer = { summarize: vi.fn(async () => "should not run") };
      const service = new CacheHandoffService(new Map([["codex", fixture.value]]), summarizer, undefined, process.env, stops);

      await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"))).resolves.toMatchObject({ kind: "held" });
      expect(summarizer.summarize).not.toHaveBeenCalled();
      expect(fixture.createSession).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rechecks the stop fence after summarization and before replacement creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cache-stop-race-"));
    try {
      const fixture = adapter([{ id: "u", role: "user", text: "synthetic task", parts: [{ type: "text", text: "synthetic task" }] }]);
      const stops = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: join(root, "human-stops.json") });
      const summarizer = { summarize: vi.fn(async () => {
        await stops.hold(oldSession, { id: "interrupt-2", at: "2026-10-03T10:30:30.000Z", reason: "interrupted", turnId: "turn-2" });
        return "summary";
      }) };
      const service = new CacheHandoffService(new Map([["codex", fixture.value]]), summarizer, undefined, process.env, stops);

      await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"))).resolves.toMatchObject({ kind: "held" });
      expect(fixture.createSession).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not create or send a second cache handoff after native admission failed", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
    fixture.sendMessage.mockResolvedValue({ ok: false, admitted: true, nonRetryable: true, error: "native handoff turn failed" });
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), { summarize: async () => "handoff" });

    await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"))).resolves.toMatchObject({
      kind: "admitted_failed",
      session: { id: "new" },
      admittedFailure: "native handoff turn failed",
    });
    await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:32:00.000Z"))).resolves.toMatchObject({
      kind: "admitted_failed",
      session: { id: "new" },
    });

    expect(fixture.createSession).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a prepared handoff retryable when neither native events nor transcript can prove admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cache-handoff-unknown-"));
    try {
      const lineage = new LineageStore(join(root, "lineage.json"));
      const replacement = { ...oldSession, id: "new", status: "idle" as const };
      await lineage.record({
        sessionKey: "codex:new",
        parentKey: "codex:old",
        role: "cache-handoff",
        provider: "codex",
        createdAt: new Date().toISOString(),
        source: "supervisor",
        cacheHandoffAdmission: {
          state: "prepared",
          session: replacement,
          operationId: "operation-unknown",
          prompt: "persisted handoff",
        },
      });
      const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
      fixture.value.getSessionMessages = async (id) => id === replacement.id ? null : [];
      const service = new CacheHandoffService(new Map([["codex", fixture.value]]), { summarize: async () => "unused" }, lineage);

      await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z")))
        .rejects.toThrow("cannot be reconciled safely yet");
      expect(fixture.createSession).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins the delivered replacement before unpinning the stale source", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), { summarize: async () => "handoff" });
    await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"), { movePinned: true }))
      .resolves.toMatchObject({ kind: "rolled_over", session: { id: "new" } });
    expect(fixture.setSessionPinned.mock.calls).toEqual([["new", true], ["old", false]]);
    expect(fixture.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(fixture.setSessionPinned.mock.invocationCallOrder[0]);
  });

  it("keeps the old pin when the replacement cannot be pinned", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
    fixture.setSessionPinned.mockResolvedValueOnce({ ok: false, error: "pin failed" });
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), { summarize: async () => "handoff" });
    await expect(service.maybeRollover(oldSession, new Date("2026-10-03T10:31:00.000Z"), { movePinned: true }))
      .rejects.toThrow("pin failed");
    expect(fixture.setSessionPinned.mock.calls).toEqual([["new", true]]);
  });

  it("unpins merged sources through their owning harness adapters", async () => {
    const target = adapter([], "codex");
    const peer = adapter([], "opencode");
    await movePinnedContinuation(target.value, [
      { adapter: target.value, sessionId: "codex-old" },
      { adapter: peer.value, sessionId: "opencode-old" },
    ], "codex-new");
    expect(target.setSessionPinned.mock.calls).toEqual([["codex-new", true], ["codex-old", false]]);
    expect(peer.setSessionPinned.mock.calls).toEqual([["opencode-old", false]]);
  });

  it("keeps the same session when TTL is unknown or the cache is still fresh", async () => {
    const fixture = adapter([]);
    const summarizer = { summarize: vi.fn(async () => "unused") };
    const service = new CacheHandoffService(new Map([["codex", fixture.value]]), summarizer);
    expect((await service.maybeRollover({ ...oldSession, harness: "zcode", model: "unpublished-model" }, new Date("2026-10-03T12:00:00Z"))).kind).toBe("unknown");
    expect((await service.maybeRollover(oldSession, new Date("2026-10-03T10:29:00Z"))).kind).toBe("fresh");
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("creates a stale ZCode continuation on the individual GLM Flash plan", async () => {
    const fixture = adapter([{ id: "u", role: "user", text: "Доделай", parts: [{ type: "text", text: "Доделай" }] }]);
    fixture.value.type = "zcode";
    fixture.value.name = "ZCode fixture";
    const session = { ...oldSession, harness: "zcode" as const, model: "account:zai-start-plan/GLM-5.3-Flash" };
    fixture.createSession.mockResolvedValue({ ...session, id: "new", model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high", status: "idle" });
    const service = new CacheHandoffService(new Map([["zcode", fixture.value]]), { summarize: async () => "handoff" });
    expect((await service.maybeRollover(session, new Date("2026-10-03T10:06:00Z"))).kind).toBe("rolled_over");
    expect(fixture.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      fullAccess: true,
    }));
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
