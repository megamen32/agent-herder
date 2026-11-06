import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession } from "../src/types/index.js";

it("Codex 429 recovery is durable, idempotent and bounded across successive native turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-429-recovery-"));
  try {
    const store = new UnfinishedSessionStore(join(directory, "unfinished.json"));
    const session = { id: "codex-session-429", harness: "codex", cwd: directory,
      title: "Codex 429", model: "gpt-6.1-terra", status: "idle",
      needsPermission: false } as AgentSession;
    const event = (n: number) => ({
      classification: "retry_limited" as const, providerId: "codex",
      modelId: "gpt-6.1-terra", nativeTurnId: `turn-${n}`, inputId: `input-${n}`,
    });
    for (const n of [1, 2]) {
      const now = new Date(Date.now() - 120_000);
      const record = await store.markQuotaRecoveryEligible(session, event(n), [], "429-test", now);
      expect(record.quotaRecovery).toMatchObject({
        state: "waiting", candidateModels: ["gpt-6.1-terra"], attempts: n - 1,
      });
      const claim = await store.claimQuotaRecoveryAttempt(record, "gpt-6.1-terra");
      expect(claim?.quotaRecovery?.attempts).toBe(n);
      const duplicate = await store.claimQuotaRecoveryAttempt(record, "gpt-6.1-terra");
      expect(duplicate).toBeNull();
      expect((await store.settleQuotaRecoveryAttempt(claim!, "accepted"))?.quotaRecovery?.state).toBe("accepted");
    }
    const terminal = await store.markQuotaRecoveryEligible(session, event(3), [], "429-test");
    expect(terminal.state).toBe("exhausted");
    expect(terminal.quotaRecovery).toMatchObject({
      state: "held", reasonCode: "candidate_exhausted", attempts: 2,
    });
    expect(terminal.nextAttemptAt).toBeUndefined();
    expect(await store.claimQuotaRecoveryAttempt(terminal, "gpt-6.1-terra")).toBeNull();
    const same = await store.markQuotaRecoveryEligible(session, event(3), [], "429-test");
    expect(same.quotaRecovery?.revision).toBe(terminal.quotaRecovery?.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
