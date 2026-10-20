import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetCreateReceipt, FleetHost, FleetView } from "../src/mesh/fleet-contract.js";
import { admitBoundIntegratorSession } from "../src/integrator-session-admission.js";
import { IntegratorSessionBindingStore } from "../src/integrator-session-binding.js";
import {
  INTEGRATOR_HOST_MODEL,
  type IntegratorCreateCommand,
  type IntegratorHostPorts,
  type IntegratorHostRequest,
  type IntegratorHostReadiness,
  type HostPathResolution,
} from "../src/integrator-host-admission.js";
import type { ProjectExecutionBinding, TrustedRuntimeOwnerProof } from "../src/project-execution-scope.js";

const rootPaths: string[] = [];
const now = Date.now();
const request: IntegratorHostRequest = {
  projectId: "join-project", rootIdentity: "root:sha256:join", policyRevision: "policy-7",
  attemptId: "stable-operation-7", checkoutRoot: "/work/project", harness: "codex", harnessVersion: "1.2.3",
  requiredTools: ["read", "edit"], name: "Join test", cwd: "/work/project", inputId: "legacy-request-input",
  model: INTEGRATOR_HOST_MODEL,
};

function host(hostId: string): FleetHost {
  return { hostId, label: hostId, state: "ready", fetchedAt: now - 10, expiresAt: now + 60_000,
    generation: 1, createHarnesses: ["codex"] };
}

function readiness(hostId: string): IntegratorHostReadiness {
  const resolution: HostPathResolution = {
    pathFlavor: "posix", requestedCheckoutRoot: request.checkoutRoot, requestedCwd: request.cwd,
    canonicalCheckoutRoot: request.checkoutRoot, canonicalCwd: request.cwd, canonicalRootIdentity: request.rootIdentity,
    checkoutRootEquivalent: true, cwdEquivalent: true, cwdWithinCheckoutRoot: true,
  };
  return { host: host(hostId), observedAtMs: now, checkoutRoot: request.checkoutRoot, pathResolution: resolution,
    harness: request.harness, harnessVersion: request.harnessVersion, availableTools: ["read", "edit"],
    availableModels: [INTEGRATOR_HOST_MODEL], resourceReady: true, runtimeInstanceId: `runtime-${hostId}` };
}

function bindingFor(hostId: string): ProjectExecutionBinding {
  return { projectId: request.projectId, rootIdentity: request.rootIdentity, policyRevision: request.policyRevision,
    attemptId: request.attemptId, hostId, runtimeInstanceId: `runtime-${hostId}` };
}

function ownerProof(binding: ProjectExecutionBinding): TrustedRuntimeOwnerProof {
  return { kind: "trusted", binding, issuedAtMs: now - 10, expiresAtMs: now + 60_000 };
}

function view(hosts: FleetHost[]): FleetView { return { hosts, sessions: [], complete: true, limited: false }; }

function h33Ports(hosts: FleetHost[], create: (command: IntegratorCreateCommand) => Promise<FleetCreateReceipt>) {
  const admission = vi.fn(create);
  const ports: IntegratorHostPorts = {
    now: () => now,
    discovery: { snapshot: vi.fn(async () => view(hosts)) },
    readiness: { observe: vi.fn(async candidate => readiness(candidate.hostId)) },
    runtimeOwner: { resolve: vi.fn(async expected => ownerProof(expected)) },
    admission: { create: admission },
  };
  return { ports, admission };
}

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "herder-integrator-admission-"));
  rootPaths.push(path);
  const persistencePath = join(path, "bindings.json");
  return { persistencePath, store: new IntegratorSessionBindingStore({ persistencePath }) };
}

