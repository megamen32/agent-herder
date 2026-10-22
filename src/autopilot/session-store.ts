import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import lockfile from "proper-lockfile";
import { isHealthPlanId, parseNoticeIncident, type HealthPlanId, type NoticeIncidentBinding } from "./notice-incident.js";

export type AutopilotHarness = "codex" | "opencode" | "claude" | "hermes" | "zcode";

export type AutopilotSessionOverride = {
  harness: AutopilotHarness;
  sessionId: string;
  cwd: string;
  /** Absent after reset: inherit policy while retaining original incident identity. */
  enabled?: boolean;
  updatedAt: string;
  noticeIncident?: NoticeIncidentBinding;
};

/**
 * The durable file of the session switches.
 *
 * The launch plans are the selected health plans the center stated for a
 * launch. They live next to the sessions because the plan of a launch must
 * survive the restart that happens between the launch call and the arming
 * call of the same session: the arming call carries the incident id only, so
 * a plan kept in the process memory alone would be lost with the process.
 */
type SessionFile = { version: 1; sessions: AutopilotSessionOverride[]; launchPlans?: Record<string, HealthPlanId> };

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
    target: { harness: AutopilotHarness; sessionId: string; cwd: string; noticeIncident?: NoticeIncidentBinding },
    enabled: boolean,
  ): Promise<AutopilotSessionOverride> {
    const normalized = normalizeTarget(target);
    return this.mutate(async (file) => {
      const key = sessionKey(normalized.harness, normalized.sessionId);
      const previous = file.sessions.find((item) => sessionKey(item.harness, item.sessionId) === key);
      const previousBinding = previous?.noticeIncident;
      const requested = target.noticeIncident === undefined ? undefined : parseNoticeIncident(target.noticeIncident);
      // The binding of one incident is written once: its incident and project
      // never change, and the working directory of an armed session is the
      // directory of that binding.
      if (previousBinding) {
        if (previous?.cwd !== normalized.cwd) throw new Error("original Notice incident binding cannot be replaced");
        if (requested && (requested.incidentId !== previousBinding.incidentId || requested.project !== previousBinding.project)) {
          throw new Error("original Notice incident binding cannot be replaced");
        }
      }
      // The selected plan of a binding can still be unknown when the binding
      // is written: the center states the plan in the launch message, while
      // the arming call carries the incident id only. A binding without a
      // plan may receive one later; a bound plan is never replaced, because
      // the center accepts the progress of one selected plan only.
      if (previousBinding?.planId && requested?.planId && requested.planId !== previousBinding.planId) {
        throw new Error("original Notice incident health plan cannot be replaced");
      }
      const noticeIncident = requested === undefined
        ? previousBinding
        : {
          ...requested,
          ...(requested.planId || !previousBinding?.planId ? {} : { planId: previousBinding.planId }),
        };
      const next: AutopilotSessionOverride = {
        ...normalized,
        enabled,
        ...(noticeIncident ? { noticeIncident } : {}),
        updatedAt: new Date().toISOString(),
      };
      const index = file.sessions.findIndex((item) => sessionKey(item.harness, item.sessionId) === key);
      if (index < 0) file.sessions.push(next);
      else file.sessions[index] = next;
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId).localeCompare(sessionKey(right.harness, right.sessionId)));
      // The plan of the launch is bound to the incident now: the remembered
      // launch plan is not needed any more.
      if (noticeIncident?.planId && file.launchPlans) {
        const plans = { ...file.launchPlans };
        delete plans[key];
        file.launchPlans = plans;
      }
      return { ...next };
    });
  }

  /**
   * The selected health plan the center stated for the launch of one session.
   *
   * The plan is remembered durably: the arming call of the same session
   * carries the incident id only, so the plan of the launch has to outlive the
   * process that stated it.
   */
  async getLaunchPlan(harness: AutopilotHarness, sessionId: string): Promise<HealthPlanId | undefined> {
    const key = sessionKey(harness, sessionId);
    return (await this.read()).launchPlans?.[key];
  }

  /** Every remembered launch plan, keyed by the session identity. */
  async getLaunchPlans(): Promise<Record<string, HealthPlanId>> {
    return { ...(await this.read()).launchPlans ?? {} };
  }

  /** Remember the selected health plan of one launch, durably. */
  async setLaunchPlan(harness: AutopilotHarness, sessionId: string, planId: HealthPlanId): Promise<HealthPlanId> {
    if (!isHealthPlanId(planId)) throw new Error("launch plan must be a selected health plan");
    const key = sessionKey(harness, sessionId);
    if ((await this.read()).launchPlans?.[key] === planId) return planId;
    return this.mutate(async (file) => {
      file.launchPlans = { ...(file.launchPlans ?? {}), [key]: planId };
      return planId;
    });
  }

  /** Remove an explicit session override so it inherits the harness policy again. */
  async delete(harness: AutopilotHarness, sessionId: string): Promise<boolean> {
    const key = sessionKey(harness, sessionId);
    return this.mutate(async (file) => {
      const index = file.sessions.findIndex((item) => sessionKey(item.harness, item.sessionId) === key);
      if (index < 0) return false;
      const record = file.sessions[index]!;
      if (record.noticeIncident) {
        if (record.enabled === undefined) return false;
        const { enabled: _override, ...binding } = record;
        file.sessions[index] = { ...binding, updatedAt: new Date().toISOString() };
      } else file.sessions.splice(index, 1);
      return true;
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
  const launchPlans = parseLaunchPlans(object.launchPlans);
  return {
    version: 1,
    sessions: object.sessions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid autopilot session entry");
      const record = item as Record<string, unknown>;
      if ((record.enabled !== undefined && typeof record.enabled !== "boolean")
        || (record.enabled === undefined && record.noticeIncident === undefined)
        || typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
        throw new Error("invalid autopilot session entry metadata");
      }
      return {
        ...normalizeTarget({ harness: record.harness as AutopilotHarness, sessionId: record.sessionId as string, cwd: record.cwd as string }),
        ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
        updatedAt: new Date(record.updatedAt).toISOString(),
        ...(record.noticeIncident === undefined ? {} : { noticeIncident: parseNoticeIncident(record.noticeIncident) }),
      };
    }),
    ...(launchPlans ? { launchPlans } : {}),
  };
}

