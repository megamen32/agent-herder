import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { FleetCreateReceipt, FleetCreateRequest } from "./mesh/fleet-contract.js";

export type IntegratorLaunchState = "intent" | "accepted" | "unknown" | "not_attempted";

export type IntegratorNativeAddress = NonNullable<FleetCreateReceipt["address"]>;
export type IntegratorHarness = FleetCreateRequest["harness"];

export interface IntegratorLaunchCheckpoint {
  sequence: number;
  cursor: string;
}

/** Receipt shape returned by the existing fleet owner create seam. */
export type IntegratorLaunchReceipt = FleetCreateReceipt;

export interface IntegratorLaunchAttempt {
  attempt: number;
  inputId: string;
  /** Host is immutable for this launch attempt; a retryable refusal may select another host. */
  hostId: string;
  state: IntegratorLaunchState;
  startedAt: string;
  updatedAt: string;
  address?: IntegratorNativeAddress;
  checkpoint?: IntegratorLaunchCheckpoint;
  receipt?: IntegratorLaunchReceipt;
}

export interface IntegratorOperationBinding {
  operationId: string;
  /** Harness is pinned for the whole operation, including host fallback. */
  harness: IntegratorHarness;
  state: IntegratorLaunchState;
  attempts: IntegratorLaunchAttempt[];
}

interface BindingFile {
  version: 2;
  operations: Record<string, IntegratorOperationBinding>;
}

interface LegacyIntegratorOperationBinding extends Omit<IntegratorOperationBinding, "attempts"> {
  hostId: string;
  attempts: Array<Omit<IntegratorLaunchAttempt, "hostId">>;
}

interface LegacyBindingFile {
  version: 1;
  operations: Record<string, LegacyIntegratorOperationBinding>;
}

export interface IntegratorSessionBindingStoreOptions {
  persistencePath: string;
}

export type ReserveIntegratorAttemptResult = {
  claimed: boolean;
  binding: IntegratorOperationBinding;
  attempt: IntegratorLaunchAttempt;
};

export interface ExpectedPriorIntegratorAttempt {
  attempt: number;
  inputId: string;
  hostId: string;
}

const maxText = 512;

function requiredText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxText || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`integrator_session_binding_invalid_${field}`);
  }
}

