import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegratorSessionBindingStore,
  type IntegratorLaunchReceipt,
} from "../src/integrator-session-binding.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-integrator-binding-"));
  roots.push(root);
  const path = join(root, "bindings.json");
  return { root, path, store: new IntegratorSessionBindingStore({ persistencePath: path }) };
}

function receipt(inputId: string, state: IntegratorLaunchReceipt["state"], extra: Partial<IntegratorLaunchReceipt> = {}): IntegratorLaunchReceipt {
  return { state, inputId, retryable: false, ...extra };
}

function operationInputId(operationId: string, attempt: number): string {
  return createHash("sha256").update(JSON.stringify(["integrator-session-binding", operationId, attempt])).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("integrator session binding store", () => {
  it("persists intent/checkpoint and recovers an unknown attempt without permitting a second launch", async () => {
    const f = await fixture();
    const reserved = await f.store.reserve({ operationId: "task-op-1", hostId: "server-100", harness: "codex" });
    expect(reserved.claimed).toBe(true);
    expect(reserved.binding.attempts[0]?.inputId).toMatch(/^[a-f0-9]{64}$/);

    await f.store.checkpoint({ operationId: "task-op-1", attempt: 1, checkpoint: { sequence: 1, cursor: "created-request" } });
    await expect(f.store.checkpoint({ operationId: "task-op-1", attempt: 1, checkpoint: { sequence: 0, cursor: "older" } })).rejects.toThrow("checkpoint_regression");
    const unknown = await f.store.record({
      operationId: "task-op-1",
      attempt: 1,
      receipt: receipt(reserved.binding.attempts[0]!.inputId, "unknown", { reason: "launch response lost" }),
    });
    expect(unknown.state).toBe("unknown");
    expect(unknown.attempts[0]?.address).toBeUndefined();

    const restarted = new IntegratorSessionBindingStore({ persistencePath: f.path });
    const recovered = await restarted.get("task-op-1");
    expect(recovered).toEqual(unknown);
    const duplicate = await restarted.reserve({ operationId: "task-op-1", hostId: "server-100", harness: "codex" });
    expect(duplicate.claimed).toBe(false);
    expect(duplicate.binding.state).toBe("unknown");
  });

  it("serializes concurrent duplicate operations across store instances", async () => {
    const f = await fixture();
    const second = new IntegratorSessionBindingStore({ persistencePath: f.path });
    const results = await Promise.all([
      f.store.reserve({ operationId: "task-op-race", hostId: "server-100", harness: "opencode" }),
      second.reserve({ operationId: "task-op-race", hostId: "server-100", harness: "opencode" }),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results[0]?.binding.attempts).toHaveLength(1);
    expect(results[1]?.binding.attempts).toHaveLength(1);
  });

  it("binds an accepted native address immutably and rejects operation conflicts", async () => {
    const f = await fixture();
    const reserved = await f.store.reserve({ operationId: "task-op-accepted", hostId: "server-100", harness: "codex" });
    const address = { hostId: "server-100", harness: "codex", nativeSessionId: "native-session-42" };
    const accepted = await f.store.record({
      operationId: "task-op-accepted",
      attempt: 1,
      checkpoint: { sequence: 2, cursor: "thread-confirmed" },
      receipt: receipt(reserved.binding.attempts[0]!.inputId, "created", { address, launchCwd: "/project", reason: "native accepted" }),
    });
    expect(accepted).toMatchObject({ state: "accepted", harness: "codex", attempts: [{ hostId: "server-100", address, checkpoint: { sequence: 2, cursor: "thread-confirmed" } }] });
    const alternate = await f.store.reserve({ operationId: "task-op-accepted", hostId: "server-44", harness: "codex" });
    expect(alternate.claimed).toBe(false);
    expect(alternate.attempt.hostId).toBe("server-100");
    await expect(f.store.reserve({ operationId: "task-op-accepted", hostId: "server-44", harness: "opencode" })).rejects.toThrow("operation_conflict");
    await expect(f.store.record({
      operationId: "task-op-accepted",
      attempt: 1,
      receipt: receipt(reserved.binding.attempts[0]!.inputId, "created", { address: { ...address, nativeSessionId: "different-session" } }),
    })).rejects.toThrow("attempt_terminal");
    const pending = await f.store.reserve({ operationId: "task-op-host-conflict", hostId: "server-100", harness: "codex" });
    await expect(f.store.record({
      operationId: "task-op-host-conflict",
      attempt: 1,
      receipt: receipt(pending.binding.attempts[0]!.inputId, "unknown", { address: { hostId: "server-44", harness: "codex", nativeSessionId: "foreign-session" } }),
    })).rejects.toThrow("address_conflict");
  });

  it("accepts only matching owner reconciliation for uncertain launch and preserves the exact address", async () => {
    const f = await fixture();
    const reserved = await f.store.reserve({ operationId: "task-op-reconcile", hostId: "mac-mini", harness: "opencode" });
    const address = { hostId: "mac-mini", harness: "opencode", nativeSessionId: "session-exact" };
    await f.store.record({ operationId: "task-op-reconcile", attempt: 1, receipt: receipt(reserved.binding.attempts[0]!.inputId, "unknown") });
    const reconciled = await f.store.reconcile({
      operationId: "task-op-reconcile",
      attempt: 1,
      receipt: receipt(reserved.binding.attempts[0]!.inputId, "created", { address, launchCwd: "/project" }),
    });
    expect(reconciled).toMatchObject({ state: "accepted", attempts: [{ address, receipt: { state: "created", launchCwd: "/project" } }] });
    await expect(f.store.reconcile({
      operationId: "task-op-reconcile",
      attempt: 1,
      receipt: receipt(reserved.binding.attempts[0]!.inputId, "created", { address: { ...address, nativeSessionId: "session-other" } }),
    })).rejects.toThrow("uncertain_attempt_required");
  });

  it("rejects host or native-session rebinding when reconciling an uncertain receipt", async () => {
    const f = await fixture();
    const reserved = await f.store.reserve({ operationId: "task-op-address-conflict", hostId: "server-100", harness: "codex" });
    const inputId = reserved.binding.attempts[0]!.inputId;
    const original = { hostId: "server-100", harness: "codex", nativeSessionId: "session-original" };
    await f.store.record({ operationId: "task-op-address-conflict", attempt: 1, receipt: receipt(inputId, "unknown", { address: original }) });
    await expect(f.store.reconcile({
      operationId: "task-op-address-conflict",
      attempt: 1,
      receipt: receipt(inputId, "created", { address: { ...original, nativeSessionId: "session-replacement" } }),
    })).rejects.toThrow("session_conflict");
  });

  it("opens a new attempt only after a definite not-attempted receipt", async () => {
    const f = await fixture();
    const first = await f.store.reserve({ operationId: "task-op-retry", hostId: "server-100", harness: "codex" });
    await f.store.record({ operationId: "task-op-retry", attempt: 1, receipt: receipt(first.binding.attempts[0]!.inputId, "not_attempted", { retryable: true, reason: "native rejected before admission" }) });
    const second = await f.store.reserve({ operationId: "task-op-retry", hostId: "server-44", harness: "codex",
      expectedPriorAttempt: { attempt: first.attempt.attempt, inputId: first.attempt.inputId, hostId: first.attempt.hostId } });
    expect(second.claimed).toBe(true);
    expect(second.binding.attempts.map((attempt) => attempt.state)).toEqual(["not_attempted", "intent"]);
    expect(second.attempt.hostId).toBe("server-44");
    expect(second.binding.attempts[1]?.inputId).not.toBe(first.binding.attempts[0]?.inputId);
  });

  it("preserves one operation and old native IDs across a retryable refusal, restart, and concurrent host fallback", async () => {
    const f = await fixture();
    const operationId = "task-op-cross-host";
    const first = await f.store.reserve({ operationId, hostId: "server-100", harness: "codex" });
    const firstInputId = first.attempt.inputId;
    const refusal = receipt(firstInputId, "not_attempted", { retryable: true, reason: "native_create_unavailable" });
    const afterRefusal = await f.store.record({ operationId, attempt: 1, receipt: refusal });

    const restarted = new IntegratorSessionBindingStore({ persistencePath: f.path });
    const competing = new IntegratorSessionBindingStore({ persistencePath: f.path });
    const candidates = await Promise.all([
      restarted.reserve({ operationId, hostId: "server-44", harness: "codex",
        expectedPriorAttempt: { attempt: 1, inputId: firstInputId, hostId: "server-100" } }),
      competing.reserve({ operationId, hostId: "server-44", harness: "codex",
        expectedPriorAttempt: { attempt: 1, inputId: firstInputId, hostId: "server-100" } }),
    ]);
    expect(candidates.filter(candidate => candidate.claimed)).toHaveLength(1);
    const second = candidates.find(candidate => candidate.claimed)!;
    expect(second.attempt).toMatchObject({ attempt: 2, hostId: "server-44", state: "intent" });
    expect(second.attempt.inputId).not.toBe(firstInputId);
    expect(second.binding.attempts).toHaveLength(2);
    expect(second.binding.attempts[0]?.inputId).toBe(firstInputId);
    expect(second.binding.attempts[0]?.receipt).toEqual(refusal);
    expect(afterRefusal.attempts[0]?.receipt).toEqual(refusal);

    const blockedThirdHost = await restarted.reserve({ operationId, hostId: "server-88", harness: "codex" });
    expect(blockedThirdHost.claimed).toBe(false);
    expect(blockedThirdHost.attempt).toMatchObject({ attempt: 2, hostId: "server-44", state: "intent" });
    expect((await new IntegratorSessionBindingStore({ persistencePath: f.path }).get(operationId))?.attempts.map(a => a.inputId))
      .toEqual([firstInputId, second.attempt.inputId]);
  });

  it("does not allow a different host after UNKNOWN or accepted", async () => {
    const f = await fixture();
    const unknownOperation = await f.store.reserve({ operationId: "task-op-no-unknown-fallback", hostId: "server-100", harness: "codex" });
    await f.store.record({ operationId: "task-op-no-unknown-fallback", attempt: 1, receipt: receipt(unknownOperation.attempt.inputId, "unknown") });
    const afterUnknown = await f.store.reserve({ operationId: "task-op-no-unknown-fallback", hostId: "server-44", harness: "codex" });
    expect(afterUnknown.claimed).toBe(false);
    expect(afterUnknown.attempt.hostId).toBe("server-100");

    const acceptedOperation = await f.store.reserve({ operationId: "task-op-no-accepted-fallback", hostId: "server-100", harness: "codex" });
    await f.store.record({
      operationId: "task-op-no-accepted-fallback",
      attempt: 1,
      receipt: receipt(acceptedOperation.attempt.inputId, "created", {
        address: { hostId: "server-100", harness: "codex", nativeSessionId: "native-accepted" },
      }),
    });
    const afterAccepted = await f.store.reserve({ operationId: "task-op-no-accepted-fallback", hostId: "server-44", harness: "codex" });
    expect(afterAccepted.claimed).toBe(false);
    expect(afterAccepted.attempt.hostId).toBe("server-100");
  });

  it("migrates v1 host binding into each attempt without changing receipt or input IDs", async () => {
    const f = await fixture();
    const operationId = "task-op-legacy-host";
    const inputId = operationInputId(operationId, 1);
    const oldReceipt = receipt(inputId, "not_attempted", { retryable: true, reason: "native_create_unavailable" });
    await writeFile(f.path, JSON.stringify({
      version: 1,
      operations: {
        [operationId]: {
          operationId,
          hostId: "server-100",
          harness: "codex",
          state: "not_attempted",
          attempts: [{ attempt: 1, inputId, state: "not_attempted", startedAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:01:00.000Z", receipt: oldReceipt }],
        },
      },
    }), "utf8");

    const migrated = await new IntegratorSessionBindingStore({ persistencePath: f.path }).reserve({
      operationId, hostId: "server-44", harness: "codex",
      expectedPriorAttempt: { attempt: 1, inputId, hostId: "server-100" },
    });
    expect(migrated.claimed).toBe(true);
    expect(migrated.binding.attempts.map(attempt => attempt.hostId)).toEqual(["server-100", "server-44"]);
    expect(migrated.binding.attempts[0]?.inputId).toBe(inputId);
    expect(migrated.binding.attempts[0]?.receipt).toEqual(oldReceipt);
    expect(migrated.attempt.inputId).toBe(operationInputId(operationId, 2));
  });

  it("keeps owner lock contention unknown instead of opening a second native attempt", async () => {
    const f = await fixture();
    const first = await f.store.reserve({ operationId: "task-op-busy", hostId: "server-100", harness: "codex" });
    const busy = await f.store.record({
      operationId: "task-op-busy",
      attempt: 1,
      receipt: receipt(first.binding.attempts[0]!.inputId, "not_attempted", { retryable: true, reason: "fleet_create_busy" }),
    });
    expect(busy.state).toBe("unknown");
    const retry = await f.store.reserve({ operationId: "task-op-busy", hostId: "server-100", harness: "codex" });
    expect(retry.claimed).toBe(false);
    expect(retry.binding.attempts).toHaveLength(1);
  });

  it("fails closed on corrupt persisted state instead of treating it as an empty store", async () => {
    const f = await fixture();
    await f.store.reserve({ operationId: "task-op-corrupt", hostId: "server-100", harness: "codex" });
    await writeFile(f.path, "{broken", "utf8");
    await expect(new IntegratorSessionBindingStore({ persistencePath: f.path }).get("task-op-corrupt")).rejects.toThrow();
  });

  it("reads v2 rows as unscoped diagnostics without changing their native receipt or input ID", async () => {
    const f = await fixture();
    const operationId = "task-op-v2-legacy";
    const inputId = operationInputId(operationId, 1);
    const oldReceipt = receipt(inputId, "created", {
      address: { hostId: "server-100", harness: "codex", nativeSessionId: "legacy-native" },
    });
    await writeFile(f.path, JSON.stringify({
      version: 2,
      operations: {
        [operationId]: {
          operationId, harness: "codex", state: "accepted",
          attempts: [{ attempt: 1, inputId, hostId: "server-100", state: "accepted",
            startedAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:01:00.000Z",
            address: oldReceipt.address, receipt: oldReceipt }],
        },
      },
    }), "utf8");

    const legacy = await new IntegratorSessionBindingStore({ persistencePath: f.path }).get(operationId);
    expect(legacy?.attempts[0]?.scope).toBeUndefined();
    expect(legacy?.attempts[0]?.inputId).toBe(inputId);
    expect(legacy?.attempts[0]?.receipt).toEqual(oldReceipt);
  });
});
