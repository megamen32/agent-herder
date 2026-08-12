import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { createAutopilotCore } from "../src/autopilot/index.js";
import { loadEffectivePolicyForStopHook } from "../src/autopilot-hook.js";
import { ChoiceRegistry, ChoiceRegistryLockUnavailableError, type PendingChoice } from "../src/autopilot/choice-registry.js";
import { AgentResumeClient, type ResumeReceipt, type ResumeTransportRequest } from "../src/resume-transport.js";
import { createDefaultAutopilotPolicy, resolveEffectivePolicy, type AutopilotPolicy, type EffectivePolicy } from "../src/autopilot/policy.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { buildTimeoutResumeRequest, liveCodexTargetMatchesChoice, sweepAutopilotChoices } from "../src/web/server.js";
import type { AgentSession } from "../src/types/index.js";

const input = {
  hook_event_name: "Stop" as const,
  session_id: "codex-session-1",
  cwd: "/workspace/app",
  turn_id: "turn-1",
  last_assistant_message: "Several safe next steps are possible.",
  transcript_path: null,
  stop_hook_active: false,
};

function policy(overrides: Partial<AutopilotPolicy> = {}): AutopilotPolicy {
  return {
    ...createDefaultAutopilotPolicy(),
    enabled: true,
    scope: { mode: "allowlist", selectors: [{ harness: "codex", sessionId: input.session_id, conversationId: input.session_id, cwd: input.cwd, ingressId: "codex-stop-hook-v1" }] },
    timeout: { mode: "auto_continue", delayMs: 30 * 60 * 1000 },
    card: { includeUserMessage: false, includeAssistantMessage: false, includeReason: true },
    ...overrides,
  };
}

function effective(next: AutopilotPolicy): EffectivePolicy {
  return resolveEffectivePolicy({ state: { schemaVersion: 1, revision: "r-test", policy: next, updatedAt: new Date().toISOString() } });
}

