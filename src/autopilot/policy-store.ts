import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
  normalizeAutopilotPolicy,
  resolveEffectivePolicy,
  type AutopilotPolicy,
  type EffectivePolicy,
  type PersistedAutopilotPolicy,
} from "./policy.js";

export type PolicyLoadResult =
  | { kind: "absent" }
  | { kind: "valid"; state: PersistedAutopilotPolicy }
  | { kind: "invalid"; error: string };

export type AutopilotPolicyStoreOptions = {
  syncParentDirectory?: (directory: string) => Promise<void>;
};

/** Resolve the one durable policy path shared by the Stop hook and web service. */
export function resolveAutopilotPolicyStorePath(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.AGENT_HERDER_AUTOPILOT_POLICY_STORE?.trim();
  return configured || join(stateDir, "autopilot-policy.json");
}

export type DurablePolicyWriteResult = EffectivePolicy & {
  writeStatus: "durable";
};

export type DurabilityUncertainAppliedPolicyWriteResult = EffectivePolicy & {
  writeStatus: "durability_uncertain_applied";
  writtenRevision: string;
  readBack: EffectivePolicy;
  durabilityError: string;
};

export type PolicyWriteResult =
  | DurablePolicyWriteResult
  | DurabilityUncertainAppliedPolicyWriteResult;

type PolicyWriteAttempt =
  | { kind: "durable" }
  | { kind: "durability_uncertain"; error: Error };

/** Report a rejected compare-and-swap rather than silently overwriting another update. */
export class AutopilotPolicyRevisionConflictError extends Error {
  readonly code = "AUTOPILOT_POLICY_REVISION_CONFLICT";

  constructor(readonly expectedRevision: string | null, readonly currentRevision: string | null) {
    super(`Autopilot policy revision conflict: expected ${expectedRevision ?? "absent"}, current ${currentRevision ?? "absent"}`);
    this.name = "AutopilotPolicyRevisionConflictError";
  }
}

/** Persist and resolve the versioned policy without adding hook or web-server behavior. */
export class AutopilotPolicyStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;
  private readonly syncParentDirectory: (directory: string) => Promise<void>;

  constructor(private readonly path: string, options: AutopilotPolicyStoreOptions = {}) {
    this.lockTarget = `${path}.lock`;
    this.syncParentDirectory = options.syncParentDirectory ?? syncParentDirectory;
  }

  /** Read the durable snapshot while retaining malformed-state evidence for a fail-closed caller. */
  async load(): Promise<PolicyLoadResult> {
    try {
      return { kind: "valid", state: parseState(JSON.parse(await readFile(this.path, "utf8")) as unknown) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "invalid", error: (error as Error).message };
    }
  }

  /** Resolve persisted policy over legacy environment, or fail closed on corrupt state. */
  async readEffective(env: NodeJS.ProcessEnv = process.env): Promise<EffectivePolicy> {
    const loaded = await this.load();
    return resolveEffectivePolicy({
      env,
      ...(loaded.kind === "valid" ? { state: loaded.state } : {}),
      ...(loaded.kind === "invalid" ? { stateError: loaded.error } : {}),
    });
  }

  /**
   * Hold the same interprocess mutation fence used by policy replacement.
   *
   * The caller may read policy, validate a timeout target, and durably claim
   * dispatch while this fence is held, so a concurrent policy update cannot
   * authorize a stale continuation between those steps.
   */
  async withMutationFence<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial(() => this.withFileLock(operation));
  }

  /** Atomically replace a valid policy and distinguish durable acknowledgement from post-rename uncertainty. */
  async replacePolicy(next: AutopilotPolicy, expectedRevision: string | null): Promise<PolicyWriteResult> {
    const policy = normalizeAutopilotPolicy(next);
    return this.withMutationFence(async () => {
      const loaded = await this.load();
      const currentRevision = loaded.kind === "valid" ? loaded.state.revision : loaded.kind === "absent" ? null : "invalid";
      if (loaded.kind === "invalid" || currentRevision !== expectedRevision) {
        throw new AutopilotPolicyRevisionConflictError(expectedRevision, currentRevision);
      }
      const state: PersistedAutopilotPolicy = {
        schemaVersion: 1,
        revision: `r1-${randomUUID()}`,
        policy,
        updatedAt: new Date().toISOString(),
      };
      const writeAttempt = await this.write(state);
      const effective = resolveEffectivePolicy({ state });
      if (writeAttempt.kind === "durable") return { ...effective, writeStatus: "durable" };
      const readBack = await this.readEffective();
      return {
        ...readBack,
        writeStatus: "durability_uncertain_applied",
        writtenRevision: state.revision,
        readBack,
        durabilityError: writeAttempt.error.message,
      };
    });
  }

  /** Write, rename, and acknowledge the policy snapshot while preserving a typed post-rename durability fault. */
  private async write(state: PersistedAutopilotPolicy): Promise<PolicyWriteAttempt> {
    const parentDirectory = dirname(this.path);
    await mkdir(parentDirectory, { recursive: true });
    const temporary = join(parentDirectory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      renamed = true;
      try {
        await this.syncParentDirectory(parentDirectory);
        return { kind: "durable" };
      } catch (error) {
        return { kind: "durability_uncertain", error: asError(error) };
      }
    } finally {
      if (!renamed) await removeTemporaryFile(temporary);
    }
  }

  /** Serialize read-check-write operations in this store instance. */
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Serialize compare-and-swap updates across store instances that share a state path. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

/** Fsync a directory entry after rename, refusing to acknowledge durability when the platform cannot support it. */
async function syncParentDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM") {
      throw new Error(`Parent directory fsync is unsupported by this platform/filesystem (${code}); refusing to acknowledge a durable policy save`, { cause: error });
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** Remove a pre-rename temporary snapshot so a failed write does not leave stale durable-state candidates. */
async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Convert an arbitrary rejection into the explicit error carried by a typed write outcome. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Parse only the current durable envelope version so unknown versions cannot enable autopilot. */
function parseState(value: unknown): PersistedAutopilotPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("autopilot policy state must be an object");
  const object = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "revision", "policy", "updatedAt"]);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`unknown policy state field '${key}'`);
  if (object.schemaVersion !== 1 || typeof object.revision !== "string" || !object.revision || typeof object.updatedAt !== "string" || Number.isNaN(Date.parse(object.updatedAt))) {
    throw new Error("invalid autopilot policy state metadata");
  }
  return {
    schemaVersion: 1,
    revision: object.revision,
    policy: normalizeAutopilotPolicy(object.policy),
    updatedAt: new Date(object.updatedAt).toISOString(),
  };
}
