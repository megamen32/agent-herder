import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("new operator continuation HTTP", () => {
  it("creates a separate engine-owned input and refuses to reset that accepted continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-new-operator-continuation-http-"));
    directories.push(root);
    const sessionId = "operator-continuation-api-session";
    const cwd = "/workspace/operator-continuation";
    const model = "omniroute/minimax-combo-m3.1";
    let current = { id: sessionId, harness: "opencode" as const, cwd, title: "Continuation", model, status: "error" as const,
      lastActivity: new Date().toISOString(), needsPermission: false };
    const sends: Array<{ model?: string; inputId?: string }> = [];
    const adapter = {
      type: "opencode",
      async init() {},
      async listSessions() { return [current]; },
      async getSession(id: string) { return id === sessionId ? current : null; },
      async listModels() { return [model]; },
      async changeModel() { throw new Error("operator continuation must not switch models"); },
      async sendMessage(_id: string, input: { model?: string; inputId?: string }) {
        sends.push({ model: input.model, inputId: input.inputId });
        return { ok: true, admitted: true, inputId: input.inputId, nativeInputMessageId: "native-new-input" };
      },
    } as unknown as import("../src/types/index.js").HarnessAdapter;
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const oldEvidence = { classification: "operator_cohort" as const, authorizationId: "operator-old-cohort-01",
      nativeTurnId: "old-turn", assistantMessageId: "old-assistant", providerId: "minimax-code",
      modelId: "mmcode/MiniMax-M3.1-Flash", completedAt: new Date(Date.now() - 60_000).toISOString() };
    const original = { ...current, model: "minimax-coding-plan/MiniMax-M3.1-Flash" };
    const seeded = await store.markOperatorCohortEligible(original, oldEvidence, [model]);
    const oldClaim = await store.claimQuotaRecoveryAttempt(seeded, model);
    await store.settleQuotaRecoveryAttempt(oldClaim!, "accepted", { nativeInputMessageId: "native-old-input" });
    const oldReceipt = (await store.list())[0]!.quotaRecovery!;
    const snapshot = { sessionId, cwd, modelId: model, outcome: "failed" as const, active: "absent" as const,
      permissionCount: 0 as const, inboxIds: [] as [], latestUserMessageId: "native-old-input",
      latestUserInputId: oldReceipt.dispatchInputId!, latestTerminalEventId: "native-latest-terminal",
      terminalAt: new Date().toISOString(), snapshotToken: "d".repeat(64) };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["opencode", adapter]]), store, settingsStore: settings,
      fallbackModelsForHarness: async () => [model],
      humanRequests: new HumanRequestRegistry(join(root, "human-requests.json")),
      humanStopStore: new HumanStopStore(join(root, "human-stops.json")),
      admissionGate: async () => ({ allowed: true }),
      operatorContinuationSnapshotReader: async () => snapshot,
      projectLaunchPolicyStore: await (async () => {
        const policy = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
        await policy.replace({ version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode",
          models: { opencode: model }, fallbackModels: { opencode: [model] },
          projectRoutes: { [cwd]: { harnesses: ["opencode"] } },
        });
        return policy;
      })(),
    });
    const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { throw new Error("unused"); } }, undefined,
      { unfinishedSessions: launcher });
    const server = createWebServer({ adapters: new Map([["opencode", adapter]]), converter: { async convert() { throw new Error("unused"); } },
      sessionAutostartStore: settings, automationLaunchPolicyStore: new AutomationLaunchPolicyStore(join(root, "launch-policy.json")), supervisor });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/api/quota-recovery/operator-cohort/enroll`;
    const enrollment = (authorizationId: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "new_operator_continuation", authorizationId, entries: [{ sessionId, cwd,
        priorAccepted: { dispatchInputId: oldReceipt.dispatchInputId, nativeInputMessageId: "native-old-input" } }] }) });

    const response = await enrollment("operator-new-continuation-api-01");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ intent: "new_operator_continuation", enrolled: 1,
      results: [{ outcome: "enrolled", wait: { origin: "operator_cohort", state: "waiting" } }] });
    expect((await settings.getEffective("opencode", sessionId, cwd)).waitForQuota).toBe(false);
    await launcher.recoverPending();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ model, inputId: expect.stringMatching(/^herder-quota:/u) });
    expect(sends[0]?.inputId).not.toBe(oldReceipt.dispatchInputId);
    const acceptedContinuation = (await store.list())[0]!.quotaRecovery!;
    expect(acceptedContinuation.state).toBe("accepted");
    expect((await store.list())[0]?.quotaRecoveryHistory?.[0]?.quotaRecovery).toEqual(oldReceipt);

    const reset = await enrollment("operator-new-continuation-api-02");
    expect(reset.status).toBe(207);
    await expect(reset.json()).resolves.toMatchObject({ enrolled: 0,
      results: [{ outcome: "ineligible", reason: "prior_accepted_or_unknown_receipt_mismatch" }] });
    expect(sends).toHaveLength(1);
    expect((await store.list())[0]?.quotaRecovery).toEqual(acceptedContinuation);
    current = { ...current, status: "error" };
  });
});