/**
 * The remembered launch plans of the durable file.
 *
 * An unknown plan id is ignored instead of refused. The launch plan is a
 * pending hint that fills in the missing plan of an arming call, so one
 * unusable entry must not make the whole file unreadable: the armed records
 * of the live state would be lost with it. The plan of a binding stays
 * strict, because there the plan is the published one.
 */
function parseLaunchPlans(value: unknown): Record<string, HealthPlanId> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.error("autopilot launch plans are not a map: the remembered launch plans are ignored");
    return undefined;
  }
  const plans: Record<string, HealthPlanId> = {};
  for (const [key, plan] of Object.entries(value as Record<string, unknown>)) {
    if (!isHealthPlanId(plan)) {
      reportUnknownLaunchPlan(key);
      continue;
    }
    plans[key] = plan;
  }
  return plans;
}

/** One reason per unusable entry: the file is read on every operation. */
const reportedLaunchPlans = new Set<string>();

function reportUnknownLaunchPlan(key: string): void {
  if (reportedLaunchPlans.has(key)) return;
  reportedLaunchPlans.add(key);
  console.error(`autopilot launch plan of ${key} is not a selected health plan: the entry is ignored`);
}

function normalizeTarget(target: { harness: AutopilotHarness; sessionId: string; cwd: string }) {
  if (!(["codex", "opencode", "claude", "hermes", "zcode"] as string[]).includes(target.harness)) throw new Error("unsupported autopilot harness");
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
