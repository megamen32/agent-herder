import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import * as policyModule from "../src/autopilot/policy.js";
import {
  DEFAULT_AUTOPILOT_DELAY_MS,
  createDefaultAutopilotPolicy,
  effectivePolicyAllowsTarget,
  effectivePolicyAllowsSelector,
  normalizeAutopilotPolicy,
  normalizeCodexSelector,
  resolveEffectivePolicy,
  type AutopilotPolicy,
  type CodexSelector,
  type EffectivePolicy,
} from "../src/autopilot/policy.js";
import {
  AutopilotPolicyRevisionConflictError,
  AutopilotPolicyStore,
} from "../src/autopilot/policy-store.js";

function enabledPolicy(): AutopilotPolicy {
  return {
    ...createDefaultAutopilotPolicy(),
    enabled: true,
    scope: {
      mode: "allowlist",
      selectors: [
        {
          harness: "codex",
          sessionId: "session-1",
          conversationId: "session-1",
          cwd: "/workspace",
          ingressId: "codex-stop-hook-v1",
        },
      ],
    },
  };
}

function selector(sessionId: string, cwd = "/workspace/project"): CodexSelector {
  return {
    harness: "codex",
    sessionId,
    conversationId: sessionId,
    cwd,
    ingressId: "codex-stop-hook-v1",
  };
}

function effectiveAllows(policy: EffectivePolicy, target: CodexSelector): boolean {
  return effectivePolicyAllowsSelector(policy, target);
}

function selectorFromStopSession(sessionId: string, cwd: string): CodexSelector {
  const factory = (policyModule as typeof policyModule & {
    createCodexSelectorFromStopSession: (input: { sessionId: string; cwd: string }) => CodexSelector;
  }).createCodexSelectorFromStopSession;
  return factory({ sessionId, cwd });
}

