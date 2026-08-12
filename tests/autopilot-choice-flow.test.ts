import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAutopilotCore, type AutopilotDecision, type StopHookInput } from "../src/autopilot/index.js";
import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";

const input: StopHookInput = {
  hook_event_name: "Stop",
  session_id: "codex-session-1",
  cwd: "/workspace/app",
  turn_id: "turn-7",
  last_assistant_message: "I am uncertain which safe check should come next.",
  transcript_path: null,
  stop_hook_active: false,
};

describe("autopilot choice flow", () => {
  it("persists the exact Codex binding and sends only opaque presentation data", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-flow-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      judge: {
        decide: vi.fn(async () => ({
          kind: "choice",
          choices: [
            { choiceId: "inspect", label: "Inspect failed unit", nextGoal: "Inspect the failed unit and report the concrete error." },
            { choiceId: "correlate", label: "Correlate failure timing", nextGoal: "Correlate the failure timing with shared dependencies." },
          ],
        } satisfies AutopilotDecision)),
      },
      notify: sink,
      allowSessions: new Set([input.session_id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 2,
      choiceRegistry: registry,
    });

    await expect(core.handleStop(input)).resolves.toEqual({});
    const payload = sink.send.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      choice_request_id: expect.any(String),
      choices: [
        { choice_id: "inspect", label: "Inspect failed unit" },
        { choice_id: "correlate", label: "Correlate failure timing" },
      ],
    });
    expect(payload?.title).toBe("Agent Herder: выбор следующего шага по app");
    expect(payload?.body).toContain("Проект: app");
    expect(payload?.body).toContain("Последний ответ агента:\nI am uncertain which safe check should come next.");
    expect(payload?.body).toContain("1. Inspect failed unit");
    expect(payload?.body).toContain("2. Correlate failure timing");
    expect(payload?.body).toContain("После выбора продолжится эта же Codex-сессия.");
    expect(JSON.stringify(payload)).not.toContain("Inspect the failed unit and report the concrete error");

    const pending = await registry.get(String(payload?.choice_request_id));
    expect(pending).toMatchObject({
      sessionId: input.session_id,
      turnId: input.turn_id,
      cwd: input.cwd,
      status: "pending",
    });
    expect(pending?.choices[0]).toMatchObject({
      choiceId: "inspect",
      nextGoal: "Inspect the failed unit and report the concrete error.",
    });
  });

  it("claims a selection only once before resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-claim-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const created = await registry.create({
      sessionId: input.session_id,
      turnId: input.turn_id,
      cwd: input.cwd,
      choices: [
        { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect next." },
        { choiceId: "verify", label: "Verify", nextGoal: "Verify next." },
      ],
    });

    const first = await registry.claimForResume(created.requestId, "inspect");
    const duplicate = await registry.claimForResume(created.requestId, "verify");
    expect(first.claimed).toBe(true);
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.record.choiceId).toBe("inspect");
  });

  it("includes the latest user request from the Codex transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-user-context-"));
    const transcriptPath = join(root, "rollout.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Почини выбор следующего шага и объясни контекст." } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "служебный user-контекст не должен попасть в уведомление" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning", text: "checking" } }),
    ].join("\n") + "\n");
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      judge: {
        decide: vi.fn(async () => ({
          kind: "choice",
          choices: [
            { choiceId: "inspect", label: "Проверить состояние", nextGoal: "Inspect safely." },
            { choiceId: "verify", label: "Проверить результат", nextGoal: "Verify safely." },
          ],
        } satisfies AutopilotDecision)),
      },
      notify: sink,
      allowSessions: new Set([input.session_id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
      choiceRegistry: registry,
    });

    await core.handleStop({ ...input, transcript_path: transcriptPath });
    const body = String(sink.send.mock.calls[0]?.[0]?.body);
    expect(body).toContain("Последний запрос пользователя:\nПочини выбор следующего шага и объясни контекст.");
    expect(body).not.toContain("служебный user-контекст");
  });

  it("uses explicit harness user context when no transcript exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-explicit-context-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      harness: "hermes",
      judge: { decide: vi.fn(async () => ({
        kind: "choice",
        choices: [
          { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь." },
          { choiceId: "retry", label: "Повторить", nextGoal: "Повтори." },
        ],
      } satisfies AutopilotDecision)) },
      notify: sink,
      allowSessions: new Set([input.session_id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
      choiceRegistry: registry,
    });

    await core.handleStop({ ...input, harness: "hermes", last_user_message: "Сделай живой canary token=secret-value." });
    const payload = sink.send.mock.calls[0]?.[0];
    expect(payload?.body).toContain("Последний запрос пользователя:\nСделай живой canary token=[REDACTED_SECRET]");
    expect(payload?.body).toContain("После выбора продолжится эта же Hermes-сессия.");
    await expect(registry.get(String(payload?.choice_request_id))).resolves.toMatchObject({ harness: "hermes" });
  });

  it("redacts secrets from the user-facing choice context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-context-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      judge: {
        decide: vi.fn(async () => ({
          kind: "choice",
          choices: [
            { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect safely." },
            { choiceId: "verify", label: "Verify", nextGoal: "Verify safely." },
          ],
        } satisfies AutopilotDecision)),
      },
      notify: sink,
      allowSessions: new Set([input.session_id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
      choiceRegistry: registry,
    });

    await core.handleStop({
      ...input,
      last_assistant_message: "Need review token=super-secret before choosing.",
    });
    const body = String(sink.send.mock.calls[0]?.[0]?.body);
    expect(body).toContain("[REDACTED_SECRET]");
    expect(body).not.toContain("super-secret");
  });

  it("binds an OpenCode choice to the OpenCode resume transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-opencode-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    const core = createAutopilotCore({
      harness: "opencode",
      judge: { decide: vi.fn(async () => ({
        kind: "choice",
        choices: [
          { choiceId: "inspect", label: "Проверить логи", nextGoal: "Проверь логи." },
          { choiceId: "retry", label: "Повторить проверку", nextGoal: "Повтори проверку." },
        ],
      } satisfies AutopilotDecision)) },
      notify: sink,
      allowSessions: new Set([input.session_id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 1,
      choiceRegistry: registry,
    });

    const result = await core.handleStop({ ...input, harness: "opencode" });
    expect(result).toEqual({});
    const requestId = String(sink.send.mock.calls[0]?.[0]?.choice_request_id);
    const pending = await registry.get(requestId);
    expect(pending).toMatchObject({ harness: "opencode", sessionId: input.session_id });
  });
});
