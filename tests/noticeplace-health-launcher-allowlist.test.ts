import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * A record that the producer has just written must survive the next read of
 * the file: the validator of the read and the producer of the write have to
 * agree on the allowlist, or the recovery of the session is lost while the
 * record looks healthy in memory.
 */
describe("the quota recovery record through the file", () => {
  const evidence = () => ({
    classification: "quota_exhausted",
    nativeTurnId: "native-failed-1",
    inputId: "native-input-1",
    providerId: "omniroute",
    modelId: "openai/current",
    resetAt: new Date(Date.now() - 1_000).toISOString(),
  });

  it("keeps the subscription route of the live policy and claims the attempt again", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-quota-round-trip-"));
    try {
      const path = join(root, "unfinished.json");
      const store = new UnfinishedSessionStore(path);
      // The live policy of the owner names the paid subscription route.
      const written = await store.markQuotaRecoveryEligible(quotaSession(), evidence(), ["omniroute/minimax-combo-m3.1", "minimax-coding-plan/MiniMax-M3.1-Flash"]);
      expect(written.quotaRecovery?.candidateModels).toEqual([
        "omniroute/minimax-combo-m3.1",
        "minimax-coding-plan/MiniMax-M3.1-Flash",
        "omniroute/openai/current",
      ]);

      // A restart reads the record from the disk again.
      const reloaded = (await new UnfinishedSessionStore(path).list())[0];
      expect(reloaded?.quotaRecovery).toMatchObject({
        state: "waiting",
        candidateModels: ["omniroute/minimax-combo-m3.1", "minimax-coding-plan/MiniMax-M3.1-Flash", "omniroute/openai/current"],
      });

      // The claim of the attempt works on the reloaded record.
      const selected = reloaded!.quotaRecovery!.candidateModels[reloaded!.quotaRecovery!.candidateIndex]!;
      const claimed = await new UnfinishedSessionStore(path).claimQuotaRecoveryAttempt(reloaded!, selected, new Date(Date.now() + 60_000));
      expect(claimed?.quotaRecovery).toMatchObject({ state: "dispatching", selectedModel: selected });
      expect((await new UnfinishedSessionStore(path).list())[0]?.quotaRecovery?.state).toBe("dispatching");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a record with a route of another provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-quota-round-trip-foreign-"));
    try {
      const path = join(root, "unfinished.json");
      const store = new UnfinishedSessionStore(path);
      const written = await store.markQuotaRecoveryEligible(quotaSession(), evidence(), ["omniroute/minimax-combo-m3.1"]);
      // A record of a foreign provider is not a record of the allowlist.
      await writeFile(path, JSON.stringify({
        version: 1,
        sessions: [{ ...written, quotaRecovery: { ...written.quotaRecovery!, candidateModels: ["anthropic/claude-sonnet"] } }],
      }));

      const reloaded = (await new UnfinishedSessionStore(path).list())[0];
      expect(reloaded?.quotaRecovery).toBeUndefined();
      const claimed = await new UnfinishedSessionStore(path).claimQuotaRecoveryAttempt(reloaded!, "anthropic/claude-sonnet", new Date(Date.now() + 60_000));
      expect(claimed).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
