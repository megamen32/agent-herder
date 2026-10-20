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

/** The H33 optional attempts seam, implemented by the durable H34 journal. */
export type IntegratorSessionAdmissionPorts = Omit<IntegratorHostPorts, "attempts">;

export type BoundIntegratorSessionAdmissionResult =
  | { state: "accepted"; binding: IntegratorOperationBinding; address: NonNullable<IntegratorOperationBinding["attempts"][number]["address"]>; admission?: IntegratorHostAdmissionResult }
  | { state: "unknown"; binding: IntegratorOperationBinding | null; reason: string; admission?: IntegratorHostAdmissionResult }
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
      return { state: "unknown", binding: existing, reason: "operation_harness_conflict" };
    }
    const last = existing.attempts.at(-1)!;
    if (existing.state === "accepted") {
      if (last.address) return { state: "accepted", binding: existing, address: last.address };
      return { state: "unknown", binding: existing, reason: "accepted_address_unavailable" };
    }
    if (existing.state === "unknown" || existing.state === "intent") {
      return { state: "unknown", binding: existing, reason: existing.state === "intent" ? "attempt_in_progress_or_crashed" : "attempt_outcome_unknown" };
    }
    if (existing.state !== "not_attempted" || last.receipt?.state !== "not_attempted" || last.receipt.retryable !== true) {
      return { state: "unknown", binding: existing, reason: "retry_not_proven_safe" };
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

  const attempts = {
    prepare: async (command: IntegratorAttemptPrepareCommand) => {
      if (command.attemptId !== request.attemptId) throw new Error("integrator_session_admission_operation_mismatch");
      const reserved = await store.reserve({
        operationId: command.attemptId,
        hostId: command.hostId,
        harness: command.harness as IntegratorHarness,
        ...(expectedPriorAttempt ? { expectedPriorAttempt } : {}),
      });
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
    let uncertain: IntegratorOperationBinding | null;
    try { uncertain = await store.get(request.attemptId); }
    catch { uncertain = null; }
    return { state: "unknown", binding: uncertain, reason: "admission_or_journal_response_uncertain" };
  }

  let binding: IntegratorOperationBinding | null;
  try {
    binding = await store.get(request.attemptId);
  } catch {
    return { state: "unknown", binding: null, reason: "binding_read_uncertain", admission };
  }
  if (!binding) {
    if (admission.state === "ineligible" || admission.state === "not_admitted") return { state: "not_admitted", binding: null, admission };
    return { state: "unknown", binding: null, reason: "journal_binding_absent_after_admission", admission };
  }

  const finalAttempt = binding.attempts.at(-1)!;
  if (binding.state === "accepted" && finalAttempt.address) {
    return { state: "accepted", binding, address: finalAttempt.address, admission };
  }
  if (admission.state === "unknown") {
    return { state: "unknown", binding, reason: admission.receipt?.reason ?? "admission_outcome_unknown", admission };
  }
  if (binding.state === "not_attempted" && finalAttempt.receipt?.retryable === true) {
    return { state: "not_attempted", binding, admission };
  }
  return { state: "unknown", binding, reason: binding.state === "unknown" ? "attempt_outcome_unknown" : "intent_unresolved", admission };
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
