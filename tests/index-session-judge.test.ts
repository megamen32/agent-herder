import { describe, expect, it, vi } from "vitest";

import { mkdtemp, writeFile } from "node:fs/promises";
import { createDynamicSessionCompletionJudge, readCredentialFile } from "../src/index.js";
import type { SessionCompletionJudge } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession } from "../src/types/index.js";

describe("production dynamic unfinished-session judge", () => {
  it("loads a credential from an operator-selected file", async () => {
    const root = await mkdtemp("/tmp/agent-herder-credential-");
    const path = `${root}/token`;
    await writeFile(path, "secret-from-file\n", { mode: 0o600 });
    await expect(readCredentialFile(path)).resolves.toBe("secret-from-file");
  });
  it("forwards decide, plan, and compact reconciliation to the selected client", async () => {
    const decide = vi.fn(async () => ({ verdict: "completed" as const, reason: "done", confidence: 1 }));
    const plan = vi.fn(async () => ({ groups: [] }));
    const reconcile = vi.fn(async () => ({ clusters: [["G1"]] }));
    const client: SessionCompletionJudge = { decide, plan, reconcile };
    const getClient = vi.fn(async () => client);
    const judge = createDynamicSessionCompletionJudge(getClient);
    const session: AgentSession = {
      id: "session-1", harness: "codex", status: "idle", title: "Task", cwd: "/workspace",
      lastActivity: "2026-10-05T00:00:00.000Z", needsPermission: false,
    };

    await expect(judge.decide({ session, transcriptTail: "evidence" })).resolves.toMatchObject({ verdict: "completed" });
    await expect(judge.plan?.({ sessions: [{ session, transcriptTail: "evidence" }] })).resolves.toEqual({ groups: [] });
    const groups = [{
      groupRef: "G1", workspaceIdentity: "/workspace", topic: "Task", verdict: "unfinished" as const,
      reason: "continue", handoff: "next", sourceSessionIds: ["codex:session-1:/workspace"],
      memberTitles: ["Task"], humanGate: false,
    }];
    await expect(judge.reconcile?.({ groups })).resolves.toEqual({ clusters: [["G1"]] });

    expect(getClient).toHaveBeenCalledTimes(3);
    expect(decide).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({ groups });
  });
});
