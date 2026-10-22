import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession } from "../src/types/index.js";

/**
 * The quota recovery of a session may only continue on a route of the health
 * allowlist: the launcher must not be a way around it.
 */
function quotaSession(): AgentSession {
  const completedAt = Date.now() - 120_000;
  const evidence = {
    classification: "quota_exhausted",
    nativeTurnId: "native-failed-1",
    inputId: "native-input-1",
    providerId: "omniroute",
    modelId: "openai/current",
    resetAt: new Date(Date.now() - 1_000).toISOString(),
  };
  return {
    id: "ses_quota",
    harness: "opencode",
    status: "error",
    title: "quota fixture",
    cwd: "/tmp/recovery",
    lastActivity: new Date(completedAt).toISOString(),
    needsPermission: false,
    messageCount: 2,
    model: "omniroute/openai/current",
    meta: { nativeLastTurn: { turnId: evidence.nativeTurnId, inputId: evidence.inputId, status: "error", completedAt, userMessageId: "user-input-1", quotaFailure: evidence } },
  } as unknown as AgentSession;
}

describe("the quota recovery candidates of the launcher", () => {
  it("keeps only the routes of the health allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-quota-allowlist-"));
    try {
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const record = await store.markQuotaRecoveryEligible(quotaSession(), {
        classification: "quota_exhausted",
        nativeTurnId: "native-failed-1",
        inputId: "native-input-1",
        providerId: "omniroute",
        modelId: "openai/current",
        resetAt: new Date(Date.now() - 1_000).toISOString(),
      }, [
        "anthropic/claude-sonnet",
        "openai/gpt-5",
        "zai-coding-plan/glm-5.3-flash",
        "omniroute/minimax-combo-m3.1",
        "minimax-coding-plan/MiniMax-M3.1-Flash",
      ]);

      // The routes of other providers are refused: only the gateway route and
      // the MiniMax subscription route of the allowlist stay.
      expect(record.quotaRecovery?.candidateModels).toEqual([
        "omniroute/minimax-combo-m3.1",
        "minimax-coding-plan/MiniMax-M3.1-Flash",
        "omniroute/openai/current",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("has no candidate at all when the policy names only foreign routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-quota-allowlist-empty-"));
    try {
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const record = await store.markQuotaRecoveryEligible(quotaSession(), {
        classification: "quota_exhausted",
        nativeTurnId: "native-failed-1",
        inputId: "native-input-1",
        providerId: "omniroute",
        modelId: "openai/current",
        resetAt: new Date(Date.now() - 1_000).toISOString(),
      }, ["anthropic/claude-sonnet", "openai/gpt-5"]);

      expect(record.quotaRecovery?.candidateModels).toEqual(["omniroute/openai/current"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
