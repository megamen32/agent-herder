import { posix, win32 } from "node:path";
import type { FleetCreateReceipt, FleetHarness, FleetHost, FleetView } from "./mesh/fleet-contract.js";
import { resolveProjectExecutionScope, type ProjectExecutionBinding, type TrustedRuntimeOwnerResolver } from "./project-execution-scope.js";

const MAX_READINESS_AGE_MS = 30_000;
export const INTEGRATOR_HOST_MODEL = "gpt-6-luna" as const;

export interface HostPathResolution {
  pathFlavor: "posix" | "win32";
  requestedCheckoutRoot: string;
  requestedCwd: string;
  canonicalCheckoutRoot: string;
  canonicalCwd: string;
  canonicalRootIdentity: string;
  /** Explicit host-owner attestations for requested-path to canonical-path identity. */
  checkoutRootEquivalent: boolean;
  cwdEquivalent: boolean;
  /** Host-owner realpath check, independently checked against canonical paths below. */
  cwdWithinCheckoutRoot: boolean;
}

export interface IntegratorHostRequest {
  projectId: string;
  rootIdentity: string;
  policyRevision: string;
  attemptId: string;
  checkoutRoot: string;
  harness: FleetHarness;
  harnessVersion: string;
  requiredTools: readonly string[];
  name: string;
  cwd: string;
  inputId: string;
  model: string;
}

/**
 * Additional facts absent from FleetHost's discovery DTO must come from a
 * trusted host-owned readiness adapter. The FleetHost itself is retained and
 * checked against the current discovery receipt before any admission call.
 */
export interface IntegratorHostReadiness {
  host: FleetHost;
  observedAtMs: number;
  checkoutRoot: string;
  pathResolution: HostPathResolution;
  harness: FleetHarness;
  harnessVersion: string;
  availableTools: readonly string[];
  availableModels: readonly string[];
  resourceReady: boolean;
  runtimeInstanceId: string;
}

export interface IntegratorCreateCommand {
  hostId: string;
  harness: string;
  checkoutRoot: string;
  cwd: string;
  requestedCheckoutRoot: string;
  requestedCwd: string;
  rootIdentity: string;
  name: string;
  inputId: string;
  attemptId: string;
  executionBinding: ProjectExecutionBinding;
  model: typeof INTEGRATOR_HOST_MODEL;
}

export type IntegratorAttemptPrepareCommand = Omit<IntegratorCreateCommand, "inputId">;
export type IntegratorPreparedCreateCommand = IntegratorCreateCommand & { attemptOrdinal: number };

export interface IntegratorAttemptPreparation {
  claimed: boolean;
  inputId: string;
  attemptOrdinal: number;
  existingReceipt?: FleetCreateReceipt;
  reason?: string;
}

/** Trusted durable H34 attempt journal; operation identity is command.attemptId. */
export interface IntegratorSessionAttemptsPort {
  prepare(command: IntegratorAttemptPrepareCommand): Promise<IntegratorAttemptPreparation>;
  record(command: IntegratorPreparedCreateCommand, receipt: FleetCreateReceipt): Promise<void>;
}

export interface IntegratorHostPorts {
  now(): number;
  discovery: { snapshot(options: { refresh: true }): Promise<FleetView> };
  readiness: { observe(host: FleetHost, request: IntegratorHostRequest): Promise<unknown> };
  /** Must be resolved from the runtime owner, never from caller/model fields. */
  runtimeOwner: TrustedRuntimeOwnerResolver;
  admission: { create(command: IntegratorCreateCommand): Promise<FleetCreateReceipt> };
  /** Optional only for the trusted H34 composition; unbound H33 stays unregistered. */
  attempts?: IntegratorSessionAttemptsPort;
}

export type IntegratorHostAdmissionResult =
  | { state: "created"; receipt: FleetCreateReceipt; attemptId: string; hostId: string }
  | { state: "unknown"; receipt?: FleetCreateReceipt; inputId?: string; reason: string; attemptId: string; hostId: string }
  | { state: "deferred"; receipt?: FleetCreateReceipt; inputId: string; reason: string; attemptId: string; hostId: string }
  | { state: "not_admitted"; reason: string; attemptId: string; attemptedHostIds: string[] }
  | { state: "ineligible"; reason: string; attemptId: string; attemptedHostIds: [] };

/**
 * Selects from current owner discovery, then admits at most twice. A second
 * host is considered only after an explicit retryable `not_attempted` receipt.
 * Accepted, unknown, invalid or lost responses return immediately. This is a
 * source contract seam; it neither launches a runtime nor wires production.
 */
