import type { FleetCreateReceipt } from "./mesh/fleet-contract.js";
import {
  admitIntegratorSession,
  type IntegratorAttemptPrepareCommand,
  type IntegratorHostAdmissionResult,
  type IntegratorHostPorts,
  type IntegratorHostRequest,
  type IntegratorPreparedCreateCommand,
  type IntegratorSessionAttemptsPort,
} from "./integrator-host-admission.js";
import {
  IntegratorSessionBindingStore,
  type ExpectedPriorIntegratorAttempt,
  type IntegratorHarness,
  type IntegratorOperationBinding,
  type ReserveIntegratorAttemptResult,
} from "./integrator-session-binding.js";
import type { IntegratorAttemptScope } from "./integrator-session-binding.js";
import { resolveProjectExecutionScope, type ProjectExecutionBinding } from "./project-execution-scope.js";

/** The H33 optional attempts seam, implemented by the durable H34 journal. */
export interface IntegratorCurrentProjectScopeEvidence {
  binding: ProjectExecutionBinding;
  canonicalRoot: { path: string; device: number; inode: number };
  harnessVersion: string;
  appServerDataHome: { path: string; device: number; inode: number };
  transcriptReaderDataHome: { path: string; device: number; inode: number };
}

/** Server-owned evidence provider. Absence and any unverifiable response deny. */
export interface IntegratorSessionScopeOwnerPort {
  resolveCurrentProjectScope(input: {
    projectId: string;
    rootIdentity: string;
    policyRevision: string;
    hostId: string;
    harness: IntegratorHarness;
  }): Promise<IntegratorCurrentProjectScopeEvidence | null>;
}

export type IntegratorSessionAdmissionPorts = Omit<IntegratorHostPorts, "attempts"> & {
  scopeOwner?: IntegratorSessionScopeOwnerPort;
};

export type BoundIntegratorSessionAdmissionResult =
  | { state: "accepted"; binding: IntegratorOperationBinding; address: NonNullable<IntegratorOperationBinding["attempts"][number]["address"]>; admission?: IntegratorHostAdmissionResult }
  | { state: "unknown"; binding: null; reason: string }
  | { state: "not_attempted"; binding: IntegratorOperationBinding; admission?: IntegratorHostAdmissionResult }
  | { state: "not_admitted"; binding: null; admission: IntegratorHostAdmissionResult };

/**
 * Composes current H33 readiness/admission with H34's durable per-attempt IDs.
 * The operation ID is request.attemptId. It never rewrites native receipts.
 */