describe("autopilot policy foundation", () => {
  it("is default-off with the visible 30-minute timeout", () => {
    const policy = createDefaultAutopilotPolicy();

    expect(policy.enabled).toBe(false);
    expect(policy.harnesses).toEqual(["codex", "opencode", "claude", "hermes", "zcode"]);
    expect(policy.timeout).toEqual({ mode: "auto_continue", delayMs: DEFAULT_AUTOPILOT_DELAY_MS });
    expect(policy.card).toEqual({
      includeUserMessage: true,
      includeAssistantMessage: true,
      includeReason: true,
    });
    expect(resolveEffectivePolicy({ env: {} })).toMatchObject({
      source: "default",
      policy: { enabled: false },
      coverage: "none",
    });
  });

  it("authorizes configured harnesses while retaining the Codex allowlist contract", () => {
    const effective = resolveEffectivePolicy({
      state: {
        schemaVersion: 1,
        revision: "r-harnesses",
        updatedAt: new Date().toISOString(),
        policy: {
          ...createDefaultAutopilotPolicy(),
          enabled: true,
          harnesses: ["claude", "hermes"],
        },
      },
    });

    expect(effectivePolicyAllowsTarget(effective, { harness: "claude", sessionId: "claude-1", cwd: "/workspace" })).toBe(true);
    expect(effectivePolicyAllowsTarget(effective, { harness: "hermes", sessionId: "hermes-1", cwd: "/workspace" })).toBe(true);
    expect(effectivePolicyAllowsTarget(effective, { harness: "opencode", sessionId: "open-1", cwd: "/workspace" })).toBe(false);
  });

  it("migrates schema-v1 Codex-only policies that predate harness selection", () => {
    const legacyShape = { ...createDefaultAutopilotPolicy() } as Record<string, unknown>;
    delete legacyShape.harnesses;
    expect(normalizeAutopilotPolicy(legacyShape).harnesses).toEqual(["codex"]);
  });

  it("strictly parses and canonicalizes Codex selectors", () => {
    const selector = normalizeCodexSelector({
      harness: "codex",
      sessionId: "  session-1 ",
      conversationId: " session-1 ",
      cwd: "/workspace/project/../project/",
      ingressId: "codex-stop-hook-v1",
    });

    expect(selector).toEqual({
      harness: "codex",
      sessionId: "session-1",
      conversationId: "session-1",
      cwd: normalize("/workspace/project"),
      ingressId: "codex-stop-hook-v1",
    });
    expect(() => normalizeAutopilotPolicy({
      ...createDefaultAutopilotPolicy(),
      unexpected: true,
    })).toThrow("unknown policy field");
    expect(() => normalizeCodexSelector({
      harness: "opencode",
      sessionId: "session-1",
      cwd: "/workspace",
      ingressId: "codex-stop-hook-v1",
    })).toThrow("Codex selectors");
  });

  it("rejects a persisted selector without its explicit conversation identity", () => {
    expect(() => normalizeCodexSelector({
      harness: "codex",
      sessionId: "session-1",
      cwd: "/workspace",
      ingressId: "codex-stop-hook-v1",
    })).toThrow("conversationId");
  });

  it("rejects a persisted selector whose conversation identity differs from its Stop session", () => {
    expect(() => normalizeCodexSelector({
      harness: "codex",
      sessionId: "session-1",
      conversationId: "different-session",
      cwd: "/workspace",
      ingressId: "codex-stop-hook-v1",
    })).toThrow("must equal selector.sessionId");
  });

  it("derives a canonical v1 conversation identity from the Codex Stop session", () => {
    expect(selectorFromStopSession("session-1", "/workspace/project")).toEqual({
      harness: "codex",
      sessionId: "session-1",
      conversationId: "session-1",
      cwd: "/workspace/project",
      ingressId: "codex-stop-hook-v1",
    });
  });

  it("lets persisted policy win over conflicting legacy environment", () => {
    const resolved = resolveEffectivePolicy({
      state: { schemaVersion: 1, revision: "r1", policy: enabledPolicy(), updatedAt: "2026-08-11T00:00:00.000Z" },
      env: {
        AGENT_HERDER_AUTOPILOT_ALL_SESSIONS: "1",
      },
    });

    expect(resolved.source).toBe("persisted");
    expect(resolved.policy.scope).toEqual(enabledPolicy().scope);
    expect(resolved.legacyConflict).toContain("ignored");
  });

  it("uses explicit legacy arming only when persisted policy is absent", () => {
    const resolved = resolveEffectivePolicy({
      env: {
        AGENT_HERDER_AUTOPILOT_SESSION_ID: " session-1, session-2 ",
      },
    });

    expect(resolved).toMatchObject({
      source: "legacy",
      policy: {
        enabled: true,
        scope: {
          mode: "allowlist",
          selectors: [
            { sessionId: "session-1" },
            { sessionId: "session-2" },
          ],
        },
      },
      coverage: "codex-selected-sessions",
    });
  });

  it("matches an inline legacy session ID at its real non-root CWD only", () => {
    const resolved = resolveEffectivePolicy({
      env: { AGENT_HERDER_AUTOPILOT_SESSION_ID: "inline-session" },
    });

    expect(effectiveAllows(resolved, selector("inline-session"))).toBe(true);
    expect(effectiveAllows(resolved, selector("another-session"))).toBe(false);
  });

  it("matches a supplied arm-file session ID at its real non-root CWD only", () => {
    const resolved = resolveEffectivePolicy({
      env: {},
      legacySessionIds: new Set(["arm-file-session"]),
    });

    expect(effectiveAllows(resolved, selector("arm-file-session", "/srv/agent-herder"))).toBe(true);
    expect(effectiveAllows(resolved, selector("another-session", "/srv/agent-herder"))).toBe(false);
  });

  it("persists a versioned snapshot and rejects stale revisions atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-"));
    const path = join(root, "autopilot-policy.json");
    const store = new AutopilotPolicyStore(path);
    const first = await store.replacePolicy(enabledPolicy(), null);
    const second = await store.replacePolicy({ ...enabledPolicy(), enabled: false }, first.revision);

    expect(second.revision).not.toBe(first.revision);
    await expect(store.replacePolicy(enabledPolicy(), first.revision)).rejects.toBeInstanceOf(
      AutopilotPolicyRevisionConflictError,
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      revision: second.revision,
      policy: { schemaVersion: 1, enabled: false },
    });
  });

  it("serializes competing absent-state writes across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-cas-"));
    const path = join(root, "autopilot-policy.json");
    const first = new AutopilotPolicyStore(path);
    const second = new AutopilotPolicyStore(path);
    const results = await Promise.allSettled([
      first.replacePolicy(enabledPolicy(), null),
      second.replacePolicy(enabledPolicy(), null),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      AutopilotPolicyRevisionConflictError,
    );
  });

  it("syncs the renamed policy parent directory before reporting a successful save", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-directory-sync-"));
    const path = join(root, "autopilot-policy.json");
    let snapshotAtDirectorySync = "";
    const store = new AutopilotPolicyStore(path, {
      syncParentDirectory: async (directory) => {
        snapshotAtDirectorySync = await readFile(join(directory, "autopilot-policy.json"), "utf8");
      },
    });

    await store.replacePolicy(enabledPolicy(), null);

    expect(snapshotAtDirectorySync).toContain('"schemaVersion": 1');
  });

  it("reports an applied-but-durability-uncertain outcome when parent directory sync fails after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-directory-sync-failure-"));
    const path = join(root, "autopilot-policy.json");
    const directorySyncFailure = new Error("directory sync failed");
    const store = new AutopilotPolicyStore(path, {
      async syncParentDirectory() { throw directorySyncFailure; },
    });

    const result = await store.replacePolicy(enabledPolicy(), null);

    expect(result).toMatchObject({
      writeStatus: "durability_uncertain_applied",
      writtenRevision: expect.any(String),
      durabilityError: "directory sync failed",
      readBack: {
        source: "persisted",
        policy: { enabled: true },
      },
    });
    if (result.writeStatus !== "durability_uncertain_applied") throw new Error("expected durability-uncertain result");
    expect(result.readBack.revision).toBe(result.writtenRevision);
    expect(await store.readEffective()).toMatchObject({
      source: "persisted",
      revision: result.writtenRevision,
      policy: { enabled: true },
    });
  });

  it("fails closed for corrupt or truncated persisted state without legacy fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-corrupt-"));
    const path = join(root, "autopilot-policy.json");
    await writeFile(path, '{"schemaVersion": 1, "policy":', "utf8");
    const effective = await new AutopilotPolicyStore(path).readEffective({
      AGENT_HERDER_AUTOPILOT_ALL_SESSIONS: "1",
    });

    expect(effective).toMatchObject({
      source: "error",
      policy: { enabled: false },
      coverage: "none",
    });
    expect(effective.error).toBeTruthy();
  });
});
