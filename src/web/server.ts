import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { HarnessType } from "session-convert";
import { LineageStore } from "../lineage-store.js";
import { SessionNotFoundError, SessionSupervisor } from "../session-supervisor.js";
import type { AgentSession, HarnessAdapter, SessionDetails } from "../types/index.js";
import type { AgentHerderSessionConverter, ConvertSessionInput } from "../session-convert.js";
import { HumanRequestRegistry } from "../human-request/index.js";
import { buildSessionProgress } from "../health-progress.js";
import { healthModelForHarness, normalizeHealthExecution } from "../health-remediation.js";
import { convertHermesExport } from "../hermes-conversion.js";
import { AgentResumeClient, resumeBoundTarget, type ResumeReceipt, type ResumeTransportRequest } from "../resume-transport.js";
import { ChoiceRegistry, ChoiceRegistryLockUnavailableError, type PendingChoice } from "../autopilot/choice-registry.js";
import { AutopilotPolicyRevisionConflictError, AutopilotPolicyStore } from "../autopilot/policy-store.js";
import { AutopilotSessionStore, type AutopilotHarness } from "../autopilot/session-store.js";
import { codexSelectorKey, createCodexSelectorFromStopSession, effectivePolicyAllowsTarget } from "../autopilot/policy.js";
import { renderSessionGraph } from "../session-visualization.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdapterRegistry } from "../adapter-registry.js";

export interface WebDependencies {
  adapters: Map<string, HarnessAdapter>;
  converter: Pick<AgentHerderSessionConverter, "convert"> & Partial<Pick<AgentHerderSessionConverter, "read">>;
  lineageStore?: LineageStore;
  humanRequests?: HumanRequestRegistry;
  adapterRegistry?: AdapterRegistry;
  mcpServerFactory?: () => McpServer;
  mcpAuthToken?: string;
  choiceRegistry?: ChoiceRegistry;
  choiceResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  choiceQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  autopilotPolicyStore?: AutopilotPolicyStore;
  autopilotSessionStore?: AutopilotSessionStore;
  autopilotSweepIntervalMs?: number;
  sessionVisualizer?: (details: SessionDetails) => Promise<string>;
}

export type AutopilotSweepOutcome = {
  requestId?: string;
  status: "resumed" | "failed" | "human-required";
  reason?: string;
};

/** Build the immutable Agent Resume request from the saved timeout choice. */
export function buildChoiceResumeRequest(choice: Pick<PendingChoice, "harness" | "sessionId" | "cwd" | "nextGoal" | "requestId" | "idempotencyKey" | "resultRef">): ResumeTransportRequest {
  if (!choice.nextGoal || !choice.idempotencyKey) throw new Error("choice has no saved resume goal or idempotency key");
  const harness = choice.harness ?? "codex";
  if (harness === "hermes") throw new Error("Hermes choices are delivered by the Hermes plugin");
  const selector = createCodexSelectorFromStopSession({ sessionId: choice.sessionId, cwd: choice.cwd });
  return {
    target: { agent: harness, session_id: selector.sessionId, cwd: selector.cwd },
    goal: choice.nextGoal,
    prompt: choice.nextGoal,
    result_ref: choice.resultRef || `agent-herder://autopilot/choice/${choice.requestId}`,
    idempotency_key: choice.idempotencyKey,
  };
}

/** Backwards-compatible name retained for timeout callers and tests. */
export const buildTimeoutResumeRequest = buildChoiceResumeRequest;

/** Acknowledge Hermes locally; its plugin observes the durable resumed record and injects the goal. */
function localHookTimeoutReceipt(choice: PendingChoice): ResumeReceipt {
  if (!choice.idempotencyKey) throw new Error("local hook timeout has no saved idempotency key");
  const agent = choice.harness === "zcode" ? "zcode" : "hermes";
  if (agent === "zcode") {
    return {
      status: "accepted",
      target: { agent: "zcode", session_id: choice.sessionId, cwd: choice.cwd },
      result_ref: choice.resultRef,
      idempotency_key: choice.idempotencyKey,
      receipt_ref: `agent-herder://zcode/choice/${choice.requestId}`,
    };
  }
  return {
    status: "accepted",
    target: { agent: "hermes", locator: { schema: "hermes.locator.v2", session_key: choice.sessionId, platform: "local", chat_id: choice.sessionId, chat_type: "dm" } },
    result_ref: choice.resultRef,
    idempotency_key: choice.idempotencyKey,
    receipt_ref: `agent-herder://hermes/choice/${choice.requestId}`,
  };
}

