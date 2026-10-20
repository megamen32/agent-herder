import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FleetCreateReceipt, FleetHost, FleetView } from "../src/mesh/fleet-contract.js";
import {
  admitIntegratorSession,
  INTEGRATOR_HOST_MODEL,
  type IntegratorHostReadiness,
  type IntegratorHostRequest,
  type IntegratorHostPorts,
  type IntegratorCreateCommand,
  type HostPathResolution,
} from "../src/integrator-host-admission.js";
import type { ProjectExecutionBinding, TrustedRuntimeOwnerProof } from "../src/project-execution-scope.js";

const now = Date.now();
const request: IntegratorHostRequest = {
  projectId: "project-7",
  rootIdentity: "root:sha256:abc",
  policyRevision: "policy-3",
  attemptId: "attempt-9",
  checkoutRoot: "/work/project",
  harness: "codex",
  harnessVersion: "1.2.3",
  requiredTools: ["read", "edit"],
  model: "gpt-6-luna",
  name: "Integrator task",
  cwd: "/work/project",
  inputId: "stable-input-9",
};

function host(hostId: string, overrides: Partial<FleetHost> = {}): FleetHost {
  return {
    hostId,
    label: hostId,
    state: "ready",
    fetchedAt: now - 100,
    expiresAt: now + 10_000,
    generation: 4,
    createHarnesses: ["codex"],
    ...overrides,
  };
}

function binding(hostId: string, runtimeInstanceId: string): ProjectExecutionBinding {
  return {
    projectId: request.projectId,
    rootIdentity: request.rootIdentity,
    policyRevision: request.policyRevision,
    attemptId: request.attemptId,
    hostId,
    runtimeInstanceId,
  };
}

function readiness(
  hostId: string,
  requestValue: IntegratorHostRequest = request,
  resolutionOverride: Partial<HostPathResolution> = {},
): IntegratorHostReadiness {
  const executionBinding = { ...binding(hostId, `runtime-${hostId}`), rootIdentity: requestValue.rootIdentity };
  const canonicalCheckoutRoot = resolutionOverride.canonicalCheckoutRoot ?? posix.normalize(requestValue.checkoutRoot);
  const canonicalCwd = resolutionOverride.canonicalCwd ?? posix.normalize(requestValue.cwd);
  const relative = posix.relative(canonicalCheckoutRoot, canonicalCwd);
  const pathResolution: HostPathResolution = {
    pathFlavor: "posix",
    requestedCheckoutRoot: requestValue.checkoutRoot,
    requestedCwd: requestValue.cwd,
    canonicalCheckoutRoot,
    canonicalCwd,
    canonicalRootIdentity: requestValue.rootIdentity,
    checkoutRootEquivalent: true,
    cwdEquivalent: true,
    cwdWithinCheckoutRoot: relative === "" || (relative !== ".." && !relative.startsWith("../")),
    ...resolutionOverride,
  };
  return {
    host: host(hostId),
    observedAtMs: now - 100,
    checkoutRoot: requestValue.checkoutRoot,
    pathResolution,
    harness: requestValue.harness,
    harnessVersion: requestValue.harnessVersion,
    availableTools: ["read", "edit", "exec"],
    availableModels: [INTEGRATOR_HOST_MODEL],
    resourceReady: true,
    runtimeInstanceId: executionBinding.runtimeInstanceId,
  };
}

function proofFor(executionBinding: ProjectExecutionBinding): TrustedRuntimeOwnerProof {
  return { kind: "trusted", binding: executionBinding, issuedAtMs: now - 100, expiresAtMs: now + 5_000 };
}

function view(hosts: FleetHost[]): FleetView {
  return { hosts, sessions: [], complete: true, limited: false };
}

function ports(
  hosts: FleetHost[],
  create: (hostId: string, call: number) => Promise<FleetCreateReceipt>,
  overrides: Partial<IntegratorHostPorts> = {},
) {
  let calls = 0;
  const admission = vi.fn(async (candidate: IntegratorCreateCommand) => create(candidate.hostId, ++calls));
  const result: IntegratorHostPorts = {
    now: () => now,
    discovery: { snapshot: vi.fn(async () => view(hosts)) },
    readiness: { observe: vi.fn(async (candidate, currentRequest) => readiness(candidate.hostId, currentRequest)) },
    runtimeOwner: { resolve: vi.fn(async (expected) => proofFor(expected)) },
    admission: { create: admission },
    ...overrides,
  };
  return { ports: result, admission };
}

