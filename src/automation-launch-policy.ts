import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { HarnessType } from "./types/common.js";

export interface AutomationLaunchPolicy {
  version: 1;
  allowedHarnesses: HarnessType[];
  preferredHarness: HarnessType;
  models: Partial<Record<HarnessType, string>>;
}

export type AutomationLaunchPolicyLoad =
  | { kind: "absent" }
  | { kind: "valid"; policy: AutomationLaunchPolicy }
  | { kind: "invalid"; error: string };

const HARNESSES: readonly HarnessType[] = ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
export const MAX_MODEL_LENGTH = 256;

export function validateAutomationLaunchPolicy(value: unknown): AutomationLaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch policy must be an object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["version", "allowedHarnesses", "preferredHarness", "models"]);
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`Unknown launch policy field '${key}'`);
  if (input.version !== 1) throw new Error("Launch policy version must be 1");
  if (!Array.isArray(input.allowedHarnesses)) throw new Error("allowedHarnesses must be an array");
  const allowedHarnesses: HarnessType[] = [];
  for (const value of input.allowedHarnesses) {
    if (!isHarness(value)) throw new Error(`Unknown harness '${String(value)}'`);
    if (allowedHarnesses.includes(value)) throw new Error(`Duplicate harness '${value}'`);
    allowedHarnesses.push(value);
  }
  if (!isHarness(input.preferredHarness)) throw new Error("preferredHarness must be a known harness");
  if (allowedHarnesses.length > 0 && !allowedHarnesses.includes(input.preferredHarness)) {
    throw new Error("preferredHarness must be included in allowedHarnesses");
  }
  if (!input.models || typeof input.models !== "object" || Array.isArray(input.models)) throw new Error("models must be an object");
  const models: Partial<Record<HarnessType, string>> = {};
  for (const [harness, model] of Object.entries(input.models)) {
    if (!isHarness(harness)) throw new Error(`Unknown model harness '${harness}'`);
    if (typeof model !== "string" || model.trim().length === 0 || model.length > MAX_MODEL_LENGTH) {
      throw new Error(`Model for '${harness}' must be a nonempty string of at most ${MAX_MODEL_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(model)) {
      throw new Error(`Model for '${harness}' must not contain control characters`);
    }
    models[harness] = model.trim();
  }
  for (const harness of allowedHarnesses) {
    if (!models[harness]) throw new Error(`A model is required for allowed harness '${harness}'`);
  }
  return { version: 1, allowedHarnesses, preferredHarness: input.preferredHarness, models };
}

/** Independent durable policy for authorizing newly created automated sessions. */
export class AutomationLaunchPolicyStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async load(): Promise<AutomationLaunchPolicyLoad> {
    try {
      return { kind: "valid", policy: validateAutomationLaunchPolicy(JSON.parse(await readFile(this.path, "utf8")) as unknown) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "invalid", error: (error as Error).message };
    }
  }

  async replace(value: unknown): Promise<AutomationLaunchPolicy> {
    const policy = validateAutomationLaunchPolicy(value);
    return this.serial(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
      const release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 },
      });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
        return policy;
      } catch (error) {
        try { await unlink(temporary); } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
        throw error;
      } finally {
        await release();
      }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isHarness(value: unknown): value is HarnessType {
  return typeof value === "string" && HARNESSES.includes(value as HarnessType);
}