export async function admitIntegratorSession(
  request: IntegratorHostRequest,
  ports: IntegratorHostPorts,
): Promise<IntegratorHostAdmissionResult> {
  if (!validRequest(request)) return { state: "ineligible", reason: "request_invalid", attemptId: request.attemptId, attemptedHostIds: [] };

  let view: FleetView;
  try {
    view = await ports.discovery.snapshot({ refresh: true });
  } catch {
    return { state: "ineligible", reason: "host_discovery_unavailable", attemptId: request.attemptId, attemptedHostIds: [] };
  }
  if (!isDiscovery(view)) return { state: "ineligible", reason: "host_discovery_invalid", attemptId: request.attemptId, attemptedHostIds: [] };

  const candidates: Array<{ host: FleetHost; binding: ProjectExecutionBinding; pathResolution: HostPathResolution }> = [];
  for (const host of view.hosts) {
    if (host.state !== "ready" || host.expiresAt === null || host.expiresAt <= ports.now()
      || host.fetchedAt === null || host.fetchedAt > ports.now() || ports.now() - host.fetchedAt > MAX_READINESS_AGE_MS
      || !host.createHarnesses.includes(request.harness)) continue;
    let observation: unknown;
    try { observation = await ports.readiness.observe(host, request); } catch { continue; }
    if (!isReadiness(observation, host, request, ports.now())) continue;

    const binding: ProjectExecutionBinding = {
      projectId: request.projectId,
      rootIdentity: request.rootIdentity,
      policyRevision: request.policyRevision,
      attemptId: request.attemptId,
      hostId: host.hostId,
      runtimeInstanceId: observation.runtimeInstanceId,
    };
    const scope = await resolveProjectExecutionScope(binding, ports.runtimeOwner);
    if (!scope.eligible) continue;
    candidates.push({ host, binding, pathResolution: observation.pathResolution });
  }
  if (candidates.length === 0) return { state: "ineligible", reason: "no_compatible_ready_host", attemptId: request.attemptId, attemptedHostIds: [] };

  const attemptedHostIds: string[] = [];
  for (const candidate of candidates.slice(0, 2)) {
    if (candidate.host.state !== "ready" || candidate.host.expiresAt === null || candidate.host.expiresAt <= ports.now()) continue;
    let currentObservation: unknown;
    try { currentObservation = await ports.readiness.observe(candidate.host, request); } catch { continue; }
    if (!isReadiness(currentObservation, candidate.host, request, ports.now(), candidate.binding)
      || !samePathResolution(currentObservation.pathResolution, candidate.pathResolution)) continue;
    const currentScope = await resolveProjectExecutionScope(candidate.binding, ports.runtimeOwner);
    if (!currentScope.eligible) continue;

    const attemptCommand: IntegratorAttemptPrepareCommand = {
      hostId: candidate.host.hostId,
      harness: request.harness,
      checkoutRoot: candidate.pathResolution.canonicalCheckoutRoot,
      cwd: candidate.pathResolution.canonicalCwd,
      requestedCheckoutRoot: request.checkoutRoot,
      requestedCwd: request.cwd,
      rootIdentity: candidate.pathResolution.canonicalRootIdentity,
      name: request.name,
      attemptId: request.attemptId,
      executionBinding: candidate.binding,
      model: INTEGRATOR_HOST_MODEL,
    };

    let createCommand: IntegratorCreateCommand;
    let preparedCommand: IntegratorPreparedCreateCommand | undefined;
    if (ports.attempts) {
      let preparation: IntegratorAttemptPreparation;
      try {
        preparation = await ports.attempts.prepare(attemptCommand);
      } catch {
        return { state: "unknown", reason: "attempt_prepare_failed", attemptId: request.attemptId, hostId: candidate.host.hostId };
      }
      if (!validPreparation(preparation)) {
        return {
          state: "unknown",
          reason: "attempt_prepare_result_invalid",
          attemptId: request.attemptId,
          hostId: candidate.host.hostId,
        };
      }
      if (preparation.inputId === request.inputId) {
        return { state: "unknown", inputId: preparation.inputId, reason: "attempt_input_id_alias", attemptId: request.attemptId, hostId: candidate.host.hostId };
      }
      if (!preparation.claimed) {
        if (preparation.existingReceipt && !isReceipt(preparation.existingReceipt, preparation.inputId)) {
          return { state: "unknown", inputId: preparation.inputId, reason: "attempt_existing_receipt_invalid", attemptId: request.attemptId, hostId: candidate.host.hostId };
        }
        return {
          state: "deferred",
          ...(preparation.existingReceipt ? { receipt: preparation.existingReceipt } : {}),
          inputId: preparation.inputId,
          reason: preparation.reason ?? "durable_attempt_not_claimed",
          attemptId: request.attemptId,
          hostId: candidate.host.hostId,
        };
      }
      createCommand = { ...attemptCommand, inputId: preparation.inputId };
      preparedCommand = { ...createCommand, attemptOrdinal: preparation.attemptOrdinal };
    } else {
      createCommand = { ...attemptCommand, inputId: request.inputId };
    }

    attemptedHostIds.push(candidate.host.hostId);
    let receipt: FleetCreateReceipt;
    try {
      receipt = await ports.admission.create(createCommand);
    } catch {
      const unknown = unknownReceipt(createCommand.inputId, "admission_response_lost");
      if (preparedCommand && ports.attempts) {
        try { await ports.attempts.record(preparedCommand, unknown); }
        catch { return { state: "unknown", receipt: unknown, reason: "attempt_record_uncertain", attemptId: request.attemptId, hostId: candidate.host.hostId }; }
      }
      return { state: "unknown", receipt: unknown, reason: unknown.reason!, attemptId: request.attemptId, hostId: candidate.host.hostId };
    }

    if (!isReceipt(receipt, createCommand.inputId)) {
      return { state: "unknown", reason: "admission_receipt_invalid_or_input_id_mismatch", attemptId: request.attemptId, hostId: candidate.host.hostId };
    }
    if (preparedCommand && ports.attempts) {
      try { await ports.attempts.record(preparedCommand, receipt); }
      catch { return { state: "unknown", receipt, reason: "attempt_record_uncertain", attemptId: request.attemptId, hostId: candidate.host.hostId }; }
    }
    if (receipt.state === "created") {
      if (!receipt.address || receipt.address.hostId !== candidate.host.hostId || receipt.address.harness !== request.harness
        || typeof receipt.address.nativeSessionId !== "string" || !receipt.address.nativeSessionId.trim()
        || receipt.address.nativeSessionId.length > 512 || /[\x00-\x1f\x7f]/.test(receipt.address.nativeSessionId)) {
        return { state: "unknown", receipt, reason: "admission_address_mismatch", attemptId: request.attemptId, hostId: candidate.host.hostId };
      }
      return { state: "created", receipt, attemptId: request.attemptId, hostId: candidate.host.hostId };
    }
    if (receipt.state === "unknown") return { state: "unknown", receipt, reason: receipt.reason ?? "admission_outcome_unknown", attemptId: request.attemptId, hostId: candidate.host.hostId };
    if (!receipt.retryable || !receipt.reason || receipt.state !== "not_attempted") {
      return { state: "not_admitted", reason: receipt.reason ?? "pre_admission_refusal_not_retryable", attemptId: request.attemptId, attemptedHostIds };
    }
    if (attemptedHostIds.length === 2 || candidates.length < 2) {
      return { state: "not_admitted", reason: receipt.reason, attemptId: request.attemptId, attemptedHostIds };
    }
  }
  if (attemptedHostIds.length === 0) return { state: "ineligible", reason: "no_compatible_ready_host", attemptId: request.attemptId, attemptedHostIds: [] };
  return { state: "not_admitted", reason: "no_secondary_compatible_host", attemptId: request.attemptId, attemptedHostIds };
}