async function completeManualChoiceResume(
  response: ServerResponse,
  choiceRegistry: ChoiceRegistry,
  pending: PendingChoice,
  receipt: ResumeReceipt,
  recovered: boolean,
): Promise<void> {
  const expectedKey = pending.idempotencyKey;
  if (
    !pending.choiceId ||
    !expectedKey ||
    receipt.idempotency_key !== expectedKey ||
    receipt.result_ref !== pending.resultRef
  ) {
    return sendJson(response, 502, {
      request_id: pending.requestId,
      status: pending.status,
      choice_id: pending.choiceId,
      session_id: pending.sessionId,
      resumed: false,
      error: "Agent Resume receipt does not match the saved choice",
    });
  }
  const stored = {
    status: receipt.status,
    resultRef: receipt.result_ref,
    idempotencyKey: receipt.idempotency_key,
    ...(("receipt_ref" in receipt && receipt.receipt_ref) ? { receiptRef: receipt.receipt_ref } : {}),
    ...(("reason" in receipt && receipt.reason) ? { reason: receipt.reason } : {}),
  } as PendingChoice["resumeReceipt"];
  await choiceRegistry.persistManualResumeReceipt(pending.requestId, pending.choiceId, stored);
  if (receipt.status !== "accepted") {
    return sendJson(response, 502, {
      request_id: pending.requestId,
      status: pending.status,
      choice_id: pending.choiceId,
      session_id: pending.sessionId,
      resumed: false,
      error: receipt.reason,
    });
  }
  const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
  return sendJson(response, 202, {
    request_id: resumed.requestId,
    status: resumed.status,
    choice_id: resumed.choiceId,
    session_id: resumed.sessionId,
    resumed: true,
    ...(recovered ? { recovered: true } : {}),
    transport: "agent-resume",
  });
}

const autopilotSweepLocks = new Map<string, Promise<void>>();

/** Sweep durable timeout choices and resume only a still-authorized Codex target once. */
export async function sweepAutopilotChoices(input: {
  choiceRegistry: ChoiceRegistry;
  policyStore: AutopilotPolicyStore;
  sessionStore?: AutopilotSessionStore;
  now?: Date;
  targetAvailable?: (choice: PendingChoice) => Promise<boolean>;
  validateSavedTarget?: (choice: PendingChoice) => Promise<boolean>;
  resume: (choice: PendingChoice) => Promise<ResumeReceipt>;
  query?: (choice: PendingChoice) => Promise<ResumeReceipt>;
}): Promise<AutopilotSweepOutcome[]> {
  const key = input.choiceRegistry.coordinationKey;
  const previous = autopilotSweepLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  autopilotSweepLocks.set(key, current);
  await previous;
  try {
    return await sweepAutopilotChoicesUnlocked(input);
  } finally {
    release();
    if (autopilotSweepLocks.get(key) === current) autopilotSweepLocks.delete(key);
  }
}

