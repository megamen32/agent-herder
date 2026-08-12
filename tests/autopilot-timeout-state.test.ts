import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";

async function makeRegistry(): Promise<ChoiceRegistry> {
  return new ChoiceRegistry(join(await mkdtemp(join(tmpdir(), "agent-herder-timeout-")), "choices.json"));
}

async function makeRegistryPair(): Promise<[ChoiceRegistry, ChoiceRegistry, ChoiceRegistry]> {
  const path = join(await mkdtemp(join(tmpdir(), "agent-herder-timeout-shared-")), "choices.json");
  return [new ChoiceRegistry(path), new ChoiceRegistry(path), new ChoiceRegistry(path)];
}

function choiceInput(expiresAt: string) {
  return {
    sessionId: "codex-session-timeout",
    turnId: "turn-timeout",
    cwd: "/workspace",
    choices: [
      { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect the saved target." },
      { choiceId: "verify", label: "Verify", nextGoal: "Verify the saved target." },
    ],
    timeoutChoiceId: "inspect",
    expiresAt,
    policyRevision: "policy-rev-1",
    maxContinuationsPerSession: 3,
  };
}

describe("durable autopilot timeout state", () => {
  it("acknowledges one timeout claim and dispatch across independent registry instances", async () => {
    const [seed, firstRegistry, secondRegistry] = await makeRegistryPair();
    const now = new Date("2026-08-11T08:00:00.000Z");
    const created = await seed.create(choiceInput("2026-08-11T07:59:59.999Z"));

    const claimResults = await Promise.all([firstRegistry.claimExpired(now), secondRegistry.claimExpired(now)]);
    const claims = claimResults.flat();
    expect(claims).toHaveLength(1);
    const winner = claims[0]!;
    const durableWinner = await seed.get(created.requestId);
    expect(durableWinner).toMatchObject({
      status: "claimed",
      claimToken: winner.claimToken,
      leaseExpiresAt: winner.leaseExpiresAt,
      idempotencyKey: winner.idempotencyKey,
    });

    const dispatchResults = await Promise.all([
      firstRegistry.markDispatching(created.requestId, winner.claimToken!, now),
      secondRegistry.markDispatching(created.requestId, winner.claimToken!, now),
    ]);
    expect(dispatchResults.filter((result) => result !== null)).toHaveLength(1);
    await expect(seed.get(created.requestId)).resolves.toMatchObject({
      status: "dispatching",
      claimToken: winner.claimToken,
    });
  });

  it("fails closed when an independent process holds the timeout registry lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-timeout-lock-"));
    const path = join(root, "choices.json");
    const registry = new ChoiceRegistry(path);
    const created = await registry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const lockTarget = `${path}.lock`;
    await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
    try {
      await expect(registry.claimExpired(new Date("2026-08-11T08:00:00.000Z"))).rejects.toMatchObject({
        code: "AUTOPILOT_CHOICE_LOCK_UNAVAILABLE",
        message: expect.stringContaining("requires human action"),
      });
      await expect(registry.get(created.requestId)).resolves.toMatchObject({ status: "pending" });
    } finally {
      await release();
    }
  });

  it("claims an expired candidate once with a stable token and lease", async () => {
    const registry = await makeRegistry();
    const now = new Date("2026-08-11T08:00:00.000Z");
    const created = await registry.create(choiceInput(new Date(now.getTime() - 1).toISOString()));

    const [first, second] = await Promise.all([registry.claimExpired(now), registry.claimExpired(now)]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(first[0]).toMatchObject({
      requestId: created.requestId,
      status: "claimed",
      choiceId: "inspect",
      nextGoal: "Inspect the saved target.",
      claimToken: expect.any(String),
      leaseExpiresAt: expect.any(String),
      idempotencyKey: `${created.requestId}:inspect`,
    });

    const saved = await registry.get(created.requestId);
    expect(saved?.claimToken).toBe(first[0]?.claimToken);
    expect(saved?.leaseExpiresAt).toBe(first[0]?.leaseExpiresAt);
    expect(await registry.claimExpired(new Date(saved!.leaseExpiresAt!))).toEqual([]);
  });

  it("persists dispatching before terminal outcomes", async () => {
    const resumedRegistry = await makeRegistry();
    const resumed = await resumedRegistry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const [claimed] = await resumedRegistry.claimExpired(new Date("2026-08-11T08:00:00.000Z"));
    const intent = await resumedRegistry.markDispatching(resumed.requestId, claimed!.claimToken!, new Date("2026-08-11T08:00:00.000Z"));
    expect(intent).toMatchObject({ status: "dispatching", claimToken: claimed!.claimToken });
    await expect(resumedRegistry.markResumed(resumed.requestId, claimed!.claimToken!)).resolves.toMatchObject({ status: "resumed" });
    await expect(resumedRegistry.markDispatching(resumed.requestId, claimed!.claimToken!)).resolves.toBeNull();

    const failedRegistry = await makeRegistry();
    const failed = await failedRegistry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const [failedClaim] = await failedRegistry.claimExpired(new Date("2026-08-11T08:00:00.000Z"));
    await failedRegistry.markDispatching(failed.requestId, failedClaim!.claimToken!, new Date("2026-08-11T08:00:00.000Z"));
    await expect(failedRegistry.markFailed(failed.requestId, failedClaim!.claimToken!, "consumer rejected")).resolves.toMatchObject({
      status: "failed",
      failureReason: "consumer rejected",
    });
  });

  it("keeps a manual claim while expiring a timeout-owned claimed lease", async () => {
    const registry = await makeRegistry();
    const now = new Date("2026-08-11T08:00:00.000Z");
    const manual = await registry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const timeout = await registry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    await registry.claimForResume(manual.requestId, "verify");

    const [timeoutClaim] = await registry.claimExpired(now);
    expect(timeoutClaim).toMatchObject({ requestId: timeout.requestId, status: "claimed" });

    await registry.claimExpired(new Date(new Date(timeoutClaim!.leaseExpiresAt!).getTime() + 1));
    const savedManual = await registry.get(manual.requestId);
    expect(savedManual).toMatchObject({
      status: "claimed",
      choiceId: "verify",
      nextGoal: "Verify the saved target.",
    });
    expect(savedManual?.claimToken).toBeUndefined();
    expect(savedManual?.leaseExpiresAt).toBeUndefined();
    await expect(registry.markResumed(manual.requestId, "verify")).resolves.toMatchObject({ status: "resumed" });
    await expect(registry.get(timeout.requestId)).resolves.toMatchObject({
      status: "expired-needs-human",
      failureReason: "claim lease expired before dispatch",
    });
  });

  it("fails closed when a timeout claim crashes before dispatch", async () => {
    const registry = await makeRegistry();
    const created = await registry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const [claimed] = await registry.claimExpired(new Date("2026-08-11T08:00:00.000Z"));

    const leaseEnd = new Date(claimed!.leaseExpiresAt!);
    expect(await registry.claimExpired(new Date(leaseEnd.getTime() + 1))).toEqual([]);
    await expect(registry.get(created.requestId)).resolves.toMatchObject({
      status: "expired-needs-human",
      failureReason: "claim lease expired before dispatch",
    });
    await expect(registry.claimExpired(new Date(leaseEnd.getTime() + 60_000))).resolves.toEqual([]);
  });

  it("does not retry ambiguous dispatching after its lease expires", async () => {
    const registry = await makeRegistry();
    const created = await registry.create(choiceInput("2026-08-11T07:59:59.999Z"));
    const [claimed] = await registry.claimExpired(new Date("2026-08-11T08:00:00.000Z"));
    await registry.markDispatching(created.requestId, claimed!.claimToken!, new Date("2026-08-11T08:00:00.000Z"));

    const leaseEnd = new Date(claimed!.leaseExpiresAt!);
    const sweep = await registry.claimExpired(new Date(leaseEnd.getTime() + 1));
    expect(sweep).toEqual([]);
    await expect(registry.get(created.requestId)).resolves.toMatchObject({
      status: "expired-needs-human",
      failureReason: "dispatch lease expired without an acknowledged outcome",
    });
    await expect(registry.claimExpired(new Date(leaseEnd.getTime() + 60_000))).resolves.toEqual([]);
  });

  it("treats normalized CWD aliases as one durable timeout budget", async () => {
    const registry = await makeRegistry();
    const now = new Date("2026-08-11T08:00:00.000Z");
    const first = await registry.create({
      ...choiceInput("2026-08-11T07:59:59.999Z"),
      cwd: "/workspace/app",
      maxContinuationsPerSession: 1,
    });
    const second = await registry.create({
      ...choiceInput("2026-08-11T07:59:59.999Z"),
      turnId: "turn-timeout-alias",
      cwd: "/workspace/other/../app",
      maxContinuationsPerSession: 1,
    });

    await expect(registry.claimExpired(now)).resolves.toMatchObject([
      { requestId: first.requestId, status: "claimed" },
      { requestId: second.requestId, status: "expired-needs-human", failureReason: "Timeout continuation budget is exhausted" },
    ]);
  });
});