function validAddress(value: IntegratorNativeAddress): IntegratorNativeAddress {
  requiredText(value?.hostId, "host_id");
  requiredText(value?.harness, "harness");
  requiredText(value?.nativeSessionId, "native_session_id");
  return { hostId: value.hostId, harness: value.harness, nativeSessionId: value.nativeSessionId };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function attemptInputId(operationId: string, attempt: number): string {
  return createHash("sha256").update(JSON.stringify(["integrator-session-binding", operationId, attempt])).digest("hex");
}

function stateOfReceipt(receipt: IntegratorLaunchReceipt): Exclude<IntegratorLaunchState, "intent"> {
  if (receipt.state === "created") return "accepted";
  // FleetCreateJournal returns this when the exact once-key is still owned by
  // a live request. It does not prove that the operation was not attempted.
  if (receipt.state === "unknown" || receipt.reason === "fleet_create_busy") return "unknown";
  return "not_attempted";
}

function validateReceipt(receipt: IntegratorLaunchReceipt): IntegratorLaunchReceipt {
  if (!receipt || !["created", "unknown", "not_attempted"].includes(receipt.state)) {
    throw new Error("integrator_session_binding_invalid_receipt_state");
  }
  requiredText(receipt.inputId, "receipt_input_id");
  if (typeof receipt.retryable !== "boolean") throw new Error("integrator_session_binding_invalid_receipt_retryable");
  if (receipt.reason !== undefined) requiredText(receipt.reason, "receipt_reason");
  if (receipt.launchCwd !== undefined) requiredText(receipt.launchCwd, "receipt_launch_cwd");
  if (receipt.address !== undefined) validAddress(receipt.address);
  if (receipt.state === "created" && !receipt.address) throw new Error("integrator_session_binding_accepted_address_required");
  if (receipt.state === "not_attempted" && receipt.address) throw new Error("integrator_session_binding_not_attempted_address_forbidden");
  return clone(receipt);
}

function validateBinding(binding: IntegratorOperationBinding): IntegratorOperationBinding {
  requiredText(binding?.operationId, "operation_id");
  requiredText(binding?.harness, "harness");
  if (!Array.isArray(binding.attempts) || binding.attempts.length === 0) throw new Error("integrator_session_binding_invalid_attempts");
  binding.attempts.forEach((attempt, index) => {
    if (attempt.attempt !== index + 1 || attempt.inputId !== attemptInputId(binding.operationId, attempt.attempt)
      || !["intent", "accepted", "unknown", "not_attempted"].includes(attempt.state)) {
      throw new Error("integrator_session_binding_invalid_attempt");
    }
    requiredText(attempt.hostId, "attempt_host_id");
    if (!Number.isFinite(Date.parse(attempt.startedAt)) || !Number.isFinite(Date.parse(attempt.updatedAt))) {
      throw new Error("integrator_session_binding_invalid_attempt_time");
    }
    if (attempt.address) {
      const address = validAddress(attempt.address);
      if (address.hostId !== attempt.hostId || address.harness !== binding.harness) {
        throw new Error("integrator_session_binding_address_conflict");
      }
    }
    if (attempt.checkpoint) {
      if (!Number.isSafeInteger(attempt.checkpoint.sequence) || attempt.checkpoint.sequence < 0) throw new Error("integrator_session_binding_invalid_checkpoint");
      requiredText(attempt.checkpoint.cursor, "checkpoint_cursor");
    }
    if (attempt.receipt) {
      const receipt = validateReceipt(attempt.receipt);
      const outcome = stateOfReceipt(receipt);
      if (attempt.state !== outcome) throw new Error("integrator_session_binding_receipt_state_mismatch");
      if (receipt.address && JSON.stringify(receipt.address) !== JSON.stringify(attempt.address)) {
        throw new Error("integrator_session_binding_receipt_address_mismatch");
      }
    } else if (attempt.state !== "intent") throw new Error("integrator_session_binding_receipt_missing");
    if (index < binding.attempts.length - 1
      && (attempt.state !== "not_attempted" || attempt.receipt?.retryable !== true || attempt.address)) {
      throw new Error("integrator_session_binding_prior_attempt_not_retryable");
    }
  });
  if (binding.state !== binding.attempts[binding.attempts.length - 1]!.state) throw new Error("integrator_session_binding_state_mismatch");
  return clone(binding);
}

/**
 * Durable, file-backed intent and session binding for one integrator operation.
 * This store records evidence only; callers own native launch and reconciliation.
 */
export class IntegratorSessionBindingStore {
  private readonly lockPath: string;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: IntegratorSessionBindingStoreOptions) {
    requiredText(options.persistencePath, "persistence_path");
    this.lockPath = `${options.persistencePath}.lock`;
  }

  async get(operationId: string): Promise<IntegratorOperationBinding | null> {
    requiredText(operationId, "operation_id");
    return this.inProcess(async () => {
      const binding = (await this.read()).operations[operationId];
      return binding ? validateBinding(binding) : null;
    });
  }

  /** Persist intent before native launch. Only `claimed: true` may call an owner seam. */
  async reserve(input: {
    operationId: string;
    hostId: string;
    harness: IntegratorHarness;
    /** Snapshot identity required to advance an existing retryable refusal. */
    expectedPriorAttempt?: ExpectedPriorIntegratorAttempt;
  }): Promise<ReserveIntegratorAttemptResult> {
    requiredText(input.operationId, "operation_id");
    requiredText(input.hostId, "host_id");
    requiredText(input.harness, "harness");
    return this.inProcess(() => this.withLock(async () => {
      const file = await this.read();
      const existing = file.operations[input.operationId];
      if (existing) {
        if (existing.harness !== input.harness) {
          throw new Error("integrator_session_binding_operation_conflict");
        }
        const binding = validateBinding(existing);
        const previousAttempt = binding.attempts[binding.attempts.length - 1]!;
        const expected = input.expectedPriorAttempt;
        const snapshotMatches = expected !== undefined
          && expected.attempt === previousAttempt.attempt
          && expected.inputId === previousAttempt.inputId
          && expected.hostId === previousAttempt.hostId;
        if (!snapshotMatches || binding.state !== "not_attempted" || previousAttempt.state !== "not_attempted"
          || previousAttempt.receipt?.state !== "not_attempted" || previousAttempt.receipt.retryable !== true
          || input.hostId === previousAttempt.hostId) {
          return { claimed: false, binding, attempt: clone(previousAttempt) };
        }
        const now = new Date().toISOString();
        const attempt = binding.attempts.length + 1;
        const next: IntegratorLaunchAttempt = {
          attempt, inputId: attemptInputId(input.operationId, attempt), hostId: input.hostId,
          state: "intent", startedAt: now, updatedAt: now,
        };
        binding.attempts.push(next);
        binding.state = "intent";
        file.operations[input.operationId] = binding;
        await this.write(file);
        return { claimed: true, binding: clone(binding), attempt: clone(next) };
      }
      if (input.expectedPriorAttempt !== undefined) throw new Error("integrator_session_binding_prior_attempt_missing");
      const now = new Date().toISOString();
      const binding: IntegratorOperationBinding = {
        operationId: input.operationId,
        harness: input.harness,
        state: "intent",
        attempts: [{ attempt: 1, inputId: attemptInputId(input.operationId, 1), hostId: input.hostId,
          state: "intent", startedAt: now, updatedAt: now }],
      };
      file.operations[input.operationId] = binding;
      await this.write(file);
      return { claimed: true, binding: clone(binding), attempt: clone(binding.attempts[0]!) };
    }));
  }

  /** Record the returned launch receipt. Unknown is durable and never becomes refusal by inference. */
  async record(input: {
    operationId: string;
    attempt: number;
    receipt: IntegratorLaunchReceipt;
    checkpoint?: IntegratorLaunchCheckpoint;
  }): Promise<IntegratorOperationBinding> {
    requiredText(input.operationId, "operation_id");
    const receipt = validateReceipt(input.receipt);
    const outcome = stateOfReceipt(receipt);
    if (input.checkpoint) {
      if (!Number.isSafeInteger(input.checkpoint.sequence) || input.checkpoint.sequence < 0) throw new Error("integrator_session_binding_invalid_checkpoint");
      requiredText(input.checkpoint.cursor, "checkpoint_cursor");
    }
    return this.inProcess(() => this.withLock(async () => {
      const file = await this.read();
      const binding = file.operations[input.operationId];
      if (!binding) throw new Error("integrator_session_binding_intent_missing");
      const index = input.attempt - 1;
      const attempt = binding.attempts[index];
      if (!attempt || attempt.attempt !== input.attempt) throw new Error("integrator_session_binding_attempt_missing");
      if (attempt.state !== "intent" && attempt.state !== "unknown") {
        if (attempt.state === outcome && JSON.stringify(attempt.receipt) === JSON.stringify(receipt)) return clone(validateBinding(binding));
        throw new Error("integrator_session_binding_attempt_terminal");
      }
      if (receipt.inputId !== attempt.inputId) throw new Error("integrator_session_binding_receipt_input_conflict");
      const address = receipt.address ? validAddress(receipt.address) : undefined;
      if (address && (address.hostId !== attempt.hostId || address.harness !== binding.harness)) {
        throw new Error("integrator_session_binding_address_conflict");
      }
      if (attempt.address && address && attempt.address.nativeSessionId !== address.nativeSessionId) {
        throw new Error("integrator_session_binding_session_conflict");
      }
      if (outcome === "not_attempted" && attempt.address) throw new Error("integrator_session_binding_not_attempted_session_conflict");
      if (attempt.checkpoint && input.checkpoint && input.checkpoint.sequence < attempt.checkpoint.sequence) {
        throw new Error("integrator_session_binding_checkpoint_regression");
      }
      if (attempt.checkpoint && input.checkpoint && input.checkpoint.sequence === attempt.checkpoint.sequence
        && input.checkpoint.cursor !== attempt.checkpoint.cursor) throw new Error("integrator_session_binding_checkpoint_conflict");
      attempt.state = outcome;
      attempt.updatedAt = new Date().toISOString();
      attempt.address ??= address;
      attempt.checkpoint = input.checkpoint ? clone(input.checkpoint) : attempt.checkpoint;
      attempt.receipt = receipt;
      binding.state = outcome;
      file.operations[input.operationId] = validateBinding(binding);
      await this.write(file);
      return clone(file.operations[input.operationId]!);
    }));
  }

  /** Persist a monotonic checkpoint without changing the launch outcome. */
  async checkpoint(input: { operationId: string; attempt: number; checkpoint: IntegratorLaunchCheckpoint }): Promise<IntegratorOperationBinding> {
    requiredText(input.operationId, "operation_id");
    if (!Number.isSafeInteger(input.checkpoint.sequence) || input.checkpoint.sequence < 0) throw new Error("integrator_session_binding_invalid_checkpoint");
    requiredText(input.checkpoint.cursor, "checkpoint_cursor");
    return this.inProcess(() => this.withLock(async () => {
      const file = await this.read();
      const binding = file.operations[input.operationId];
      const attempt = binding?.attempts[input.attempt - 1];
      if (!binding || !attempt) throw new Error("integrator_session_binding_attempt_missing");
      if (attempt.state !== "intent" && attempt.state !== "unknown") throw new Error("integrator_session_binding_checkpoint_terminal");
      if (attempt.checkpoint && input.checkpoint.sequence < attempt.checkpoint.sequence) throw new Error("integrator_session_binding_checkpoint_regression");
      if (attempt.checkpoint && input.checkpoint.sequence === attempt.checkpoint.sequence && input.checkpoint.cursor !== attempt.checkpoint.cursor) {
        throw new Error("integrator_session_binding_checkpoint_conflict");
      }
      attempt.checkpoint = clone(input.checkpoint);
      attempt.updatedAt = new Date().toISOString();
      file.operations[input.operationId] = validateBinding(binding);
      await this.write(file);
      return clone(file.operations[input.operationId]!);
    }));
  }

  /** Apply evidence from the owning native API's reconciliation read to an unknown attempt. */
  async reconcile(input: {
    operationId: string;
    attempt: number;
    receipt: IntegratorLaunchReceipt;
    checkpoint?: IntegratorLaunchCheckpoint;
  }): Promise<IntegratorOperationBinding> {
    const current = await this.get(input.operationId);
    const attempt = current?.attempts[input.attempt - 1];
    if (!attempt || (attempt.state !== "intent" && attempt.state !== "unknown")) throw new Error("integrator_session_binding_uncertain_attempt_required");
    if (stateOfReceipt(input.receipt) === "unknown") return this.record(input);
    return this.record(input);
  }

  private async read(): Promise<BindingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.options.persistencePath, "utf8")) as BindingFile | LegacyBindingFile;
      if (parsed.version === 1) return this.migrateLegacy(parsed);
      if (parsed.version !== 2 || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
        throw new Error("integrator_session_binding_store_invalid");
      }
      for (const [key, binding] of Object.entries(parsed.operations)) {
        const checked = validateBinding(binding);
        if (checked.operationId !== key) throw new Error("integrator_session_binding_key_mismatch");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, operations: {} };
      throw error;
    }
  }

  /** Preserve v1 receipt/input IDs verbatim while assigning their historical host to each attempt. */
  private migrateLegacy(file: LegacyBindingFile): BindingFile {
    if (!file.operations || typeof file.operations !== "object" || Array.isArray(file.operations)) {
      throw new Error("integrator_session_binding_store_invalid");
    }
    const operations: Record<string, IntegratorOperationBinding> = {};
    for (const [key, legacy] of Object.entries(file.operations)) {
      requiredText(legacy.hostId, "legacy_host_id");
      const binding: IntegratorOperationBinding = {
        operationId: legacy.operationId,
        harness: legacy.harness,
        state: legacy.state,
        attempts: legacy.attempts.map(attempt => ({ ...attempt, hostId: legacy.hostId })),
      };
      const checked = validateBinding(binding);
      if (checked.operationId !== key) throw new Error("integrator_session_binding_key_mismatch");
      operations[key] = checked;
    }
    return { version: 2, operations };
  }

  private async write(file: BindingFile): Promise<void> {
    file.version = 2;
    await mkdir(dirname(this.options.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.persistencePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.options.persistencePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async inProcess<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.options.persistencePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.lockPath, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(this.lockPath, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}