function validRequest(value: IntegratorHostRequest): boolean {
  return !!value && [value.projectId, value.rootIdentity, value.policyRevision, value.attemptId,
    value.checkoutRoot, value.harness, value.harnessVersion, value.name, value.cwd, value.inputId, value.model]
    .every(part => typeof part === "string" && part.trim().length > 0)
    && Array.isArray(value.requiredTools) && value.requiredTools.length > 0
    && value.requiredTools.every(tool => typeof tool === "string" && tool.trim().length > 0)
    && value.model === INTEGRATOR_HOST_MODEL;
}

function isDiscovery(value: unknown): value is FleetView {
  if (!value || typeof value !== "object") return false;
  const view = value as FleetView;
  return Array.isArray(view.hosts) && view.hosts.length <= 5
    && new Set(view.hosts.map(host => host?.hostId)).size === view.hosts.length
    && view.hosts.every(host => !!host && typeof host.hostId === "string" && host.hostId.trim().length > 0
      && typeof host.label === "string"
      && ["ready", "metadata_only", "offline", "unavailable", "stale"].includes(host.state)
      && (host.expiresAt === null || Number.isFinite(host.expiresAt))
      && (host.fetchedAt === null || Number.isFinite(host.fetchedAt))
      && (host.generation === null || Number.isSafeInteger(host.generation))
      && Array.isArray(host.createHarnesses)
      && host.createHarnesses.every(harness => ["codex", "zcode", "opencode"].includes(harness)));
}

