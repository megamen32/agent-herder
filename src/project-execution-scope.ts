/**
 * H31 contract only. This module does not create an OS sandbox and is not
 * wired to shared production execution. A future trusted composition root must
 * provide the resolver owned by the runtime that will execute the attempt.
 */

export interface ProjectExecutionBinding {
  projectId: string;
  rootIdentity: string;
  policyRevision: string;
  attemptId: string;
  hostId: string;
  runtimeInstanceId: string;
}

export interface TrustedRuntimeOwnerProof {
  kind: "trusted";
  binding: ProjectExecutionBinding;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface TrustedRuntimeOwnerResolver {
  /** Resolve from the actual runtime owner; caller supplied booleans are not proof. */
  resolve(binding: ProjectExecutionBinding): Promise<unknown>;
}

export type ProjectExecutionScopeResult =
  | { eligible: true; binding: ProjectExecutionBinding }
  | {
      eligible: false;
      reason:
        | "runtime_owner_resolver_missing"
        | "runtime_owner_proof_unavailable"
        | "runtime_owner_proof_invalid"
        | "runtime_owner_proof_stale"
        | "runtime_owner_binding_mismatch";
    };

/**
 * The returned eligibility is a contract result, not a portable capability or
 * confinement claim. Call only from a composition root that owns the trusted
 * runtime resolver. Production execution stays disabled until H32/H34 wire
 * actual confinement and admission.
 */
export async function resolveProjectExecutionScope(
  expected: ProjectExecutionBinding,
  resolver?: TrustedRuntimeOwnerResolver,
): Promise<ProjectExecutionScopeResult> {
  if (!resolver || typeof resolver.resolve !== "function") {
    return { eligible: false, reason: "runtime_owner_resolver_missing" };
  }
  if (!isBinding(expected)) {
    return { eligible: false, reason: "runtime_owner_binding_mismatch" };
  }

  let candidate: unknown;
  try {
    candidate = await resolver.resolve({ ...expected });
  } catch {
    return { eligible: false, reason: "runtime_owner_proof_unavailable" };
  }
  if (!isProof(candidate)) {
    return { eligible: false, reason: "runtime_owner_proof_invalid" };
  }

  const now = Date.now();
  if (candidate.issuedAtMs > now || candidate.expiresAtMs <= now || now - candidate.issuedAtMs > MAX_PROOF_AGE_MS) {
    return { eligible: false, reason: "runtime_owner_proof_stale" };
  }
  if (!sameBinding(candidate.binding, expected)) {
    return { eligible: false, reason: "runtime_owner_binding_mismatch" };
  }
  return { eligible: true, binding: { ...expected } };
}

const MAX_PROOF_AGE_MS = 30_000;
const BINDING_KEYS: readonly (keyof ProjectExecutionBinding)[] = [
  "projectId",
  "rootIdentity",
  "policyRevision",
  "attemptId",
  "hostId",
  "runtimeInstanceId",
];

function isBinding(value: unknown): value is ProjectExecutionBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return BINDING_KEYS.every((key) => typeof record[key] === "string" && record[key].trim().length > 0);
}

function isProof(value: unknown): value is TrustedRuntimeOwnerProof {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === "trusted"
    && isBinding(record.binding)
    && typeof record.issuedAtMs === "number"
    && Number.isFinite(record.issuedAtMs)
    && typeof record.expiresAtMs === "number"
    && Number.isFinite(record.expiresAtMs)
    && record.expiresAtMs > record.issuedAtMs;
}

function sameBinding(left: ProjectExecutionBinding, right: ProjectExecutionBinding): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}