afterEach(async () => {
  await Promise.all(rootPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("H33 and H34 bound integrator admission", () => {
  it("records exact refusal before host fallback using durable per-attempt IDs under one operation", async () => {
    const f = await fixture();
    const nativeIds: string[] = [];
    const base = h33Ports([host("host-one"), host("host-two")], async command => {
      nativeIds.push(command.inputId);
      return command.hostId === "host-one"
        ? { state: "not_attempted", inputId: command.inputId, retryable: true, reason: "pre-admission-refusal" }
        : { state: "created", inputId: command.inputId, retryable: false,
          address: { hostId: command.hostId, harness: command.harness, nativeSessionId: "native-two" } };
    });

    const result = await admitBoundIntegratorSession({ request, store: f.store, ports: base.ports });
    const saved = await f.store.get(request.attemptId);
    expect(result.state).toBe("accepted");
    expect(result).toMatchObject({ address: { hostId: "host-two", nativeSessionId: "native-two" } });
    expect(base.admission.mock.calls.map(([command]) => [command.hostId, command.attemptId, command.inputId])).toEqual([
      ["host-one", request.attemptId, saved!.attempts[0]!.inputId],
      ["host-two", request.attemptId, saved!.attempts[1]!.inputId],
    ]);
    expect(saved?.attempts.map(attempt => attempt.hostId)).toEqual(["host-one", "host-two"]);
    expect(saved?.attempts.map(attempt => attempt.receipt?.inputId)).toEqual(nativeIds);
    expect(saved?.attempts[0]?.receipt).toEqual({ state: "not_attempted", inputId: nativeIds[0], retryable: true, reason: "pre-admission-refusal" });
    expect(saved?.attempts[1]?.receipt).toMatchObject({ state: "created", inputId: nativeIds[1], address: { hostId: "host-two" } });
    expect(nativeIds).not.toContain(request.inputId);
  });

  it("after restart does not recreate accepted or unknown operations and preserves unknown-without-ID", async () => {
    const f = await fixture();
    const acceptedAttempt = await f.store.reserve({ operationId: "accepted-op", hostId: "host-one", harness: "codex" });
    await f.store.record({ operationId: "accepted-op", attempt: 1, receipt: {
      state: "created", inputId: acceptedAttempt.attempt.inputId, retryable: false,
      address: { hostId: "host-one", harness: "codex", nativeSessionId: "existing-native" },
    } });
    const unknownAttempt = await f.store.reserve({ operationId: "unknown-op", hostId: "host-two", harness: "codex" });
    await f.store.record({ operationId: "unknown-op", attempt: 1, receipt: {
      state: "unknown", inputId: unknownAttempt.attempt.inputId, retryable: false, reason: "response-lost",
    } });
    const create = vi.fn(async (): Promise<FleetCreateReceipt> => { throw new Error("must not create"); });
    const h33 = h33Ports([host("host-one"), host("host-two")], create);

    const accepted = await admitBoundIntegratorSession({ request: { ...request, attemptId: "accepted-op" }, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: h33.ports });
    const unknown = await admitBoundIntegratorSession({ request: { ...request, attemptId: "unknown-op" }, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: h33.ports });
    expect(accepted).toMatchObject({ state: "accepted", address: { nativeSessionId: "existing-native" } });
    expect(unknown).toMatchObject({ state: "unknown", reason: "attempt_outcome_unknown", binding: { state: "unknown" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("concurrent callers claim at most one native create across store instances", async () => {
    const f = await fixture();
    const firstStore = new IntegratorSessionBindingStore({ persistencePath: f.persistencePath });
    const secondStore = new IntegratorSessionBindingStore({ persistencePath: f.persistencePath });
    let releaseCreate!: (receipt: FleetCreateReceipt) => void;
    const createGate = new Promise<FleetCreateReceipt>(resolve => { releaseCreate = resolve; });
    const create = vi.fn(async (command: IntegratorCreateCommand) => createGate.then(receipt => ({ ...receipt, inputId: command.inputId })));
    const h33 = h33Ports([host("host-one")], create);

    const first = admitBoundIntegratorSession({ request, store: firstStore, ports: h33.ports });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const second = await admitBoundIntegratorSession({ request, store: secondStore, ports: h33.ports });
    expect(second).toMatchObject({ state: "unknown", binding: { state: "intent" } });
    expect(create).toHaveBeenCalledTimes(1);
    releaseCreate({ state: "unknown", inputId: "placeholder", retryable: false, reason: "response-lost" });
    const firstResult = await first;
    expect(firstResult).toMatchObject({ state: "unknown", binding: { state: "unknown" } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale host snapshot after another caller records that host's retryable refusal", async () => {
    const f = await fixture();
    const seed = await f.store.reserve({ operationId: request.attemptId, hostId: "host-a", harness: "codex" });
    await f.store.record({ operationId: request.attemptId, attempt: 1, receipt: {
      state: "not_attempted", inputId: seed.attempt.inputId, retryable: true, reason: "host-a-refused",
    } });

    let snapshotReady!: () => void;
    let unblockSnapshot!: (value: FleetView) => void;
    const reachedSnapshot = new Promise<void>(resolve => { snapshotReady = resolve; });
    const staleSnapshot = new Promise<FleetView>(resolve => { unblockSnapshot = resolve; });
    const creates: string[] = [];
    const create = vi.fn(async (command: IntegratorCreateCommand): Promise<FleetCreateReceipt> => {
      creates.push(command.hostId);
      return { state: "not_attempted", inputId: command.inputId, retryable: true, reason: `${command.hostId}-refused` };
    });
    const stale = h33Ports([host("host-b"), host("host-c")], create);
    stale.ports.discovery = { snapshot: vi.fn(async () => { snapshotReady(); return staleSnapshot; }) };
    const callerA = admitBoundIntegratorSession({ request, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: stale.ports });
    await reachedSnapshot;

    const callerBPorts = h33Ports([host("host-b")], create);
    const callerB = await admitBoundIntegratorSession({ request, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: callerBPorts.ports });
    expect(callerB).toMatchObject({ state: "not_attempted", binding: { attempts: [{ hostId: "host-a" }, { hostId: "host-b", state: "not_attempted" }] } });

    const staleButDifferentHost = await new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }).reserve({
      operationId: request.attemptId, hostId: "host-c", harness: "codex",
      expectedPriorAttempt: { attempt: 1, inputId: seed.attempt.inputId, hostId: "host-a" },
    });
    expect(staleButDifferentHost.claimed).toBe(false);
    const sameHostRetry = await new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }).reserve({
      operationId: request.attemptId, hostId: "host-b", harness: "codex",
      expectedPriorAttempt: { attempt: 2, inputId: staleButDifferentHost.attempt.inputId, hostId: "host-b" },
    });
    expect(sameHostRetry.claimed).toBe(false);

    unblockSnapshot(view([host("host-b"), host("host-c")]));
    const staleResult = await callerA;
    const current = await new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }).get(request.attemptId);
    expect(staleResult.state).toBe("not_attempted");
    expect(creates).toEqual(["host-b"]);
    expect(current?.attempts.map(attempt => [attempt.hostId, attempt.state])).toEqual([
      ["host-a", "not_attempted"], ["host-b", "not_attempted"],
    ]);
  });

  it("treats an intent left by a crash before native create as unresolved after restart", async () => {
    const f = await fixture();
    await f.store.reserve({ operationId: request.attemptId, hostId: "host-one", harness: "codex" });
    const h33 = h33Ports([host("host-one"), host("host-two")], vi.fn(async () => ({
      state: "created", inputId: request.inputId, retryable: false,
      address: { hostId: "host-two", harness: "codex", nativeSessionId: "must-not-exist" },
    })));

    const result = await admitBoundIntegratorSession({ request, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: h33.ports });
    expect(result).toMatchObject({ state: "unknown", reason: "attempt_in_progress_or_crashed", binding: { state: "intent" } });
    expect(h33.admission).not.toHaveBeenCalled();
  });

  it("keeps prepare failure unresolved without inventing a native input ID", async () => {
    const f = await fixture();
    f.store.reserve = async () => { throw new Error("durable reservation unavailable"); };
    const h33 = h33Ports([host("host-one"), host("host-two")], async command => ({
      state: "created", inputId: command.inputId, retryable: false,
      address: { hostId: command.hostId, harness: command.harness, nativeSessionId: "must-not-create" },
    }));

    const result = await admitBoundIntegratorSession({ request, store: f.store, ports: h33.ports });
    expect(result).toMatchObject({ state: "unknown", binding: null });
    expect(result).not.toHaveProperty("inputId");
    expect(result).not.toHaveProperty("receipt");
    expect(h33.admission).not.toHaveBeenCalled();
  });

  it("does not replay when the journal record response is uncertain and the write did not land", async () => {
    const f = await fixture();
    f.store.record = async () => { throw new Error("record acknowledgement lost"); };
    const create = vi.fn(async (command: IntegratorCreateCommand): Promise<FleetCreateReceipt> => command.hostId === "host-one"
      ? { state: "not_attempted", inputId: command.inputId, retryable: true, reason: "refused" }
      : { state: "created", inputId: command.inputId, retryable: false, address: { hostId: command.hostId, harness: command.harness, nativeSessionId: "must-not-fallback" } });
    const h33 = h33Ports([host("host-one"), host("host-two")], create);

    const result = await admitBoundIntegratorSession({ request, store: f.store, ports: h33.ports });
    expect(result).toMatchObject({ state: "unknown", binding: { state: "intent" } });
    expect(create).toHaveBeenCalledTimes(1);
    const restarted = new IntegratorSessionBindingStore({ persistencePath: f.persistencePath });
    const resumed = await admitBoundIntegratorSession({ request, store: restarted, ports: h33.ports });
    expect(resumed).toMatchObject({ state: "unknown", reason: "attempt_in_progress_or_crashed", binding: { state: "intent" } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a retry refusal's previous host and receipt intact across restart before selecting another host", async () => {
    const f = await fixture();
    const initial = await f.store.reserve({ operationId: request.attemptId, hostId: "host-one", harness: "codex" });
    const refusal: FleetCreateReceipt = { state: "not_attempted", inputId: initial.attempt.inputId, retryable: true, reason: "refused" };
    await f.store.record({ operationId: request.attemptId, attempt: 1, receipt: refusal });
    const create = vi.fn(async (command: IntegratorCreateCommand): Promise<FleetCreateReceipt> => ({
      state: "created", inputId: command.inputId, retryable: false,
      address: { hostId: command.hostId, harness: command.harness, nativeSessionId: "host-two-native" },
    }));
    const h33 = h33Ports([host("host-one"), host("host-two")], create);

    const result = await admitBoundIntegratorSession({ request, store: new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }), ports: h33.ports });
    const saved = await new IntegratorSessionBindingStore({ persistencePath: f.persistencePath }).get(request.attemptId);
    expect(result).toMatchObject({ state: "accepted", address: { hostId: "host-two" } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].hostId).toBe("host-two");
    expect(saved?.attempts[0]?.receipt).toEqual(refusal);
    expect(saved?.attempts[0]?.inputId).toBe(initial.attempt.inputId);
    expect(saved?.attempts[1]?.inputId).not.toBe(initial.attempt.inputId);
    expect(saved?.attempts[1]?.receipt?.inputId).toBe(saved?.attempts[1]?.inputId);
  });
});
