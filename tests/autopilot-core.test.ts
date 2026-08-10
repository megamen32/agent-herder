import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAutopilotCore,
  createNoticePlacePayload,
  createNoticePlaceSink,
  createOpenAICompatibleJudge,
  readBoundedEvidence,
  type AutopilotDecision,
  type StopHookInput,
} from "../src/autopilot/index.js";
import { acquireLock } from "../src/autopilot-hook.js";

const baseInput: StopHookInput = {
  hook_event_name: "Stop",
  session_id: "session-1",
  cwd: "/workspace/app",
  turn_id: "turn-7",
  last_assistant_message: "Need to check one more thing.",
  transcript_path: null,
  stop_hook_active: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autopilot core", () => {
  it("continues exactly once per session-turn and returns a block decision", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "continue", nextGoal: "Find the failing endpoint" } satisfies AutopilotDecision)) };
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      judge,
      notify: sink,
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 2,
    });

    await expect(core.handleStop(baseInput)).resolves.toEqual({ decision: "block", reason: "Find the failing endpoint" });
    await expect(core.handleStop(baseInput)).resolves.toEqual({});

    expect(judge.decide).toHaveBeenCalledTimes(1);
    expect(sink.send).not.toHaveBeenCalled();
  });

  it("rejects malformed judge output", async () => {
    const core = createAutopilotCore({
      judge: { decide: vi.fn(async () => ({ kind: "continue" } as unknown as AutopilotDecision)) },
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    await expect(core.handleStop(baseInput)).rejects.toThrow("Malformed judge decision");
  });

  it("builds a human notification payload with stable dedup and correlation fields", async () => {
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      judge: { decide: vi.fn(async () => ({ kind: "human", title: "Need approval", body: "Please review the blocked path", severity: "high" } satisfies AutopilotDecision)) },
      notify: sink,
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    const result = await core.handleStop(baseInput);
    expect(result).toEqual({});
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sink.send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      dedup_key: "agent-herder:human:session-1:turn-7",
      correlation_id: "session-1/turn-7",
    }));
  });

  it("fails closed when the session continuation budget is exhausted", async () => {
    const core = createAutopilotCore({
      judge: { decide: vi.fn(async () => ({ kind: "continue", nextGoal: "more" } satisfies AutopilotDecision)) },
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 0,
    });

    await expect(core.handleStop(baseInput)).resolves.toEqual({});
  });

  it("rejects disallowed sessions before touching the judge", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "done", summary: "ok", notify: false } satisfies AutopilotDecision)) };
    const core = createAutopilotCore({
      judge,
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["other-session"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    await expect(core.handleStop(baseInput)).resolves.toEqual({});
    expect(judge.decide).not.toHaveBeenCalled();
  });

  it("creates a NoticePlace payload without credentials", () => {
    const payload = createNoticePlacePayload({
      title: "Autopilot human review",
      body: "Need approval",
      severity: "medium",
      dedupKey: "session-1:turn-7:human",
      correlationId: "session-1/turn-7",
    });

    expect(payload).toEqual(expect.objectContaining({
      title: "Autopilot human review",
      dedup_key: "session-1:turn-7:human",
      correlation_id: "session-1/turn-7",
      kind: "notification",
    }));
    expect(JSON.stringify(payload)).not.toContain("token");
  });

  it("scrubs bearer, API-key, password, and private-key secrets before the judge", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-"));
    const transcriptPath = join(tempDir, "transcript.jsonl");
    const secrets = {
      bearer: "bearer-secret-123",
      apiKey: "api-secret-456",
      standaloneApiKey: "sk-proj-secret-012345",
      password: "password-secret-789",
      privateKey: "private-key-secret-ABC",
    };
    await writeFile(
      transcriptPath,
      [
        `Authorization: Bearer ${secrets.bearer}`,
        `api_key=${secrets.apiKey}`,
        `raw_key=${secrets.standaloneApiKey}`,
        `password: ${secrets.password}`,
        "-----BEGIN PRIVATE KEY-----",
        secrets.privateKey,
        "-----END PRIVATE KEY-----",
      ].join("\n"),
      "utf8",
    );

    const lastAssistantMessage = [
      `Bearer ${secrets.bearer}-last`,
      `apiKey: ${secrets.apiKey}-last`,
      `password=${secrets.password}-last`,
    ].join(" ");
    const judge = {
      decide: vi.fn(async () => ({
        kind: "done",
        summary: "finished",
        notify: false,
      } satisfies AutopilotDecision)),
    };
    const core = createAutopilotCore({
      judge,
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    try {
      await expect(
        core.handleStop({ ...baseInput, transcript_path: transcriptPath, last_assistant_message: lastAssistantMessage }),
      ).resolves.toEqual({});

      const judgeInput = judge.decide.mock.calls[0]?.[0];
      expect(judgeInput).toBeDefined();
      const serialized = JSON.stringify(judgeInput);
      for (const secret of Object.values(secrets)) {
        expect(serialized).not.toContain(secret);
      }
      expect(judgeInput?.evidence).toContain("[REDACTED_BEARER]");
      expect(judgeInput?.evidence).toContain("[REDACTED_API_KEY]");
      expect(judgeInput?.evidence).toContain("[REDACTED_PASSWORD]");
      expect(judgeInput?.evidence).toContain("[REDACTED_PRIVATE_KEY]");
      expect(judgeInput?.hook.last_assistant_message).toContain("[REDACTED_BEARER]");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a long transcript from evicting the last assistant message", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-"));
    const transcriptPath = join(tempDir, "transcript.txt");
    const lastAssistantMessage = "Последнее сообщение ассистента ✅";
    await writeFile(transcriptPath, "transcript line\n".repeat(4_000), "utf8");

    try {
      const evidence = await readBoundedEvidence(transcriptPath, lastAssistantMessage);
      expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(evidence).toContain(`Last assistant message:\n${lastAssistantMessage}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces the evidence budget in UTF-8 bytes", async () => {
    const evidence = await readBoundedEvidence(null, "😀".repeat(10_000));
    expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(evidence).toContain("Last assistant message:");
  });

  it("retries a live state lock, then fails closed after a bounded wait", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-"));
    const lockPath = join(tempDir, "state.lock");

    try {
      await writeFile(lockPath, "held", "utf8");
      const releaseHeldLock = setTimeout(() => {
        void unlink(lockPath);
      }, 30);
      const started = Date.now();
      const release = await acquireLock(lockPath, { waitMs: 250, retryIntervalMs: 10 });
      clearTimeout(releaseHeldLock);
      expect(release).not.toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
      await release?.();

      await writeFile(lockPath, "live", "utf8");
      const boundedStart = Date.now();
      await expect(
        acquireLock(lockPath, { waitMs: 50, retryIntervalMs: 10 }),
      ).resolves.toBeNull();
      expect(Date.now() - boundedStart).toBeGreaterThanOrEqual(40);

      await writeFile(lockPath, "stale", "utf8");
      const staleAt = new Date(Date.now() - 121_000);
      await utimes(lockPath, staleAt, staleAt);
      const staleRelease = await acquireLock(lockPath, { waitMs: 50, retryIntervalMs: 10 });
      expect(staleRelease).not.toBeNull();
      await staleRelease?.();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets a first Stop event with nullable transcript fields reach the judge", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "done", summary: "finished", notify: false } satisfies AutopilotDecision)) };
    const core = createAutopilotCore({
      judge,
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    await expect(core.handleStop(baseInput)).resolves.toEqual({});
    expect(judge.decide).toHaveBeenCalledTimes(1);
  });

  it("does not continue after a done decision", async () => {
    const core = createAutopilotCore({
      judge: { decide: vi.fn(async () => ({ kind: "done", summary: "finished", notify: true } satisfies AutopilotDecision)) },
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
    });

    await expect(core.handleStop(baseInput)).resolves.toEqual({});
  });

  it("counts persisted continue receipts toward the session budget", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "continue", nextGoal: "should not run" } satisfies AutopilotDecision)) };
    const core = createAutopilotCore({
      judge,
      notify: { send: vi.fn(async () => undefined) },
      allowSessions: new Set(["session-1"]),
      receiptStore: new Map([["session-1:previous-turn", { kind: "continue" }]]),
      maxContinuationsPerSession: 1,
    });

    await expect(core.handleStop({ ...baseInput, turn_id: "turn-after-budget" })).resolves.toEqual({});
    expect(judge.decide).not.toHaveBeenCalled();
  });

  it("parses an OpenAI-compatible judge response without exposing credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.messages[1].content).toContain("session-1");
      expect(request.messages[1].content).toContain("bounded evidence");
      expect(request.stream).toBe(false);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ kind: "done", summary: "finished", notify: false }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const judge = createOpenAICompatibleJudge({
      baseUrl: "https://judge.example/v1",
      model: "test-model",
      token: "judge-secret",
      fetchImpl,
    });

    await expect(judge.decide({ hook: baseInput, evidence: "bounded evidence", remainingContinuations: 1 })).resolves.toEqual({
      kind: "done",
      summary: "finished",
      notify: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://judge.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer judge-secret" }),
      }),
    );
  });

  it("sends only the NoticePlace event contract through the notification sink", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: "Bearer notify-secret",
        "idempotency-key": "agent-herder:human:session-1:turn-7",
      }));
      const payload = JSON.parse(String(init?.body));
      expect(payload.schema).toBe("notify.event.v1");
      expect(payload).not.toHaveProperty("token");
      return new Response(null, { status: 202 });
    });
    const sink = createNoticePlaceSink({
      eventUrl: "https://notify.example/v1/events",
      token: "notify-secret",
      fetchImpl,
    });

    await sink.send(createNoticePlacePayload({
      title: "Needs review",
      body: "Please decide",
      severity: "medium",
      dedupKey: "agent-herder:human:session-1:turn-7",
      correlationId: "session-1/turn-7",
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