const refused = (inputId = request.inputId): FleetCreateReceipt => ({
  state: "not_attempted", inputId, retryable: true, reason: "native_create_unavailable",
});

describe("admitIntegratorSession", () => {
  it.each([
    ["cwd outside the approved checkout", { ...request, cwd: "/work/sibling" }],
    ["path traversal", { ...request, cwd: "/work/project/../sibling" }],
  ])("does not create for %s", async (_label, candidate) => {
    const fixture = ports([host("host-a")], async () => ({
      state: "created", inputId: candidate.inputId, retryable: false,
      address: { hostId: "host-a", harness: "codex", nativeSessionId: "must-not-exist" },
    }));
    await admitIntegratorSession(candidate, fixture.ports);
    expect(fixture.admission).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["different", "gpt-5.6-luna"],
    ["whitespace", "  "],
  ])("does not create with %s model", async (_label, model) => {
    const fixture = ports([host("host-a")], async () => refused());
    await admitIntegratorSession({ ...request, model } as IntegratorHostRequest, fixture.ports);
    expect(fixture.admission).not.toHaveBeenCalled();
  });

  it("uses H34-reserved native IDs and records each exact receipt before host fallback", async () => {
    const calls: string[] = [];
    let ordinal = 0;
    const attemptPort = {
      prepare: vi.fn(async (command: { hostId: string }) => {
        ordinal += 1;
        calls.push(`prepare:${command.hostId}:${ordinal}`);
        return { claimed: true, inputId: `durable-input-${ordinal}`, attemptOrdinal: ordinal };
      }),
      record: vi.fn(async (command: IntegratorCreateCommand & { attemptOrdinal: number }, receipt: FleetCreateReceipt) => {
        calls.push(`record:${command.inputId}:${receipt.state}`);
      }),
    };
    const base = ports([host("host-a"), host("host-b")], async () => refused());
    const admission = vi.fn(async (command: IntegratorCreateCommand) => {
      calls.push(`create:${command.hostId}:${command.inputId}`);
      return command.hostId === "host-a"
        ? { state: "not_attempted" as const, inputId: command.inputId, retryable: true, reason: "preflight_refused" }
        : { state: "created" as const, inputId: command.inputId, retryable: false, address: { hostId: command.hostId, harness: command.harness, nativeSessionId: "native-h34" } };
    });
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(attemptPort.prepare.mock.calls.map(([command]) => command.hostId)).toEqual(["host-a", "host-b"]);
    expect(admission.mock.calls.map(([command]) => [command.inputId, command.attemptId])).toEqual([
      ["durable-input-1", request.attemptId], ["durable-input-2", request.attemptId],
    ]);
    expect(attemptPort.record.mock.calls.map(([command, receipt]) => [command.inputId, command.attemptOrdinal, receipt.inputId, receipt.state])).toEqual([
      ["durable-input-1", 1, "durable-input-1", "not_attempted"],
      ["durable-input-2", 2, "durable-input-2", "created"],
    ]);
    expect(calls).toEqual([
      "prepare:host-a:1", "create:host-a:durable-input-1", "record:durable-input-1:not_attempted",
      "prepare:host-b:2", "create:host-b:durable-input-2", "record:durable-input-2:created",
    ]);
    expect(result).toMatchObject({ state: "created", receipt: { inputId: "durable-input-2", address: { hostId: "host-b" } } });
  });

  it("stops UNKNOWN without inventing an input ID when durable prepare fails", async () => {
    const attemptPort = {
      prepare: vi.fn(async () => { throw new Error("reservation outcome unavailable"); }),
      record: vi.fn(),
    };
    const base = ports([host("host-a")], async () => refused());
    const admission = vi.fn(async () => refused());
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "unknown", reason: "attempt_prepare_failed", attemptId: request.attemptId });
    expect(result).not.toHaveProperty("receipt");
    expect(result).not.toHaveProperty("inputId", request.inputId);
    expect(admission).not.toHaveBeenCalled();
    expect(attemptPort.record).not.toHaveBeenCalled();
  });

  it("does not fall back when recording the exact pre-admission refusal is uncertain", async () => {
    let ordinal = 0;
    const attemptPort = {
      prepare: vi.fn(async (_command: { hostId: string }) => {
        ordinal += 1;
        return { claimed: true, inputId: `durable-${ordinal}`, attemptOrdinal: ordinal };
      }),
      record: vi.fn(async () => { throw new Error("record response uncertain"); }),
    };
    const base = ports([host("host-a"), host("host-b")], async () => refused());
    const admission = vi.fn(async (command: IntegratorCreateCommand) => ({
      state: "not_attempted" as const, inputId: command.inputId, retryable: true, reason: "preflight_refused",
    }));
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "unknown", reason: "attempt_record_uncertain", receipt: { inputId: "durable-1", state: "not_attempted" } });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(attemptPort.prepare).toHaveBeenCalledTimes(1);
    expect(attemptPort.record).toHaveBeenCalledTimes(1);
  });

  it("returns the durable busy/existing state without creating when prepare did not claim", async () => {
    const existingReceipt: FleetCreateReceipt = { state: "unknown", inputId: "durable-existing", retryable: false, reason: "prior_response_lost" };
    const attemptPort = {
      prepare: vi.fn(async () => ({ claimed: false, inputId: existingReceipt.inputId, attemptOrdinal: 1, existingReceipt, reason: "attempt_in_progress" })),
      record: vi.fn(),
    };
    const base = ports([host("host-a"), host("host-b")], async () => refused());
    const admission = vi.fn(async () => refused());
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "deferred", inputId: existingReceipt.inputId, receipt: existingReceipt, hostId: "host-a" });
    expect(admission).not.toHaveBeenCalled();
    expect(attemptPort.record).not.toHaveBeenCalled();
  });

  it("records UNKNOWN under the reserved H34 input ID when native create throws", async () => {
    const attemptPort = {
      prepare: vi.fn(async () => ({ claimed: true, inputId: "durable-create-unknown", attemptOrdinal: 1 })),
      record: vi.fn(async () => undefined),
    };
    const base = ports([host("host-a"), host("host-b")], async () => refused());
    const admission = vi.fn(async () => { throw new Error("native response lost"); });
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "unknown", receipt: { state: "unknown", inputId: "durable-create-unknown" } });
    expect(attemptPort.record).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: request.attemptId, inputId: "durable-create-unknown", attemptOrdinal: 1 }),
      expect.objectContaining({ state: "unknown", inputId: "durable-create-unknown" }),
    );
    expect(admission).toHaveBeenCalledTimes(1);
    expect(attemptPort.prepare).toHaveBeenCalledTimes(1);
  });

  it("never records or falls back using a native receipt with a rewritten input ID", async () => {
    const attemptPort = {
      prepare: vi.fn(async () => ({ claimed: true, inputId: "durable-exact", attemptOrdinal: 1 })),
      record: vi.fn(async () => undefined),
    };
    const base = ports([host("host-a"), host("host-b")], async () => refused());
    const admission = vi.fn(async () => ({
      state: "not_attempted" as const, inputId: "rewritten-id", retryable: true, reason: "preflight_refused",
    }));
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "unknown", reason: "admission_receipt_invalid_or_input_id_mismatch" });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(attemptPort.prepare).toHaveBeenCalledTimes(1);
    expect(attemptPort.record).not.toHaveBeenCalled();
  });

  it("rejects an H34 reservation that aliases the caller input ID", async () => {
    const attemptPort = {
      prepare: vi.fn(async () => ({ claimed: true, inputId: request.inputId, attemptOrdinal: 1 })),
      record: vi.fn(async () => undefined),
    };
    const base = ports([host("host-a")], async () => refused());
    const admission = vi.fn(async () => refused());
    const dependencies = { ...base.ports, admission: { create: admission }, attempts: attemptPort } as unknown as IntegratorHostPorts;

    const result = await admitIntegratorSession(request, dependencies);

    expect(result).toMatchObject({ state: "unknown", reason: "attempt_input_id_alias" });
    expect(admission).not.toHaveBeenCalled();
    expect(attemptPort.record).not.toHaveBeenCalled();
  });

  it("uses the host-resolved cwd for an explicitly attested symlink alias within the bound root", async () => {
    const aliasRequest = { ...request, checkoutRoot: "/work/checkout-link", cwd: "/work/checkout-link/linked-work" };
    const fixture = ports([host("host-a")], async () => ({
      state: "created", inputId: request.inputId, retryable: false,
      address: { hostId: "host-a", harness: "codex", nativeSessionId: "native-2" },
    }), {
      readiness: { observe: vi.fn(async candidate => readiness(candidate.hostId, aliasRequest, {
        canonicalCheckoutRoot: "/work/project",
        canonicalCwd: "/work/project/actual-work",
        checkoutRootEquivalent: true,
        cwdEquivalent: true,
      })) },
    });

    await admitIntegratorSession(aliasRequest, fixture.ports);

    expect(fixture.admission).toHaveBeenCalledTimes(1);
    expect(fixture.admission.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/work/project/actual-work",
      checkoutRoot: "/work/project",
      requestedCheckoutRoot: aliasRequest.checkoutRoot,
      requestedCwd: aliasRequest.cwd,
      model: INTEGRATOR_HOST_MODEL,
    });
  });

  it("rejects an alias whose canonical root identity differs from the H31 root binding", async () => {
    const aliasRequest = { ...request, checkoutRoot: "/work/checkout-link" };
    const fixture = ports([host("host-a")], async () => refused(), {
      readiness: { observe: vi.fn(async candidate => readiness(candidate.hostId, aliasRequest, {
        canonicalCheckoutRoot: "/work/project",
        canonicalRootIdentity: "root:sha256:other",
      })) },
    });
    await admitIntegratorSession(aliasRequest, fixture.ports);
    expect(fixture.admission).not.toHaveBeenCalled();
  });

  it("rejects a symlink alias that lacks host-owner canonical-equivalence attestation", async () => {
    const aliasRequest = { ...request, cwd: "/work/project/linked-work" };
    const fixture = ports([host("host-a")], async () => refused(), {
      readiness: { observe: vi.fn(async candidate => readiness(candidate.hostId, aliasRequest, {
        canonicalCwd: "/work/project/actual-work",
        cwdEquivalent: false as never,
      })) },
    });
    await admitIntegratorSession(aliasRequest, fixture.ports);
    expect(fixture.admission).not.toHaveBeenCalled();
  });

  it("admits a traversal-normalized cwd only with host-owner canonical-equivalence attestation", async () => {
    const traversalRequest = { ...request, cwd: "/work/project/stage/../actual-work" };
    const fixture = ports([host("host-a")], async () => ({
      state: "created", inputId: request.inputId, retryable: false,
      address: { hostId: "host-a", harness: "codex", nativeSessionId: "native-3" },
    }));
    await admitIntegratorSession(traversalRequest, fixture.ports);
    expect(fixture.admission).toHaveBeenCalledTimes(1);
    expect(fixture.admission.mock.calls[0]?.[0].cwd).toBe("/work/project/actual-work");
  });

  it("rejects a traversal-normalized cwd when canonical-equivalence is not attested", async () => {
    const traversalRequest = { ...request, cwd: "/work/project/stage/../actual-work" };
    const fixture = ports([host("host-a")], async () => refused(), {
      readiness: { observe: vi.fn(async candidate => readiness(candidate.hostId, traversalRequest, {
        cwdEquivalent: false as never,
      })) },
    });
    await admitIntegratorSession(traversalRequest, fixture.ports);
    expect(fixture.admission).not.toHaveBeenCalled();
  });

  it("falls back once after a definite pre-admission refusal, preserving attempt and input identity", async () => {
    const { ports: dependencies, admission } = ports(
      [host("host-a"), host("host-b")],
      async (_hostId, call) => call === 1
        ? refused()
        : { state: "created", inputId: request.inputId, retryable: false, address: { hostId: "host-b", harness: "codex", nativeSessionId: "native-1" } },
    );

    const result = await admitIntegratorSession(request, dependencies);

    expect(admission).toHaveBeenCalledTimes(2);
    expect(admission.mock.calls.map(([candidate]) => candidate.hostId)).toEqual(["host-a", "host-b"]);
    expect(admission.mock.calls.map(([candidate]) => [candidate.inputId, candidate.attemptId])).toEqual([
      [request.inputId, request.attemptId], [request.inputId, request.attemptId],
    ]);
    expect(admission.mock.calls.map(([candidate]) => candidate.executionBinding.hostId)).toEqual(["host-a", "host-b"]);
    expect(result).toMatchObject({ state: "created", receipt: { address: { hostId: "host-b", nativeSessionId: "native-1" } } });
  });

  it.each([
    ["accepted", { state: "created", inputId: request.inputId, retryable: false, address: { hostId: "host-a", harness: "codex", nativeSessionId: "native-1" } }],
    ["unknown", { state: "unknown", inputId: request.inputId, retryable: false, reason: "response_lost" }],
    ["not retryable", { state: "not_attempted", inputId: request.inputId, retryable: false, reason: "policy_denied" }],
  ] as const)("does not fall back after %s admission outcome", async (_label, receipt) => {
    const { ports: dependencies, admission } = ports([host("host-a"), host("host-b")], async () => receipt);
    await admitIntegratorSession(request, dependencies);
    expect(admission).toHaveBeenCalledTimes(1);
  });

  it("fails closed on stale discovery, stale readiness, and a model-supplied proof", async () => {
    const staleHost = host("host-a", { expiresAt: now });
    const first = ports([staleHost], async () => refused());
    await admitIntegratorSession(request, first.ports);
    expect(first.admission).not.toHaveBeenCalled();

    const staleReadiness = ports([host("host-a")], async () => refused(), {
      readiness: { observe: vi.fn(async () => ({ ...readiness("host-a"), observedAtMs: now - 30_001 })) },
    });
    await admitIntegratorSession(request, staleReadiness.ports);
    expect(staleReadiness.admission).not.toHaveBeenCalled();

    const untrusted = ports([host("host-a")], async () => refused(), {
      runtimeOwner: { resolve: vi.fn(async () => ({ eligible: true })) },
    });
    await admitIntegratorSession(request, untrusted.ports);
    expect(untrusted.admission).not.toHaveBeenCalled();

    const staleProof = ports([host("host-a")], async () => refused(), {
      runtimeOwner: { resolve: vi.fn(async expected => ({
        kind: "trusted", binding: expected, issuedAtMs: now - 30_001, expiresAtMs: now + 5_000,
      })) },
    });
    await admitIntegratorSession(request, staleProof.ports);
    expect(staleProof.admission).not.toHaveBeenCalled();
  });

  it("rejects harness, version, checkout, tool, resource, and runtime binding mismatches", async () => {
    const mutations: Array<[string, (value: IntegratorHostReadiness) => IntegratorHostReadiness]> = [
      ["harness", value => ({ ...value, harness: "opencode" as never })],
      ["version", value => ({ ...value, harnessVersion: "0.0.0" })],
      ["checkout", value => ({ ...value, checkoutRoot: "/work/other" })],
      ["tools", value => ({ ...value, availableTools: ["read"] })],
      ["model", value => ({ ...value, availableModels: ["another-model"] })],
      ["resources", value => ({ ...value, resourceReady: false })],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = ports([host("host-a")], async () => refused(), {
        readiness: { observe: vi.fn(async () => mutate(readiness("host-a"))) },
      });
      await admitIntegratorSession(request, fixture.ports);
      expect(fixture.admission, label).not.toHaveBeenCalled();
    }

    const mismatchedProof = ports([host("host-a")], async () => refused(), {
      runtimeOwner: { resolve: vi.fn(async expected => proofFor({ ...expected, policyRevision: "old-policy" })) },
    });
    await admitIntegratorSession(request, mismatchedProof.ports);
    expect(mismatchedProof.admission, "runtime proof").not.toHaveBeenCalled();

    let observations = 0;
    const changedRuntime = ports([host("host-a")], async () => refused(), {
      readiness: { observe: vi.fn(async candidate => {
        observations += 1;
        return observations === 1 ? readiness(candidate.hostId) : {
          ...readiness(candidate.hostId), runtimeInstanceId: "replaced-runtime",
        };
      }) },
    });
    const changed = await admitIntegratorSession(request, changedRuntime.ports);
    expect(changed).toMatchObject({ state: "ineligible", attemptedHostIds: [] });
    expect(changedRuntime.admission).not.toHaveBeenCalled();
  });
});
