import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveProjectExecutionScope,
  type ProjectExecutionBinding,
  type TrustedRuntimeOwnerProof,
} from "../src/project-execution-scope.js";

const now = 1_800_000_000_000;
const binding: ProjectExecutionBinding = {
  projectId: "project-17",
  rootIdentity: "root:sha256:abc123",
  policyRevision: "policy-r8",
  attemptId: "attempt-4",
  hostId: "server-100",
  runtimeInstanceId: "runtime-a91",
};

function proof(overrides: Partial<TrustedRuntimeOwnerProof> = {}): TrustedRuntimeOwnerProof {
  return {
    kind: "trusted",
    binding: { ...binding },
    issuedAtMs: now - 1_000,
    expiresAtMs: now + 10_000,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("resolveProjectExecutionScope", () => {
  it("admits only a fresh trusted runtime-owner proof for the exact binding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const resolver = { resolve: vi.fn(async () => proof()) };

    await expect(resolveProjectExecutionScope(binding, resolver)).resolves.toEqual({
      eligible: true,
      binding,
    });
    expect(resolver.resolve).toHaveBeenCalledWith(binding);
  });

  it("denies when the trusted runtime-owner resolver is absent", async () => {
    await expect(resolveProjectExecutionScope(binding)).resolves.toEqual({
      eligible: false,
      reason: "runtime_owner_resolver_missing",
    });
  });

  it("denies unavailable, unknown, caller-boolean, and malformed proofs", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["unavailable", async () => { throw new Error("owner unavailable"); }],
      ["unknown", async () => ({ kind: "unknown" })],
      ["caller boolean", async () => ({ eligible: true })],
      ["malformed trusted proof", async () => ({ ...proof(), binding: { ...binding, attemptId: "" } })],
    ];
    for (const [name, resolve] of cases) {
      const result = await resolveProjectExecutionScope(binding, { resolve });
      expect(result, name).toEqual({
        eligible: false,
        reason: name === "unavailable" ? "runtime_owner_proof_unavailable" : "runtime_owner_proof_invalid",
      });
    }
  });

  it("denies stale, expired, and future-dated proofs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const staleProofs = [
      proof({ issuedAtMs: now - 30_001 }),
      proof({ expiresAtMs: now }),
      proof({ issuedAtMs: now + 1 }),
    ];
    for (const stale of staleProofs) {
      await expect(resolveProjectExecutionScope(binding, { resolve: async () => stale })).resolves.toEqual({
        eligible: false,
        reason: "runtime_owner_proof_stale",
      });
    }
  });

  it.each([
    "projectId",
    "rootIdentity",
    "policyRevision",
    "attemptId",
    "hostId",
    "runtimeInstanceId",
  ] as const)("denies a proof for a different %s", async (key) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const other = { ...binding, [key]: `${binding[key]}-other` };
    await expect(resolveProjectExecutionScope(binding, {
      resolve: async () => proof({ binding: other }),
    })).resolves.toEqual({ eligible: false, reason: "runtime_owner_binding_mismatch" });
  });

  it("denies incomplete or unknown expected bindings before resolver use", async () => {
    const resolve = vi.fn(async () => proof());
    await expect(resolveProjectExecutionScope(
      { ...binding, runtimeInstanceId: "  " },
      { resolve },
    )).resolves.toEqual({ eligible: false, reason: "runtime_owner_binding_mismatch" });
    expect(resolve).not.toHaveBeenCalled();
  });
});
