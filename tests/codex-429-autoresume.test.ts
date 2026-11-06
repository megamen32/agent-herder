import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore }
  from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession } from "../src/types/index.js";

it("after a confirmed terminal Codex 429, wakes the same session once and never replays its user input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-429-autoresume-"));
  try {
    const evidence = {
      classification: "retry_limited" as const, nativeTurnId: "native-failed-turn",
      inputId: "original-user-item", providerId: "codex", modelId: "gpt-6.1-terra",
    };
    const session = {
      id: "original-codex-thread", harness: "codex" as const, cwd, model: "gpt-6.1-terra",
      title: "Original", status: "idle" as const, needsPermission: false,
      meta: { nativeLastTurn: {
        turnId: evidence.nativeTurnId, inputId: evidence.inputId,
        userMessageId: evidence.inputId, status: "failed",
        completedAt: new Date(Date.now() - 65_000).toISOString(),
        quotaFailure: evidence,
      } },
    } as AgentSession;
    const sent: Array<{id:string; message:string; inputId?:string; model?:string}> = [];
    const adapter = {
      type:"codex", name:"fake Codex",
      getSession: async (id:string) => id===session.id ? session : null,
      listSessions: async () => [session],
      listModels: async () => ["gpt-6.1-terra"],
      changeModel: async () => ({ok:true}),
      sendMessage: async (id:string, args:any) => {
        sent.push({id, message:args.message, inputId:args.inputId, model:args.model});
        return {ok:true,admitted:true,turnId:"continuation-turn"};
      },
    };
    const store = new UnfinishedSessionStore(join(cwd,"unfinished.json"));
    const settings = new SessionAutostartStore(join(cwd,"autostart.json"));
    await settings.setGlobalWaitForQuota(true);
    await store.markQuotaRecoveryEligible(session, evidence, [], "test",
      new Date(Date.now() - 90_000));
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex",adapter as any]]), store, settingsStore:settings,
      probeRecoveryQuota:async () => ({state:"available" as const,source:"provider" as const,checkedAt:new Date().toISOString()}),
    });
    await launcher.recoverPending();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(session.id);
    expect(sent[0]?.model).toBe(session.model);
    expect(sent[0]?.inputId).not.toBe(evidence.inputId);
    expect(sent[0]?.message).not.toContain("original-user-item");
    expect((await store.list())[0]?.quotaRecovery?.state).toBe("accepted");
    await launcher.recoverPending();
    expect(sent).toHaveLength(1);
  } finally {
    await rm(cwd,{recursive:true,force:true});
  }
});