export async function admitBoundIntegratorSession(input: {
  request: IntegratorHostRequest;
  store: IntegratorSessionBindingStore;
  ports: IntegratorSessionAdmissionPorts;
}): Promise<BoundIntegratorSessionAdmissionResult> {
  const { request, store, ports } = input;
  let existing: IntegratorOperationBinding | null;
  try {
    existing = await store.get(request.attemptId);
  } catch {
    return { state: "unknown", binding: null, reason: "binding_read_uncertain" };
  }

  if (existing) {
    if (existing.harness !== request.harness) {
      return { state: "unknown", binding: null, reason: "operation_harness_conflict" };
    }
    const last = existing.attempts.at(-1)!;
    if (existing.state === "accepted") {
      if (!last.address || !last.scope) return { state: "unknown", binding: null, reason: "integrator_scope_unavailable" };
      const current = await resolveCurrentScope(request, last.hostId, ports);
      if (!current.ok) return { state: "unknown", binding: null, reason: current.reason };
      if (!sameStableScope(last.scope, current.scope)) return { state: "unknown", binding: null, reason: "integrator_scope_mismatch" };
      return { state: "accepted", binding: existing, address: last.address };
    }
    if (existing.state === "unknown" || existing.state === "intent") {
      return { state: "unknown", binding: null, reason: existing.state === "intent" ? "attempt_in_progress_or_crashed" : "attempt_outcome_unknown" };
    }
    if (existing.state !== "not_attempted" || last.receipt?.state !== "not_attempted" || last.receipt.retryable !== true) {
      return { state: "unknown", binding: null, reason: "retry_not_proven_safe" };
    }
  }

  let expectedPriorAttempt: ExpectedPriorIntegratorAttempt | undefined;
  if (existing) {
    const previous = existing.attempts.at(-1)!;
    expectedPriorAttempt = { attempt: previous.attempt, inputId: previous.inputId, hostId: previous.hostId };
  }

  const discovery = {
    snapshot: async (options: { refresh: true }) => {
      const fresh = await ports.discovery.snapshot(options);
      if (!existing) return fresh;
      const previousHostId = existing.attempts.at(-1)!.hostId;
      return { ...fresh, hosts: fresh.hosts.filter(host => host.hostId !== previousHostId) };
    },
  };

  let scopeFailureReason: string | undefined;
  const attempts = {
    prepare: async (command: IntegratorAttemptPrepareCommand) => {
      if (command.attemptId !== request.attemptId) throw new Error("integrator_session_admission_operation_mismatch");
      const scopeEvidence = await resolveCurrentScope(request, command.hostId, ports, command.executionBinding, command.checkoutRoot);
      if (!scopeEvidence.ok) {
        scopeFailureReason = scopeEvidence.reason;
        throw new Error(scopeEvidence.reason);
      }
      const reserved = await store.reserve({
        operationId: command.attemptId,
        hostId: command.hostId,
        harness: command.harness as IntegratorHarness,
        scope: scopeEvidence.scope,
        ...(expectedPriorAttempt ? { expectedPriorAttempt } : {}),
      });
      if (reserved.claimed) {
        const afterReserve = await resolveCurrentScope(request, command.hostId, ports, command.executionBinding, command.checkoutRoot);
        if (!afterReserve.ok) {
          scopeFailureReason = afterReserve.reason;
          throw new Error(afterReserve.reason);
        }
        if (!sameStableScope(scopeEvidence.scope, afterReserve.scope)) {
          scopeFailureReason = "integrator_scope_changed_during_reservation";
          throw new Error(scopeFailureReason);
        }
      }
      return prepareResult(reserved);
    },
    record: async (command: IntegratorPreparedCreateCommand, receipt: FleetCreateReceipt) => {
      if (command.attemptId !== request.attemptId) throw new Error("integrator_session_admission_operation_mismatch");
      await store.record({ operationId: command.attemptId, attempt: command.attemptOrdinal, receipt });
      expectedPriorAttempt = { attempt: command.attemptOrdinal, inputId: command.inputId, hostId: command.hostId };
    },
  };

  const h34Attempts: IntegratorSessionAttemptsPort = attempts;
  const h33Ports: IntegratorHostPorts = { ...ports, discovery, attempts: h34Attempts };
  let admission: IntegratorHostAdmissionResult;
  try {
    admission = await admitIntegratorSession(request, h33Ports);
  } catch {
    return { state: "unknown", binding: null, reason: "admission_or_journal_response_uncertain" };
  }

  let binding: IntegratorOperationBinding | null;
  try {
    binding = await store.get(request.attemptId);
  } catch {
    return { state: "unknown", binding: null, reason: "binding_read_uncertain" };
  }
  if (!binding) {
    if (admission.state === "ineligible" || admission.state === "not_admitted") return { state: "not_admitted", binding: null, admission };
    return { state: "unknown", binding: null,
      reason: scopeFailureReason ?? (admission.state === "unknown" ? admission.reason : "journal_binding_absent_after_admission") };
  }

  const finalAttempt = binding.attempts.at(-1)!;
  if (binding.state === "accepted" && finalAttempt.address) {
    if (!finalAttempt.scope) return { state: "unknown", binding: null, reason: "integrator_scope_unavailable" };
    const current = await resolveCurrentScope(request, finalAttempt.hostId, ports);
    if (!current.ok) return { state: "unknown", binding: null, reason: current.reason };
    if (!sameStableScope(finalAttempt.scope, current.scope)) return { state: "unknown", binding: null, reason: "integrator_scope_mismatch" };
    return { state: "accepted", binding, address: finalAttempt.address, admission };
  }
  if (admission.state === "unknown") {
    return { state: "unknown", binding: null,
      reason: scopeFailureReason ?? admission.receipt?.reason ?? admission.reason ?? "admission_outcome_unknown" };
  }
  if (binding.state === "not_attempted" && finalAttempt.receipt?.retryable === true) {
    return { state: "not_attempted", binding, admission };
  }
  return { state: "unknown", binding: null, reason: binding.state === "unknown" ? "attempt_outcome_unknown" : "intent_unresolved" };
}