/** Execute one timeout sweep after the per-registry overlap fence has been acquired. */
async function sweepAutopilotChoicesUnlocked(input: {
  choiceRegistry: ChoiceRegistry;
  policyStore: AutopilotPolicyStore;
  sessionStore?: AutopilotSessionStore;
  now?: Date;
  targetAvailable?: (choice: PendingChoice) => Promise<boolean>;
  validateSavedTarget?: (choice: PendingChoice) => Promise<boolean>;
  resume: (choice: PendingChoice) => Promise<ResumeReceipt>;
  query?: (choice: PendingChoice) => Promise<ResumeReceipt>;
}): Promise<AutopilotSweepOutcome[]> {
  const now = input.now ?? new Date();
  let claimed: PendingChoice[];
  try {
    claimed = await input.choiceRegistry.claimExpired(now);
  } catch (error) {
    if (error instanceof ChoiceRegistryLockUnavailableError) {
      return [{ status: "human-required", reason: error.message }];
    }
    throw error;
  }

  const outcomes: AutopilotSweepOutcome[] = [];
  const freshClaims = new Set(claimed.filter((choice) => choice.status === "claimed" && choice.claimToken).map((choice) => choice.requestId));
  let inFlight: PendingChoice[];
  try {
    inFlight = await input.choiceRegistry.listInFlightTimeoutClaims();
  } catch (error) {
    if (error instanceof ChoiceRegistryLockUnavailableError) {
      return claimed.length > 0
        ? claimed.map((choice) => ({
            requestId: choice.requestId,
            status: "human-required" as const,
            reason: choice.status === "claimed" && choice.claimToken ? error.message : choice.failureReason ?? error.message,
          }))
        : [{ status: "human-required", reason: error.message }];
    }
    throw error;
  }
  const recoveryClaims = inFlight.filter((choice) => !freshClaims.has(choice.requestId));
  for (const choice of [...claimed, ...recoveryClaims]) {
    const isRecovery = !freshClaims.has(choice.requestId);
    if ((!isRecovery && choice.status !== "claimed") || !choice.claimToken) {
      outcomes.push({
        requestId: choice.requestId,
        status: "human-required",
        reason: choice.failureReason ?? "Timeout claim cannot be dispatched safely",
      });
      continue;
    }
    const humanRequired = async (reason: string): Promise<void> => {
      try {
        await input.choiceRegistry.markHumanRequired(choice.requestId, choice.claimToken!, reason);
      } catch (error) {
        if (!(error instanceof ChoiceRegistryLockUnavailableError)) throw error;
      }
      outcomes.push({ requestId: choice.requestId, status: "human-required", reason });
    };

    const completeReceipt = async (receipt: ResumeReceipt): Promise<boolean> => {
      const expectedKey = choice.idempotencyKey;
      const expectedRef = choice.resultRef || `agent-herder://autopilot/choice/${choice.requestId}`;
      if (!expectedKey || receipt.idempotency_key !== expectedKey || receipt.result_ref !== expectedRef) {
        await humanRequired("Agent Resume receipt does not match the saved timeout request");
        return false;
      }
      const stored = {
        status: receipt.status,
        resultRef: receipt.result_ref,
        idempotencyKey: receipt.idempotency_key,
        ...(("receipt_ref" in receipt && receipt.receipt_ref) ? { receiptRef: receipt.receipt_ref } : {}),
        ...(("reason" in receipt && receipt.reason) ? { reason: receipt.reason } : {}),
      } as PendingChoice["resumeReceipt"];
      try {
        await input.choiceRegistry.persistResumeReceipt(choice.requestId, choice.claimToken!, stored);
        if (receipt.status === "accepted") {
          await input.choiceRegistry.markResumed(choice.requestId, choice.claimToken!);
          outcomes.push({ requestId: choice.requestId, status: "resumed" });
          return true;
        }
        if (receipt.status === "failed" || receipt.status === "rejected") {
          await input.choiceRegistry.markFailed(choice.requestId, choice.claimToken!, receipt.reason);
          outcomes.push({ requestId: choice.requestId, status: "failed", reason: receipt.reason });
          return false;
        }
        await humanRequired(`Agent Resume returned ${receipt.status}: ${receipt.reason}`);
        return false;
      } catch (error) {
        if (error instanceof ChoiceRegistryLockUnavailableError) {
          await humanRequired(error.message);
          return false;
        }
        throw error;
      }
    };

    if (isRecovery) {
      if (!input.query) {
        await humanRequired("Timeout recovery requires a durable Agent Resume receipt query");
        continue;
      }
      try {
        const receipt = await input.query(choice);
        if (choice.status === "claimed") {
          const dispatching = await input.choiceRegistry.markDispatching(choice.requestId, choice.claimToken!, now);
          if (!dispatching) {
            await humanRequired("Timeout recovery claim is no longer dispatchable");
            continue;
          }
        }
        await completeReceipt(receipt);
      } catch (error) {
        await humanRequired(`Timeout receipt query failed: ${(error as Error).message}`);
      }
      continue;
    }

    try {
      if (input.targetAvailable && !(await input.targetAvailable(choice))) {
        await humanRequired("Codex session is no longer available for timeout continuation");
        continue;
      }
    } catch (error) {
      await humanRequired(`Timeout target revalidation failed: ${(error as Error).message}`);
      continue;
    }

    let preparation: { kind: "dispatching"; choice: PendingChoice } | { kind: "human-required"; reason: string };
    try {
      preparation = await input.policyStore.withMutationFence(async () => {
        const effective = await input.policyStore.readEffective();
        const sessionOverride = await input.sessionStore?.get(choice.harness ?? "codex", choice.sessionId);
        const targetEnabled = effective.policy.enabled && (sessionOverride?.enabled ?? effectivePolicyAllowsTarget(effective, {
          harness: choice.harness ?? "codex",
          sessionId: choice.sessionId,
          cwd: choice.cwd,
        }));
        if (effective.source !== "persisted" || effective.revision !== choice.policyRevision ||
          effective.policy.timeout.mode !== "auto_continue" || !targetEnabled) {
          return { kind: "human-required", reason: "Autopilot policy or selector changed before timeout dispatch" };
        }
        if (!hasSavedTimeoutTarget(choice) || input.validateSavedTarget && !(await input.validateSavedTarget(choice))) {
          return { kind: "human-required", reason: "Saved timeout target is no longer valid" };
        }
        const dispatching = await input.choiceRegistry.markDispatching(
          choice.requestId,
          choice.claimToken!,
          now,
          effective.policy.maxContinuationsPerSession,
        );
        if (dispatching && !hasSavedTimeoutTarget(dispatching)) {
          return { kind: "human-required", reason: "Saved timeout target is no longer valid" };
        }
        return dispatching
          ? { kind: "dispatching", choice: dispatching }
          : { kind: "human-required", reason: "Timeout claim could not be dispatched safely" };
      });
    } catch (error) {
      if (error instanceof ChoiceRegistryLockUnavailableError) {
        await humanRequired(error.message);
        continue;
      }
      await humanRequired(`Timeout dispatch revalidation failed: ${(error as Error).message}`);
      continue;
    }
    if (preparation.kind === "human-required") {
      await humanRequired(preparation.reason);
      continue;
    }
    const dispatching = preparation.choice;

    let result: ResumeReceipt;
    try {
      result = await input.resume(dispatching);
    } catch (error) {
      await humanRequired(`Agent Resume invocation failed: ${(error as Error).message}`);
      continue;
    }
    await completeReceipt(result);
  }
  return outcomes;
}

/** Verify that dispatch still uses exactly the immutable timeout candidate saved with the choice. */
function hasSavedTimeoutTarget(choice: PendingChoice): boolean {
  if (!choice.timeoutChoiceId || choice.choiceId !== choice.timeoutChoiceId || !choice.nextGoal) return false;
  const saved = choice.choices.find((candidate) => candidate.choiceId === choice.timeoutChoiceId);
  return Boolean(saved && saved.nextGoal === choice.nextGoal);
}

/** Require the live Codex identity to remain in the same canonical project scope as its timeout choice. */
export function liveCodexTargetMatchesChoice(
  choice: Pick<PendingChoice, "sessionId" | "cwd">,
  session: AgentSession | null,
): boolean {
  if (!session || session.harness !== "codex" || session.id !== choice.sessionId) return false;
  try {
    return codexSelectorKey(createCodexSelectorFromStopSession({
      sessionId: choice.sessionId,
      cwd: choice.cwd,
    })) === codexSelectorKey(createCodexSelectorFromStopSession({
      sessionId: session.id,
      cwd: session.cwd,
    }));
  } catch {
    return false;
  }
}