function isReadiness(
  value: unknown,
  host: FleetHost,
  request: IntegratorHostRequest,
  now: number,
  binding?: ProjectExecutionBinding,
): value is IntegratorHostReadiness {
  if (!value || typeof value !== "object") return false;
  const receipt = value as IntegratorHostReadiness;
  return !!receipt.host && receipt.host.hostId === host.hostId
    && receipt.host.state === host.state && receipt.host.expiresAt === host.expiresAt
    && receipt.host.fetchedAt === host.fetchedAt && receipt.host.generation === host.generation
    && Array.isArray(receipt.host.createHarnesses) && receipt.host.createHarnesses.includes(request.harness)
    && Number.isFinite(receipt.observedAtMs) && receipt.observedAtMs <= now && now - receipt.observedAtMs <= MAX_READINESS_AGE_MS
    && receipt.checkoutRoot === request.checkoutRoot && validPathResolution(receipt.pathResolution, request)
    && receipt.harness === request.harness
    && receipt.harnessVersion === request.harnessVersion && receipt.resourceReady === true
    && Array.isArray(receipt.availableTools) && request.requiredTools.every(tool => receipt.availableTools.includes(tool))
    && Array.isArray(receipt.availableModels) && receipt.availableModels.includes(INTEGRATOR_HOST_MODEL)
    && typeof receipt.runtimeInstanceId === "string" && receipt.runtimeInstanceId.trim().length > 0
    && (binding === undefined || receipt.runtimeInstanceId === binding.runtimeInstanceId);
}

function validPathResolution(value: unknown, request: IntegratorHostRequest): value is HostPathResolution {
  if (!value || typeof value !== "object") return false;
  const resolution = value as HostPathResolution;
  if ((resolution.pathFlavor !== "posix" && resolution.pathFlavor !== "win32")
    || resolution.requestedCheckoutRoot !== request.checkoutRoot
    || resolution.requestedCwd !== request.cwd
    || resolution.checkoutRootEquivalent !== true || resolution.cwdEquivalent !== true
    || resolution.cwdWithinCheckoutRoot !== true
    || resolution.canonicalRootIdentity !== request.rootIdentity) return false;

  const pathApi = resolution.pathFlavor === "posix" ? posix : win32;
  if (!normalizedAbsolute(pathApi, resolution.canonicalCheckoutRoot)
    || !normalizedAbsolute(pathApi, resolution.canonicalCwd)) return false;
  const relative = pathApi.relative(resolution.canonicalCheckoutRoot, resolution.canonicalCwd);
  return relative === "" || (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`));
}

function normalizedAbsolute(pathApi: typeof posix, value: unknown): value is string;
function normalizedAbsolute(pathApi: typeof win32, value: unknown): value is string;
function normalizedAbsolute(pathApi: typeof posix | typeof win32, value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)
    && pathApi.isAbsolute(value) && pathApi.normalize(value) === value;
}

function samePathResolution(left: HostPathResolution, right: HostPathResolution): boolean {
  return left.pathFlavor === right.pathFlavor
    && left.requestedCheckoutRoot === right.requestedCheckoutRoot && left.requestedCwd === right.requestedCwd
    && left.canonicalCheckoutRoot === right.canonicalCheckoutRoot && left.canonicalCwd === right.canonicalCwd
    && left.canonicalRootIdentity === right.canonicalRootIdentity
    && left.checkoutRootEquivalent === right.checkoutRootEquivalent && left.cwdEquivalent === right.cwdEquivalent
    && left.cwdWithinCheckoutRoot === right.cwdWithinCheckoutRoot;
}

function isReceipt(value: unknown, inputId: string): value is FleetCreateReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as FleetCreateReceipt;
  return receipt.inputId === inputId && ["created", "unknown", "not_attempted"].includes(receipt.state)
    && typeof receipt.retryable === "boolean"
    && (receipt.reason === undefined || typeof receipt.reason === "string");
}

function validPreparation(value: unknown): value is IntegratorAttemptPreparation {
  if (!value || typeof value !== "object") return false;
  const preparation = value as IntegratorAttemptPreparation;
  return typeof preparation.claimed === "boolean"
    && validText(preparation.inputId)
    && Number.isSafeInteger(preparation.attemptOrdinal) && preparation.attemptOrdinal > 0
    && (preparation.reason === undefined || typeof preparation.reason === "string" && preparation.reason.trim().length > 0)
    && (preparation.existingReceipt === undefined || !preparation.claimed && isReceipt(preparation.existingReceipt, preparation.inputId));
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

function unknownReceipt(inputId: string, reason: string): FleetCreateReceipt {
  return { state: "unknown", inputId, retryable: false, reason };
}