const choices = [
  { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect the exact failure." },
  { choiceId: "verify", label: "Verify", nextGoal: "Verify the repaired path." },
];

function acceptedReceipt(choice: PendingChoice): ResumeReceipt {
  return {
    status: "accepted",
    target: { agent: "codex", session_id: choice.sessionId, cwd: choice.cwd },
    result_ref: choice.resultRef,
    idempotency_key: choice.idempotencyKey,
    receipt_ref: `receipt:${choice.requestId}`,
  };
}

function codexTarget(request: ResumeTransportRequest) {
  if (request.target.agent !== "codex") throw new Error("timeout tests require a Codex target");
  return request.target;
}

function providerAcceptedReceipt(request: ResumeTransportRequest) {
  return {
    status: "accepted" as const,
    target: codexTarget(request),
    result_ref: request.result_ref,
    idempotency_key: request.idempotency_key,
    receipt_ref: "agent-resume://receipt/provider",
  };
}

function liveCodexSession(cwd: string): AgentSession {
  return {
    id: input.session_id,
    harness: "codex",
    status: "idle",
    title: "Timeout target",
    cwd,
    lastActivity: "2026-08-11T00:00:00.000Z",
    needsPermission: false,
  };
}

describe("autopilot policy hook and timeout sweep", () => {
  it("fails closed for default-off and rejects a nonmatching selector", async () => {
    const judge = { decide: vi.fn(async () => ({ kind: "choice", choices })) };
    const notify = { send: vi.fn(async () => undefined) };
    const base = { judge, notify, allowSessions: new Set([input.session_id]), receiptStore: new Map(), maxContinuationsPerSession: 2 };
    await expect(createAutopilotCore({ ...base, effectivePolicy: resolveEffectivePolicy({ env: {} }) }).handleStop(input)).resolves.toEqual({});
    await expect(createAutopilotCore({ ...base, effectivePolicy: effective(policy()) }).handleStop({ ...input, session_id: "other-session" })).resolves.toEqual({});
    expect(judge.decide).not.toHaveBeenCalled();
  });

  it("snapshots the matching policy revision, selector-derived timeout target and context switches", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-hook-policy-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const sink = { send: vi.fn(async () => undefined) };
    await createAutopilotCore({
      judge: { decide: vi.fn(async () => ({ kind: "choice", choices })) },
      notify: sink,
      allowSessions: new Set(),
      receiptStore: new Map(),
      maxContinuationsPerSession: 2,
      effectivePolicy: effective(policy()),
      choiceRegistry: registry,
    }).handleStop(input);
    const pending = (await registry.get(String(sink.send.mock.calls[0]?.[0]?.choice_request_id)))!;
    expect(pending).toMatchObject({
      policyRevision: "r-test",
      timeoutChoiceId: "inspect",
      maxContinuationsPerSession: 3,
      status: "pending",
    });
    expect(Date.parse(pending.expiresAt!)).toBeGreaterThan(Date.now());
    const body = String(sink.send.mock.calls[0]?.[0]?.body);
    expect(body).toContain("MiniMax не выбрал автоматически");
    expect(body).not.toContain("Последний ответ агента");
    expect(body).not.toContain("Последний запрос пользователя");
  });

  it("sweeps and resumes a timeout choice once, then records policy revalidation as human-required", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-"));
    const choicesPath = join(root, "choices.json");
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(choicesPath);
    const pending = await registry.create({ sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([{ requestId: pending.requestId, status: "resumed" }]);
    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([]);
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({
      status: "resumed",
      resumeReceipt: { status: "accepted", idempotencyKey: expect.any(String), resultRef: expect.stringContaining("agent-herder://") },
    });

    const second = await registry.create({ sessionId: input.session_id, turnId: "turn-2", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const disabled = await policyStore.replacePolicy({ ...policy(), enabled: false, timeout: { mode: "hold", delayMs: 0 } }, saved.revision);
    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([{ requestId: second.requestId, status: "human-required", reason: "Autopilot policy or selector changed before timeout dispatch" }]);
    expect((await registry.get(second.requestId))?.status).toBe("expired-needs-human");
    expect(disabled.revision).not.toBe(saved.revision);
  });

  it("binds the timeout request to the exact saved goal, key, and opaque result reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-request-binding-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: "request-binding", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const requests: ReturnType<typeof buildTimeoutResumeRequest>[] = [];
    const resume = vi.fn(async (choice: PendingChoice) => {
      const request = buildTimeoutResumeRequest(choice);
      requests.push(request);
      return acceptedReceipt(choice);
    });

    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([{ requestId: pending.requestId, status: "resumed" }]);
    expect(requests).toEqual([expect.objectContaining({
      target: { agent: "codex", session_id: input.session_id, cwd: input.cwd },
      goal: choices[0].nextGoal,
      prompt: choices[0].nextGoal,
      result_ref: pending.resultRef,
      idempotency_key: `${pending.requestId}:inspect`,
    })]);
  });

  it("resumes when Agent Resume returns its normalized Codex metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-normalized-receipt-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: "normalized-receipt", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => new AgentResumeClient({
      invoke: async (request) => ({
        ...providerAcceptedReceipt(request),
        target: { ...codexTarget(request), model: "gpt-5.4", marker: "A1B2C" },
      }),
    }).resume(buildTimeoutResumeRequest(choice)));

    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([
      { requestId: pending.requestId, status: "resumed" },
    ]);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "resumed" });
  });

  it.each([
    ["rejected", "failed"],
    ["ambiguous", "human-required"],
  ] as const)("maps an Agent Resume %s receipt to %s without a direct adapter fallback", async (receiptStatus, expectedStatus) => {
    const root = await mkdtemp(join(tmpdir(), `agent-herder-sweep-${receiptStatus}-`));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: receiptStatus, cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice): Promise<ResumeReceipt> => ({
      status: receiptStatus,
      target: { agent: "codex", session_id: choice.sessionId, cwd: choice.cwd },
      result_ref: choice.resultRef,
      idempotency_key: choice.idempotencyKey,
      ...(receiptStatus === "ambiguous" ? { reason: "detached_codex_spawn_unverified" } : { reason: "invalid_request" }),
    }));

    const result = await sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") });
    expect(result[0]?.status).toBe(expectedStatus);
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({
      status: expectedStatus === "failed" ? "failed" : "expired-needs-human",
      resumeReceipt: { status: receiptStatus },
    });
  });

  it.each([
    ["wrong session", (request: ResumeTransportRequest) => ({ ...providerAcceptedReceipt(request), target: { ...codexTarget(request), session_id: "other-session" } })],
    ["wrong cwd", (request: ResumeTransportRequest) => ({ ...providerAcceptedReceipt(request), target: { ...codexTarget(request), cwd: "/workspace/other" } })],
    ["wrong key", (request: ResumeTransportRequest) => ({ ...providerAcceptedReceipt(request), idempotency_key: "other-key" })],
    ["wrong result ref", (request: ResumeTransportRequest) => ({ ...providerAcceptedReceipt(request), result_ref: "result://other" })],
    ["missing receipt reference", (request: ResumeTransportRequest) => ({ status: "accepted", target: codexTarget(request), result_ref: request.result_ref, idempotency_key: request.idempotency_key })],
    ["unsupported output", () => "not a receipt"],
    ["missing output", () => undefined],
  ] as const)("holds a %s Agent Resume receipt for human recovery without relaunch", async (_name, rawReceipt) => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-invalid-receipt-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: "invalid-receipt", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => new AgentResumeClient({
      invoke: async (request) => rawReceipt(request),
    }).resume(buildTimeoutResumeRequest(choice)));

    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toMatchObject([
      { requestId: pending.requestId, status: "human-required" },
    ]);
    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([]);
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "expired-needs-human" });
  });

  it("recovers an in-flight timeout by querying its receipt and never relaunches", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-recovery-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const firstRegistry = new ChoiceRegistry(path);
    const pending = await firstRegistry.create({ sessionId: input.session_id, turnId: "recovery", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await firstRegistry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    await firstRegistry.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));
    const restartedRegistry = new ChoiceRegistry(path);
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    const query = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));

    await expect(sweepAutopilotChoices({ choiceRegistry: restartedRegistry, policyStore, resume, query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toEqual([{ requestId: pending.requestId, status: "resumed" }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    await expect(restartedRegistry.get(pending.requestId)).resolves.toMatchObject({ status: "resumed", resumeReceipt: { status: "accepted" } });
  });

  it("keeps a newly claimed timeout recoverable when in-flight lock inspection is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-list-lock-loss-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const pending = await registry.create({ sessionId: input.session_id, turnId: "list-lock-loss", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const lockLoss = new ChoiceRegistryLockUnavailableError(`${path}.lock`, new Error("injected post-claim lock loss"));
    const listInFlight = vi.spyOn(registry, "listInFlightTimeoutClaims").mockRejectedValueOnce(lockLoss);
    const execute = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    const query = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));

    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume: execute, query, now: new Date("2025-01-01T00:00:00.000Z") })).resolves.toEqual([
      { requestId: pending.requestId, status: "human-required", reason: lockLoss.message },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({
      status: "claimed",
      claimToken: expect.any(String),
      idempotencyKey: `${pending.requestId}:inspect`,
    });

    listInFlight.mockRestore();
    await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume: execute, query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toEqual([
      { requestId: pending.requestId, status: "resumed" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "resumed" });
  });

  it("does not relaunch after an interruption before the bound transport call", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-before-transport-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const pending = await registry.create({ sessionId: input.session_id, turnId: "before-transport", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await registry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    await registry.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));

    const execute = vi.fn(async () => acceptedReceipt(pending));
    const query = vi.fn(async (choice: PendingChoice): Promise<ResumeReceipt> => ({
      ...acceptedReceipt(choice),
      status: "ambiguous",
      reason: "receipt not found after interruption",
      receipt_ref: undefined,
    }));

    await expect(sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: execute, query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toMatchObject([
      { requestId: pending.requestId, status: "human-required" },
    ]);
    expect(execute).toHaveBeenCalledTimes(0);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "expired-needs-human" });
  });

  it("replays a durable receipt after interruption before the local resumed transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-receipt-replay-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const pending = await registry.create({ sessionId: input.session_id, turnId: "receipt-replay", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await registry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    await registry.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));
    await registry.persistResumeReceipt(pending.requestId, claimed!.claimToken!, {
      status: "accepted",
      resultRef: pending.resultRef,
      idempotencyKey: claimed!.idempotencyKey!,
      receiptRef: "agent-resume://receipt/durable-before-local-transition",
    });

    const execute = vi.fn(async () => acceptedReceipt(pending));
    const query = vi.fn(async (choice: PendingChoice) => ({
      ...acceptedReceipt(choice),
      receipt_ref: "agent-resume://receipt/durable-before-local-transition",
    }));
    await expect(sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: execute, query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toEqual([
      { requestId: pending.requestId, status: "resumed" },
    ]);
    expect(execute).toHaveBeenCalledTimes(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0].idempotencyKey).toBe(`${pending.requestId}:inspect`);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "resumed", resumeReceipt: { receiptRef: "agent-resume://receipt/durable-before-local-transition" } });
  });

  it("recovers the same idempotency key after fresh registry reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-fresh-process-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const firstRegistry = new ChoiceRegistry(path);
    const pending = await firstRegistry.create({ sessionId: input.session_id, turnId: "fresh-process", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await firstRegistry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    const expectedKey = claimed!.idempotencyKey;

    const reconstructed = new ChoiceRegistry(path);
    const query = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    await reconstructed.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));
    await expect(sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: vi.fn(async () => acceptedReceipt(pending)), query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toEqual([
      { requestId: pending.requestId, status: "resumed" },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0].idempotencyKey).toBe(expectedKey);
    expect(buildTimeoutResumeRequest(query.mock.calls[0]![0]).idempotency_key).toBe(expectedKey);
  });

  it("allows at most one execute or receipt-query path across concurrent sweeps", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-concurrent-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const seed = new ChoiceRegistry(path);
    const pending = await seed.create({ sessionId: input.session_id, turnId: "concurrent-sweeps", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    let finishExecute!: (receipt: ResumeReceipt) => void;
    let executeStarted!: () => void;
    const executeReady = new Promise<void>((resolve) => { executeStarted = resolve; });
    const execute = vi.fn(async (choice: PendingChoice) => {
      executeStarted();
      return new Promise<ResumeReceipt>((resolve) => { finishExecute = () => resolve(acceptedReceipt(choice)); });
    });
    const query = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    const first = sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: execute, query, now: new Date("2025-01-01T00:00:00.000Z") });
    await executeReady;
    const second = sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: execute, query, now: new Date("2025-01-01T00:00:00.000Z") });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duplicateQueryCount = query.mock.calls.length;
    finishExecute(acceptedReceipt(pending));
    await Promise.allSettled([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(duplicateQueryCount).toBe(0);
    expect(execute.mock.calls.length + duplicateQueryCount).toBe(1);
  });

  it.each([
    ["missing", async () => { throw new Error("receipt not found"); }],
    ["ambiguous", async (choice: PendingChoice): Promise<ResumeReceipt> => ({ ...acceptedReceipt(choice), status: "ambiguous", reason: "provider state is unknown" })],
    ["malformed", async () => "not-json" as unknown as ResumeReceipt],
  ] as const)("keeps a %s recovery receipt human-required", async (_name, queryFactory) => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-recovery-receipt-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const pending = await registry.create({ sessionId: input.session_id, turnId: `recovery-${_name}`, cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await registry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    await registry.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));
    const execute = vi.fn(async () => acceptedReceipt(pending));
    const query = vi.fn(queryFactory);

    await expect(sweepAutopilotChoices({ choiceRegistry: new ChoiceRegistry(path), policyStore, resume: execute, query, now: new Date("2025-01-01T00:01:00.000Z") })).resolves.toMatchObject([
      { requestId: pending.requestId, status: "human-required" },
    ]);
    expect(execute).toHaveBeenCalledTimes(0);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "expired-needs-human" });
  });

  it("fails closed when a recovery receipt is missing or cannot be queried", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-query-error-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const pending = await registry.create({ sessionId: input.session_id, turnId: "query-error", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const [claimed] = await registry.claimExpired(new Date("2025-01-01T00:00:00.000Z"));
    await registry.markDispatching(pending.requestId, claimed!.claimToken!, new Date("2025-01-01T00:00:00.000Z"));

    await expect(sweepAutopilotChoices({
      choiceRegistry: new ChoiceRegistry(path),
      policyStore,
      resume: vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice)),
      query: vi.fn(async () => { throw new Error("receipt not found"); }),
      now: new Date("2025-01-01T00:01:00.000Z"),
    })).resolves.toMatchObject([{ requestId: pending.requestId, status: "human-required" }]);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "expired-needs-human" });
  });

  it("turns a typed choice-lock failure into a human-required sweep outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-lock-"));
    const choicesPath = join(root, "choices.json");
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(choicesPath);
    await registry.create({ sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: "r-test", maxContinuationsPerSession: 3 });
    const release = await lockfile.lock(`${choicesPath}.lock`, { realpath: false, stale: 30_000, retries: 0 });
    try {
      await expect(sweepAutopilotChoices({ choiceRegistry: registry, policyStore, resume: vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice)) })).resolves.toMatchObject([{ status: "human-required" }]);
    } finally {
      await release();
    }
  });

  it("durably reserves the timeout budget across two overdue cards and a restarted registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-budget-"));
    const choicesPath = join(root, "choices.json");
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy({ maxContinuationsPerSession: 1 }), null);
    const firstRegistry = new ChoiceRegistry(choicesPath);
    const first = await firstRegistry.create({ sessionId: input.session_id, turnId: "budget-1", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 1 });
    const second = await firstRegistry.create({ sessionId: input.session_id, turnId: "budget-2", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 1 });
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));
    const now = new Date("2025-01-01T00:00:00.000Z");

    await expect(sweepAutopilotChoices({ choiceRegistry: firstRegistry, policyStore, resume, now })).resolves.toEqual([
      { requestId: first.requestId, status: "resumed" },
      { requestId: second.requestId, status: "human-required", reason: "Timeout continuation budget is exhausted" },
    ]);
    expect(resume).toHaveBeenCalledTimes(1);

    const restartedRegistry = new ChoiceRegistry(choicesPath);
    const afterRestart = await restartedRegistry.create({ sessionId: input.session_id, turnId: "budget-3", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 1 });
    await expect(sweepAutopilotChoices({ choiceRegistry: restartedRegistry, policyStore, resume, now })).resolves.toEqual([
      { requestId: afterRestart.requestId, status: "human-required", reason: "Timeout continuation budget is exhausted" },
    ]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a policy update wins between timeout discovery and the dispatch fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-policy-race-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: "policy-race", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));

    await expect(sweepAutopilotChoices({
      choiceRegistry: registry,
      policyStore,
      resume,
      targetAvailable: async () => {
        await policyStore.replacePolicy({ ...policy(), enabled: false, timeout: { mode: "hold", delayMs: 0 } }, saved.revision);
        return true;
      },
      now: new Date("2025-01-01T00:00:00.000Z"),
    })).resolves.toEqual([
      { requestId: pending.requestId, status: "human-required", reason: "Autopilot policy or selector changed before timeout dispatch" },
    ]);
    expect(resume).not.toHaveBeenCalled();
    expect((await registry.get(pending.requestId))?.status).toBe("expired-needs-human");
  });

  it("loads the hook policy from the configured custom policy-store path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-hook-custom-policy-"));
    const stateDir = join(root, "state");
    const customPath = join(root, "custom", "policy.json");
    const store = new AutopilotPolicyStore(customPath);
    const saved = await store.replacePolicy(policy(), null);

    await expect(loadEffectivePolicyForStopHook(stateDir, new Set(), {
      AGENT_HERDER_AUTOPILOT_POLICY_STORE: customPath,
    })).resolves.toMatchObject({
      source: "persisted",
      revision: saved.revision,
      policy: { enabled: true },
    });
  });

  it("fails closed when the saved timeout target changes before dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-target-revoked-"));
    const choicesPath = join(root, "choices.json");
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(choicesPath);
    const pending = await registry.create({ sessionId: input.session_id, turnId: "target-revoked", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));

    await expect(sweepAutopilotChoices({
      choiceRegistry: registry,
      policyStore,
      resume,
      targetAvailable: async () => {
        const state = JSON.parse(await readFile(choicesPath, "utf8")) as { requests: Array<{ requestId: string; nextGoal?: string }> };
        state.requests.find((record) => record.requestId === pending.requestId)!.nextGoal = "Replacement target must never be resumed.";
        await writeFile(choicesPath, `${JSON.stringify(state)}\n`, "utf8");
        return true;
      },
      now: new Date("2025-01-01T00:00:00.000Z"),
    })).resolves.toEqual([
      { requestId: pending.requestId, status: "human-required", reason: "Saved timeout target is no longer valid" },
    ]);
    expect(resume).not.toHaveBeenCalled();
    expect((await registry.get(pending.requestId))?.status).toBe("expired-needs-human");
  });

  it("requires the live Codex CWD to match the canonical timeout scope before resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-sweep-cwd-scope-"));
    const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const saved = await policyStore.replacePolicy(policy(), null);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({ sessionId: input.session_id, turnId: "cwd-mismatch", cwd: input.cwd, choices, expiresAt: "2020-01-01T00:00:00.000Z", timeoutChoiceId: "inspect", policyRevision: saved.revision, maxContinuationsPerSession: 3 });
    const resume = vi.fn(async (choice: PendingChoice) => acceptedReceipt(choice));

    expect(liveCodexTargetMatchesChoice(pending, liveCodexSession("/workspace/other/../app"))).toBe(true);
    expect(liveCodexTargetMatchesChoice(pending, liveCodexSession("/workspace/other-project"))).toBe(false);
    await expect(sweepAutopilotChoices({
      choiceRegistry: registry,
      policyStore,
      resume,
      targetAvailable: async (choice) => liveCodexTargetMatchesChoice(choice, liveCodexSession("/workspace/other-project")),
      now: new Date("2025-01-01T00:00:00.000Z"),
    })).resolves.toEqual([
      { requestId: pending.requestId, status: "human-required", reason: "Codex session is no longer available for timeout continuation" },
    ]);
    expect(resume).not.toHaveBeenCalled();
    expect((await registry.get(pending.requestId))?.status).toBe("expired-needs-human");
  });
});