/** Require the live session to match the timeout's actual harness, id and canonical CWD. */
export function liveAutopilotTargetMatchesChoice(
  choice: Pick<PendingChoice, "harness" | "sessionId" | "cwd">,
  session: AgentSession | null,
): boolean {
  const harness = choice.harness ?? "codex";
  if (!session || session.harness !== harness || session.id !== choice.sessionId) return false;
  if (harness === "codex") return liveCodexTargetMatchesChoice(choice, session);
  try {
    return normalize(session.cwd) === normalize(choice.cwd);
  } catch {
    return false;
  }
}

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "index.html");
const webRoot = dirname(htmlPath);

export function createWebServer(dependencies: WebDependencies): Server {
  const supervisor = new SessionSupervisor(dependencies.adapters, dependencies.converter, dependencies.lineageStore);
  const sessionVisualizer = dependencies.sessionVisualizer || ((details: SessionDetails) => Promise.resolve(renderSessionGraph(details)));
  const mcpTransports = new Map<string, StreamableHTTPServerTransport>();
  const mcpAuthToken = dependencies.mcpAuthToken?.trim() || undefined;
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, supervisor, dependencies.humanRequests, dependencies.mcpServerFactory, mcpTransports, dependencies.adapterRegistry, mcpAuthToken, dependencies.choiceRegistry, dependencies.choiceResume, dependencies.choiceQuery, dependencies.autopilotSessionStore, dependencies.autopilotPolicyStore, sessionVisualizer);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      sendJson(response, 502, { error: (err as Error).message });
    }
  });
  if (dependencies.choiceRegistry && dependencies.autopilotPolicyStore) {
    const sweep = () => sweepAutopilotChoices({
      choiceRegistry: dependencies.choiceRegistry!,
      policyStore: dependencies.autopilotPolicyStore!,
      sessionStore: dependencies.autopilotSessionStore,
      targetAvailable: async (choice) => choice.harness === "hermes" || choice.harness === "zcode" || liveAutopilotTargetMatchesChoice(
        choice,
        await supervisor.getSession(choice.harness ?? "codex", choice.sessionId),
      ),
      resume: async (choice) => {
        if (choice.harness === "hermes" || choice.harness === "zcode") return localHookTimeoutReceipt(choice);
        return new AgentResumeClient().resume(buildTimeoutResumeRequest(choice));
      },
      query: async (choice) => {
        if (choice.harness === "hermes" || choice.harness === "zcode") return localHookTimeoutReceipt(choice);
        return new AgentResumeClient().queryReceipt(buildTimeoutResumeRequest(choice));
      },
    }).catch((error) => console.error(`[agent-herder] autopilot sweep failed: ${(error as Error).message}`));
    const intervalMs = Math.max(100, dependencies.autopilotSweepIntervalMs ?? 30_000);
    const timer = setInterval(sweep, intervalMs);
    timer.unref?.();
    server.once("close", () => clearInterval(timer));
  }
  return server;
}

