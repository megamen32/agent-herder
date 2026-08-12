import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import lockfile from "proper-lockfile";

export type AutopilotHarness = "codex" | "opencode" | "claude" | "hermes";

export type AutopilotSessionOverride = {
  harness: AutopilotHarness;
  sessionId: string;
  cwd: string;
  enabled: boolean;
  updatedAt: string;
};

type SessionFile = { version: 1; sessions: AutopilotSessionOverride[] };

const MAX_TEXT = 512;

/** Durable per-harness session switches shared by slash commands and lifecycle adapters. */
export class AutopilotSessionStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async get(harness: AutopilotHarness, sessionId: string): Promise<AutopilotSessionOverride | null> {
    const key = sessionKey(harness, sessionId);
    const record = (await this.read()).sessions.find((item) => sessionKey(item.harness, item.sessionId) === key);
    return record ? { ...record } : null;
  }

  async set(
    target: { harness: AutopilotHarness; sessionId: string; cwd: string },
    enabled: boolean,
  ): Promise<AutopilotSessionOverride> {
    const normalized = normalizeTarget(target);
    return this.mutate(async (file) => {
      const key = sessionKey(normalized.harness, normalized.sessionId);
      const next: AutopilotSessionOverride = {
        ...normalized,
        enabled,
        updatedAt: new Date().toISOString(),
      };
      const index = file.sessions.findIndex((item) => sessionKey(item.harness, item.sessionId) === key);
      if (index < 0) file.sessions.push(next);
      else file.sessions[index] = next;
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId).localeCompare(sessionKey(right.harness, right.sessionId)));
      return { ...next };
    });
  }

  private async read(): Promise<SessionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return parseFile(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async mutate<T>(update: (file: SessionFile) => Promise<T> | T): Promise<T> {
    const previous = this.operation;
    let releaseSerial!: () => void;
    this.operation = new Promise<void>((resolve) => { releaseSerial = resolve; });
    await previous;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
      const release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 },
      });
      try {
        const file = await this.read();
        const result = await update(file);
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path);
        return result;
      } finally {
        await release();
      }
    } finally {
      releaseSerial();
    }
  }
}

function parseFile(value: unknown): SessionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("autopilot session state must be an object");
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.sessions)) throw new Error("invalid autopilot session state");
  return {
    version: 1,
    sessions: object.sessions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid autopilot session entry");
      const record = item as Record<string, unknown>;
      if (typeof record.enabled !== "boolean" || typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
        throw new Error("invalid autopilot session entry metadata");
      }
      return {
        ...normalizeTarget({ harness: record.harness as AutopilotHarness, sessionId: record.sessionId as string, cwd: record.cwd as string }),
        enabled: record.enabled,
        updatedAt: new Date(record.updatedAt).toISOString(),
      };
    }),
  };
}

function normalizeTarget(target: { harness: AutopilotHarness; sessionId: string; cwd: string }) {
  if (!(["codex", "opencode", "claude", "hermes"] as string[]).includes(target.harness)) throw new Error("unsupported autopilot harness");
  const sessionId = boundedText(target.sessionId, "sessionId");
  const cwd = boundedText(target.cwd, "cwd");
  return { harness: target.harness, sessionId, cwd: normalize(cwd) };
}

function sessionKey(harness: AutopilotHarness, sessionId: string): string {
  return `${harness}:${boundedText(sessionId, "sessionId")}`;
}

function boundedText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${label} must be bounded non-empty text`);
  return value.trim();
}