async function resolveCurrentScope(
  request: IntegratorHostRequest,
  hostId: string,
  ports: IntegratorSessionAdmissionPorts,
  expectedBinding?: ProjectExecutionBinding,
  expectedCanonicalRoot?: string,
): Promise<{ ok: true; scope: IntegratorAttemptScope } | { ok: false; reason: string }> {
  const owner = ports.scopeOwner;
  if (!owner || typeof owner.resolveCurrentProjectScope !== "function") return { ok: false, reason: "integrator_scope_unavailable" };
  let evidence: IntegratorCurrentProjectScopeEvidence | null;
  try {
    evidence = await owner.resolveCurrentProjectScope({
      projectId: request.projectId, rootIdentity: request.rootIdentity, policyRevision: request.policyRevision,
      hostId, harness: request.harness as IntegratorHarness,
    });
  } catch {
    return { ok: false, reason: "integrator_scope_unavailable" };
  }
  if (!evidence || !isIdentity(evidence.canonicalRoot) || !isIdentity(evidence.appServerDataHome)
    || !isIdentity(evidence.transcriptReaderDataHome) || typeof evidence.harnessVersion !== "string"
    || evidence.harnessVersion !== request.harnessVersion) return { ok: false, reason: "integrator_scope_mismatch" };
  const { binding } = evidence;
  if (!binding || binding.projectId !== request.projectId || binding.rootIdentity !== request.rootIdentity
    || binding.policyRevision !== request.policyRevision || binding.attemptId !== request.attemptId || binding.hostId !== hostId
    || (expectedBinding && !sameExecutionBinding(binding, expectedBinding))
    || (expectedCanonicalRoot && evidence.canonicalRoot.path !== expectedCanonicalRoot)
    || !sameIdentity(evidence.appServerDataHome, evidence.transcriptReaderDataHome)) {
    return { ok: false, reason: "integrator_scope_mismatch" };
  }
  const trusted = await resolveProjectExecutionScope(binding, ports.runtimeOwner);
  if (!trusted.eligible) return { ok: false, reason: "integrator_scope_unavailable" };
  return {
    ok: true,
    scope: {
      projectId: binding.projectId,
      rootIdentity: binding.rootIdentity,
      policyRevision: binding.policyRevision,
      hostId: binding.hostId,
      harness: request.harness as IntegratorHarness,
      harnessVersion: evidence.harnessVersion,
      canonicalRoot: { ...evidence.canonicalRoot },
      nativeDataHome: { ...evidence.appServerDataHome },
    },
  };
}

function isIdentity(value: unknown): value is { path: string; device: number; inode: number } {
  if (!value || typeof value !== "object") return false;
  const identity = value as { path?: unknown; device?: unknown; inode?: unknown };
  return typeof identity.path === "string" && identity.path.trim().length > 0
    && Number.isSafeInteger(identity.device) && (identity.device as number) >= 0
    && Number.isSafeInteger(identity.inode) && (identity.inode as number) > 0;
}

function sameIdentity(left: { path: string; device: number; inode: number }, right: { path: string; device: number; inode: number }): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function sameExecutionBinding(left: ProjectExecutionBinding, right: ProjectExecutionBinding): boolean {
  return left.projectId === right.projectId && left.rootIdentity === right.rootIdentity
    && left.policyRevision === right.policyRevision && left.attemptId === right.attemptId
    && left.hostId === right.hostId && left.runtimeInstanceId === right.runtimeInstanceId;
}

function sameStableScope(left: IntegratorAttemptScope, right: IntegratorAttemptScope): boolean {
  return left.projectId === right.projectId && left.rootIdentity === right.rootIdentity
    && left.policyRevision === right.policyRevision && left.hostId === right.hostId && left.harness === right.harness
    && left.harnessVersion === right.harnessVersion && sameIdentity(left.canonicalRoot, right.canonicalRoot)
    && sameIdentity(left.nativeDataHome, right.nativeDataHome);
}

function prepareResult(result: ReserveIntegratorAttemptResult) {
  const { attempt, binding } = result;
  return {
    claimed: result.claimed,
    inputId: attempt.inputId,
    attemptOrdinal: attempt.attempt,
    ...(attempt.receipt ? { existingReceipt: attempt.receipt } : {}),
    ...(result.claimed ? {} : { reason: binding.state === "intent" ? "attempt_in_progress_or_crashed" : binding.state }),
  };
}