async function route(request: IncomingMessage, response: ServerResponse, supervisor: SessionSupervisor, humanRequests?: HumanRequestRegistry, mcpServerFactory?: () => McpServer, mcpTransports?: Map<string, StreamableHTTPServerTransport>, adapterRegistry?: AdapterRegistry, mcpAuthToken?: string, choiceRegistry?: ChoiceRegistry, choiceResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, choiceQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, autopilotSessionStore?: AutopilotSessionStore, autopilotPolicyStore?: AutopilotPolicyStore, sessionVisualizer?: (details: SessionDetails) => Promise<string>): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/api/autopilot/policy" && (request.method === "GET" || request.method === "PUT")) {
    if (!autopilotPolicyStore) return sendJson(response, 503, { error: "Autopilot policy store is disabled" });
    if (request.method === "GET") return sendJson(response, 200, await autopilotPolicyStore.readEffective());
    const body = await readJson(request);
    if (!body.policy || !(body.expectedRevision === null || typeof body.expectedRevision === "string")) {
      return sendJson(response, 400, { error: "policy and expectedRevision are required" });
    }
    try {
      return sendJson(response, 200, await autopilotPolicyStore.replacePolicy(body.policy as never, body.expectedRevision));
    } catch (error) {
      if (error instanceof AutopilotPolicyRevisionConflictError) {
        return sendJson(response, 409, { error: error.message, current: await autopilotPolicyStore.readEffective() });
      }
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  const autopilotSessionMatch = url.pathname.match(/^\/api\/autopilot\/sessions\/([^/]+)\/([^/]+)$/);
  if (autopilotSessionMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    if (!autopilotSessionStore) return sendJson(response, 503, { error: "Autopilot session store is disabled" });
    const harness = decodeURIComponent(autopilotSessionMatch[1]);
    const sessionId = decodeURIComponent(autopilotSessionMatch[2]);
    if (!isAutopilotHarness(harness) || sessionId.trim().length === 0) return sendJson(response, 400, { error: "unsupported harness or empty session id" });
    if (request.method === "GET") {
      const record = await autopilotSessionStore.get(harness, sessionId);
      const effective = autopilotPolicyStore ? await autopilotPolicyStore.readEffective() : undefined;
      const cwd = url.searchParams.get("cwd") || record?.cwd || "/";
      const inheritedEnabled = effective
        ? effectivePolicyAllowsTarget(effective, { harness, sessionId, cwd })
        : harness === "codex";
      return sendJson(response, 200, {
        harness,
        sessionId,
        enabled: record?.enabled ?? inheritedEnabled,
        source: record ? "session" : effective ? "policy" : harness === "codex" ? "plugin-default" : "default",
        ...(record ? { cwd: record.cwd, updatedAt: record.updatedAt } : {}),
      });
    }
    if (request.method === "DELETE") {
      await autopilotSessionStore.delete(harness, sessionId);
      const effective = autopilotPolicyStore ? await autopilotPolicyStore.readEffective() : undefined;
      const cwd = url.searchParams.get("cwd") || "/";
      return sendJson(response, 200, {
        harness,
        sessionId,
        enabled: effective ? effectivePolicyAllowsTarget(effective, { harness, sessionId, cwd }) : harness === "codex",
        source: effective ? "policy" : harness === "codex" ? "plugin-default" : "default",
      });
    }
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean" || typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
      return sendJson(response, 400, { error: "enabled and cwd are required" });
    }
    try {
      const record = await autopilotSessionStore.set({ harness, sessionId, cwd: body.cwd }, body.enabled);
      return sendJson(response, 200, { ...record, source: "session" });
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/autopilot/choices") {
    if (!choiceRegistry) return sendJson(response, 503, { error: "Choice registry is disabled" });
    const status = url.searchParams.get("status") || "pending";
    if (status !== "pending") return sendJson(response, 400, { error: "status must be pending" });
    const records = await choiceRegistry.list({ status: "pending" });
    // A forgotten manual choice must not keep a stopped session pinned in the
    // active dashboard forever. Keep the durable registry intact, but only
    // project recent pending choices into the web UI.
    const staleChoiceCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const visibleRecords = records.filter((record) => {
      const createdAt = Date.parse(record.createdAt);
      return Number.isFinite(createdAt) && createdAt >= staleChoiceCutoffMs;
    });
    return sendJson(response, 200, {
      choices: visibleRecords.map((record) => ({
        requestId: record.requestId,
        sessionId: record.sessionId,
        harness: record.harness ?? "codex",
        cwd: record.cwd,
        status: record.status,
        createdAt: record.createdAt,
        choices: record.choices.map(({ choiceId, label }) => ({ choiceId, label })),
      })),
    });
  }
  const internalChoiceSelection = url.pathname === "/internal/autopilot/choices/select";
  const webChoiceSelection = url.pathname === "/api/autopilot/choices/select";
  if (request.method === "POST" && (internalChoiceSelection || webChoiceSelection)) {
    if (!choiceRegistry) return sendJson(response, 503, { error: "Choice registry is disabled" });
    if (internalChoiceSelection && mcpAuthToken && request.headers.authorization !== `Bearer ${mcpAuthToken}`) return sendJson(response, 401, { error: "unauthorized" });
    const body = await readJson(request);
    if (!isUuid(body.request_id) || typeof body.choice_id !== "string" || body.choice_id.trim() === "") return sendJson(response, 400, { error: "request_id and choice_id are required" });
    const claimed = await choiceRegistry.claimForResume(body.request_id, body.choice_id);
    const pending = claimed.record;
    if (pending.harness === "zcode" && pending.choiceId === body.choice_id) {
      // The live Stop hook owns the actual continuation. Keep the durable
      // claim until it reads the goal, so a hook/runtime restart cannot turn a
      // Telegram click into a lost continuation.
      return sendJson(response, 202, {
        request_id: pending.requestId,
        status: pending.status,
        choice_id: pending.choiceId,
        session_id: pending.sessionId,
        resumed: false,
        delivery: "waiting-for-zcode-stop-hook",
        duplicate: !claimed.claimed,
        transport: "zcode-stop-hook",
      });
    }
    if (pending.harness === "hermes" && pending.choiceId === body.choice_id) {
      if (pending.status === "claimed") {
        const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
        return sendJson(response, 202, { request_id: resumed.requestId, status: resumed.status, choice_id: resumed.choiceId, session_id: resumed.sessionId, resumed: true, transport: "hermes-plugin" });
      }
      return sendJson(response, 202, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: pending.status === "resumed", duplicate: !claimed.claimed, transport: "hermes-plugin" });
    }
    if (!claimed.claimed) {
      if (
        pending.status === "claimed" &&
        pending.choiceId === body.choice_id &&
        pending.nextGoal &&
        pending.idempotencyKey
      ) {
        const resumeRequest = buildChoiceResumeRequest(pending);
        if (pending.resumeReceipt?.status === "accepted") {
          const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
          return sendJson(response, 202, { request_id: resumed.requestId, status: resumed.status, choice_id: resumed.choiceId, session_id: resumed.sessionId, resumed: true, recovered: true, transport: "agent-resume" });
        }
        try {
          const client = new AgentResumeClient();
          const receipt = await (choiceQuery ?? ((input) => client.queryReceipt(input)))(resumeRequest);
          return completeManualChoiceResume(response, choiceRegistry, pending, receipt, true);
        } catch (error) {
          return sendJson(response, 502, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: false, duplicate: true, error: `Agent Resume receipt query failed: ${(error as Error).message}` });
        }
      }
      return sendJson(response, 202, {
        request_id: pending.requestId,
        status: pending.status,
        choice_id: pending.choiceId,
        session_id: pending.sessionId,
        resumed: false,
        duplicate: true,
      });
    }
    if (pending.sessionId.length === 0 || !pending.nextGoal) return sendJson(response, 409, { error: "choice has no resumable goal" });
    const resumeRequest = buildChoiceResumeRequest(pending);
    try {
      const client = new AgentResumeClient();
      const receipt = await (choiceResume ?? ((input) => client.resume(input)))(resumeRequest);
      return completeManualChoiceResume(response, choiceRegistry, pending, receipt, false);
    } catch (error) {
      return sendJson(response, 502, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: false, error: `Agent Resume invocation failed: ${(error as Error).message}` });
    }
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    const harness = url.searchParams.get("harness")?.trim();
    if (!harness) return sendJson(response, 400, { error: "harness is required" });
    try {
      return sendJson(response, 200, await supervisor.getModels(harness));
    } catch (error) {
      return sendJson(response, 404, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/api/adapters" && request.method === "GET") {
    if (!adapterRegistry) return sendJson(response, 503, { error: "Adapter registry is disabled" });
    return sendJson(response, 200, { adapters: adapterRegistry.list() });
  }
  const adapterMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)$/);
  if (adapterMatch && request.method === "POST") {
    if (!adapterRegistry) return sendJson(response, 503, { error: "Adapter registry is disabled" });
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "enabled must be boolean" });
    try {
      const adapter = await adapterRegistry.setEnabled(decodeURIComponent(adapterMatch[1]), body.enabled);
      return sendJson(response, 200, { adapter });
    } catch (error) {
      return sendJson(response, 404, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/mcp" && request.method === "POST") {
    if (mcpAuthToken && request.headers.authorization !== `Bearer ${mcpAuthToken}`) {
      return sendJson(response, 401, { error: "unauthorized" });
    }
    if (!mcpServerFactory || !mcpTransports) return sendJson(response, 503, { error: "MCP HTTP transport is disabled" });
    const body = await readJson(request);
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    let transport = sessionId ? mcpTransports.get(sessionId) : undefined;
    if (!transport && !sessionId && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpTransports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) mcpTransports.delete(transport.sessionId);
      };
      await mcpServerFactory().connect(transport);
    }
    if (!transport) return sendJson(response, 400, { jsonrpc: "2.0", error: { code: -32000, message: "MCP session is required" }, id: null });
    await transport.handleRequest(request, response, body);
    return;
  }
  if (request.method === "POST" && (url.pathname === "/internal/human-requests/sss-completion" || url.pathname === "/internal/human-requests/ask-user-completion")) {
    if (!humanRequests) return sendJson(response, 503, { error: "Human Request registry is disabled" });
    const body = await readJson(request);
    const expectedKind = url.pathname.endsWith("sss-completion") ? "secret" : "user";
    const expectedEvent = expectedKind === "secret" ? "sss.secret_input.completed" : "ask.user.completed";
    if (body.event !== expectedEvent || body.event_version !== 1 || body.status !== "completed" ||
      !isUuid(body.request_id) || !isUuid(body.result_ref)) {
      return sendJson(response, 400, { error: "invalid opaque human-request completion event" });
    }
    const pending = await humanRequests.get(body.request_id);
    if (!pending || pending.kind !== expectedKind) {
      return sendJson(response, 409, { error: "completion does not match the pending human request kind" });
    }
    const claimed = await humanRequests.claimResume(body.request_id, { resultRef: body.result_ref });
    if (claimed.status !== "resuming" || !claimed.attemptId) {
      return sendJson(response, 202, { request_id: claimed.requestId, status: claimed.status });
    }
    const target = claimed.target;
    if (!target.agent || !(["codex", "opencode", "claude"].includes(target.agent) && target.cwd || target.agent === "hermes" && target.locator)) {
      const failed = await humanRequests.failResume(claimed.requestId, { attemptId: claimed.attemptId, receipt: "resume-target-unsupported" });
      return sendJson(response, 422, { request_id: failed.requestId, status: failed.status });
    }
    const resumeTarget = target.agent === "hermes"
      ? { agent: "hermes" as const, locator: target.locator as unknown as import("../resume-transport.js").HermesResumeLocator }
      : { agent: target.agent as "codex" | "opencode" | "claude", session_id: target.sessionId, cwd: target.cwd!, ...(target.marker ? { marker: target.marker } : {}) };
    const receipt = await resumeBoundTarget({ target: resumeTarget, result_ref: body.result_ref });
    const record = receipt.status === "accepted"
      ? await humanRequests.completeResume(claimed.requestId, { attemptId: claimed.attemptId, receipt: receipt.receipt_ref })
      : await humanRequests.failResume(claimed.requestId, { attemptId: claimed.attemptId, receipt: `agent-resume:${receipt.reason}` });
    return sendJson(response, receipt.status === "accepted" ? 202 : 502, { request_id: record.requestId, status: record.status, continuation: record.continuation });
  }
  if (request.method === "GET" && url.pathname === "/") {
    const html = await readFile(htmlPath, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const assetPath = normalize(join(webRoot, url.pathname));
    if (!assetPath.startsWith(`${webRoot}/`)) {
      sendJson(response, 400, { error: "invalid asset path" });
      return;
    }
    try {
      const asset = await readFile(assetPath);
      response.writeHead(200, { "content-type": contentTypeFor(assetPath), "cache-control": "public, max-age=31536000, immutable" });
      response.end(asset);
    } catch {
      sendJson(response, 404, { error: "asset not found" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/fs/dirs") {
    const raw = url.searchParams.get("path") ?? "";
    if (raw.length > 4096 || raw.includes("\0")) return sendJson(response, 400, { error: "invalid path" });
    const expanded = raw === "~" || raw.startsWith("~/") ? `/home/roomhacker${raw.slice(1)}` : raw;
    const candidate = expanded || "/home/roomhacker";
    if (!isAbsolute(candidate)) return sendJson(response, 400, { error: "path must be absolute" });
    const endsWithSlash = candidate.endsWith(sep);
    const parent = resolve(endsWithSlash ? candidate : dirname(candidate));
    const prefix = endsWithSlash ? "" : basename(candidate).toLowerCase();
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => prefix.startsWith(".") || !entry.name.startsWith("."))
        .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
        .slice(0, 60)
        .map((entry) => ({ name: entry.name, path: join(parent, entry.name) }));
      return sendJson(response, 200, { parent, prefix, dirs });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
      if (code === "ENOENT" || code === "ENOTDIR") return sendJson(response, 200, { parent, prefix, dirs: [] });
      if (code === "EACCES") return sendJson(response, 403, { error: "directory is not readable", parent });
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const filters = {
      harness: url.searchParams.get("harness") || undefined,
      status: url.searchParams.get("status") || undefined,
      cwd: url.searchParams.get("cwd") || undefined,
    };
    if (url.searchParams.get("quick") === "1") {
      const snapshot = supervisor.listSessionsFast(filters);
      return sendJson(response, 200, snapshot);
    }
    const sessions = await supervisor.listSessions(filters);
    sendJson(response, 200, { sessions, warming: false });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health/remediation") {
    return sendJson(response, 405, { error: "method_not_allowed", route: "/api/health/remediation" });
  }
  if (request.method === "POST" && url.pathname === "/api/health/remediation") {
    const body = await readJson(request);
    let incidentId: string;
    let planId: string;
    try {
      incidentId = boundedHealthIdentifier(body.incident_id, "incident_id");
      planId = boundedHealthIdentifier(body.plan_id, "plan_id");
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
    const harness = body.harness === undefined ? "opencode" : body.harness;
    if (harness !== "opencode" && harness !== "codex" && harness !== "hermes") {
      return sendJson(response, 400, { error: "health remediation harness must be opencode, codex, or hermes" });
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 128 ||
      typeof body.cwd !== "string" || !body.cwd.startsWith("/") ||
      typeof body.message !== "string" || body.message.trim().length === 0 || body.message.length > 32_000) {
      return sendJson(response, 400, { error: "health remediation requires bounded name, absolute cwd, and message" });
    }
    let execution;
    try {
      execution = normalizeHealthExecution(body.execution);
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
    if (harness === "hermes") {
      const configured = supervisor.getExecutionProfile("hermes");
      if (!configured || configured.provider !== execution.provider || configured.reasoning !== execution.reasoning || configured.toolsets !== "terminal") {
        return sendJson(response, 409, { error: "Hermes health execution profile is not the approved provider/reasoning/toolset" });
      }
    }
    if (harness !== execution.runtime) {
      return sendJson(response, 409, { error: `health remediation harness must match execution runtime (${execution.runtime})` });
    }
    const model = healthModelForHarness(harness, execution);
    const message = [
      `Health remediation incident=${incidentId} plan=${planId}`,
      `Execution profile: runtime=${execution.runtime} provider=${execution.provider} model=${execution.model} reasoning=${execution.reasoning} topic=${execution.topic}`,
      body.message.trim(),
    ].join("\n\n");
    const result = await supervisor.newOrResumeNamedSession({
      harness,
      name: body.name,
      cwd: body.cwd,
      message,
      mode: "queue",
      model,
    });
    return sendJson(response, result.ok ? 200 : 502, { ...result, incident_id: incidentId, plan_id: planId, execution, model });
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string") {
      return sendJson(response, 400, { error: "harness, name, and cwd are required" });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 128)) return sendJson(response, 400, { error: "model must be a bounded string" });
    const result = await supervisor.createNamedSession({ harness: body.harness, name: body.name, cwd: body.cwd, model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined });
    return sendNamedSessionResult(response, result);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/new-or-resume") {
    const body = await readJson(request);
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string" || typeof body.message !== "string") {
      return sendJson(response, 400, { error: "harness, name, cwd, and message are required" });
    }
    if (body.mode !== undefined && body.mode !== "queue" && body.mode !== "sync") {
      return sendJson(response, 400, { error: "mode must be queue or sync" });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.trim().length === 0 || body.model.length > 128)) {
      return sendJson(response, 400, { error: "model must be a bounded non-empty string" });
    }
    const result = await supervisor.newOrResumeNamedSession({
      harness: body.harness,
      name: body.name,
      cwd: body.cwd,
      message: body.message,
      mode: body.mode as "queue" | "sync" | undefined,
      model: body.model as string | undefined,
    });
    return sendNamedSessionResult(response, result);
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    const session = await supervisor.getSession(decodeURIComponent(sessionMatch[1]), decodeURIComponent(sessionMatch[2]));
    if (!session) return sendJson(response, 404, { error: "Session not found" });
    return sendJson(response, 200, { session });
  }
  const detailsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/details$/);
  if (detailsMatch && request.method === "GET") {
    const limitValue = Number(url.searchParams.get("limit") || "3");
    const history = url.searchParams.get("history") as "auto" | "acp" | "files" | null;
    const quick = url.searchParams.get("quick") === "1" || url.searchParams.get("quick") === "true";
    const details = await supervisor.getSessionDetails(
      decodeURIComponent(detailsMatch[1]),
      decodeURIComponent(detailsMatch[2]),
      { limit: Number.isFinite(limitValue) ? limitValue : 3, history: history || "auto", quick },
    );
    return sendJson(response, 200, details);
  }
  const visualizationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/visualization$/);
  if (visualizationMatch && request.method === "GET") {
    const harness = decodeURIComponent(visualizationMatch[1]);
    const sessionId = decodeURIComponent(visualizationMatch[2]);
    if (!sessionVisualizer) return sendJson(response, 503, { error: "session visualization is disabled" });
    const details = await supervisor.getSessionDetails(harness, sessionId, { limit: 50, history: "auto" });
    const html = await sessionVisualizer(details);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
    return;
  }
  const progressMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/progress$/);
  if (progressMatch && request.method === "GET") {
    const limitValue = Number(url.searchParams.get("limit") || "5");
    const history = url.searchParams.get("history") as "auto" | "acp" | "files" | null;
    const details = await supervisor.getSessionDetails(
      decodeURIComponent(progressMatch[1]),
      decodeURIComponent(progressMatch[2]),
      { limit: Number.isFinite(limitValue) ? limitValue : 5, history: history || "auto" },
    );
    return sendJson(response, 200, buildSessionProgress(details, Number.isFinite(limitValue) ? limitValue : 5));
  }
  const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/(resume|message|stop|cancel|recover|fork|model|permissions\/([^/]+))$/);
  if (actionMatch && request.method === "POST") {
    const body = await readJson(request);
    const harness = decodeURIComponent(actionMatch[1]);
    const id = decodeURIComponent(actionMatch[2]);
    const action = actionMatch[3];
    if (action === "resume") {
      return sendOperationResult(response, await supervisor.resumeSession(harness, id, optionalString(body.message)));
    }
    if (action === "stop") {
      return sendOperationResult(response, await supervisor.stopSession(harness, id));
    }
    if (action === "cancel") {
      return sendOperationResult(response, await supervisor.cancelTurn(harness, id));
    }
    if (action === "recover") {
      return sendOperationResult(response, await supervisor.recoverSession(harness, id, optionalString(body.message)));
    }
    if (action === "fork") {
      return sendOperationResult(response, await supervisor.forkSession(harness, id, optionalString(body.message)));
    }
    if (action === "model") {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        return sendJson(response, 400, { error: "model must be a non-empty string" });
      }
      return sendOperationResult(response, await supervisor.changeModel(harness, id, body.model));
    }
    if (action.startsWith("permissions/")) {
      if (body.response !== "allow" && body.response !== "deny") {
        return sendJson(response, 400, { error: "response must be allow or deny" });
      }
      return sendOperationResult(response, await supervisor.respondPermission(
        harness,
        id,
        decodeURIComponent(actionMatch[4]),
        body.response,
      ));
    }
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return sendJson(response, 400, { error: "message must be a non-empty string" });
    }
    return sendOperationResult(response, await supervisor.sendMessage(harness, id, {
      message: body.message,
      queue: body.mode === "queue",
      steer: body.mode === "steer",
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/conversions") {
    const body = await readJson(request);
    if (typeof body.sessionId !== "string" || typeof body.from !== "string" || typeof body.to !== "string") {
      return sendJson(response, 400, { error: "sessionId, from, and to are required" });
    }
    const input: ConvertSessionInput = {
      sessionId: body.sessionId,
      from: body.from as HarnessType,
      to: body.to as HarnessType,
      projectPath: optionalString(body.projectPath),
      searchPaths: Array.isArray(body.searchPaths) ? body.searchPaths.filter((path): path is string => typeof path === "string") : undefined,
    };
    const result = await supervisor.convertSession(input);
    return sendJson(response, result.success ? 200 : 502, result);
  }
  if (request.method === "POST" && url.pathname === "/api/conversions/hermes-export") {
    const body = await readJson(request);
    if ((body.target !== "codex" && body.target !== "opencode" && body.target !== "claude") || body.export === undefined) {
      return sendJson(response, 400, { error: "target (codex, opencode, or claude) and export are required" });
    }
    const result = convertHermesExport({ target: body.target, export: body.export });
    return sendJson(response, result.conversation ? 200 : 422, result);
  }

  sendJson(response, 404, { error: "Not found" });
}

function isAutopilotHarness(value: string): value is AutopilotHarness {
  return value === "codex" || value === "opencode" || value === "claude" || value === "hermes" || value === "zcode";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedHealthIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`health remediation ${field} must be a bounded identifier`);
  }
  return value;
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendOperationResult(response: ServerResponse, result: { ok: boolean; error?: string; sessionId?: string }): void {
  sendJson(response, result.ok ? 200 : 502, result);
}

function sendNamedSessionResult(
  response: ServerResponse,
  result: { ok: boolean; error?: string },
): void {
  const conflict = result.error?.startsWith("Ambiguous named session") || result.error?.includes("already exists");
  sendJson(response, result.ok ? 200 : conflict ? 409 : 502, result);
}
