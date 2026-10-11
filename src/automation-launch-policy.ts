import { normalizeIncidentExecution, type HealthExecutionProfile } from "./health-remediation.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { HarnessType } from "./types/common.js";

/**
 * Ordered harness fallback for one project root.
 *
 * The first harness is the primary choice; the rest are used only after a
 * definite pre-admission failure of the previous one. A per-route model
 * overrides the global model for that harness; an explicit provider/model is
 * never rewritten by a fallback.
 */
export interface ProjectLaunchRoute {
  harnesses: HarnessType[];
  models?: Partial<Record<HarnessType, string>>;
  /**
   * Additional project identifiers that resolve to this route, matched
   * case-insensitively. Real cards carry their own service identifier, for
   * example `tg-commentator` or `autotelegramviews`, not the checkout path.
   */
  aliases?: string[];
}

export interface AutomationLaunchPolicy {
  version: 1;
  allowedHarnesses: HarnessType[];
  preferredHarness: HarnessType;
  models: Partial<Record<HarnessType, string>>;
  incidentExecution?: HealthExecutionProfile;
  /** Ordered harness fallback per canonical project root. Absent for most projects. */
  projectRoutes?: Record<string, ProjectLaunchRoute>;
}

/** The launch outcomes a fallback may react to. */
export type LaunchOutcome =
  /** The native executor exists. Never fall back: a second executor would duplicate the work. */
  | "accepted"
  /** The native side may or may not have accepted it. Never replay, never fall back. */
  | "admission_unknown"
  /** Definite pre-admission rejection: quota, credentials or an unavailable runtime. */
  | "unavailable"
  | "quota_exhausted"
  | "pre_admission_rejected";

/** Outcomes that may advance to the next harness of a route. */
const FALLBACK_OUTCOMES: ReadonlySet<LaunchOutcome> = new Set<LaunchOutcome>([
  "unavailable",
  "quota_exhausted",
  "pre_admission_rejected",
]);

export interface ProjectLaunchRequest {
  /** Canonical absolute project root. */
  project: string;
  /** Already attempted harnesses, in attempt order. */
  attempted?: readonly HarnessType[];
  /** Outcome of the latest attempt. Omitted for a first attempt. */
  outcome?: LaunchOutcome;
  /** The live session of this project, when one exists. */
  activeSession?: { harness: HarnessType; sessionId: string };
}

export type ProjectLaunchResolution =
  | { kind: "unconfigured" }
  | { kind: "exhausted"; reason: "accepted" | "admission_unknown" | "no_harness_left" }
  | {
      kind: "launch";
      harness: HarnessType;
      model?: string;
      /** Resume the linked session by id, hand the context over, or create one executor. */
      mode: "create" | "resume" | "handoff";
      sessionId?: string;
      fromHarness?: HarnessType;
    };

/**
 * Resolve the next harness for one project.
 *
 * Only a definite pre-admission failure advances the ordered list. An accepted
 * launch and an unknown admission both stop the chain, so a semantic repair
 * failure or a pending human answer can never produce a second executor.
 */
export function resolveProjectLaunch(
  policy: AutomationLaunchPolicy,
  request: ProjectLaunchRequest,
): ProjectLaunchResolution {
  const route = findProjectRoute(policy, request.project);
  if (!route || route.harnesses.length === 0) return { kind: "unconfigured" };
  if (request.outcome === "accepted") return { kind: "exhausted", reason: "accepted" };
  if (request.outcome === "admission_unknown") return { kind: "exhausted", reason: "admission_unknown" };
  if (request.outcome !== undefined && !FALLBACK_OUTCOMES.has(request.outcome)) {
    return { kind: "exhausted", reason: "no_harness_left" };
  }
  const attempted = new Set(request.attempted ?? []);
  const harness = route.harnesses.find((candidate) => !attempted.has(candidate));
  if (!harness) return { kind: "exhausted", reason: "no_harness_left" };
  const model = route.models?.[harness] ?? policy.models[harness];
  const active = request.activeSession;
  if (!active) return { kind: "launch", harness, ...(model ? { model } : {}), mode: "create" };
  if (active.harness === harness) {
    return { kind: "launch", harness, ...(model ? { model } : {}), mode: "resume", sessionId: active.sessionId };
  }
  // A different harness for a working session needs the existing handoff, with
  // its context and receipt. A silent clone would lose both.
  return { kind: "launch", harness, ...(model ? { model } : {}), mode: "handoff", sessionId: active.sessionId, fromHarness: active.harness };
}

/** Find the route of a project by canonical path, declared alias or case-folded key. */
export function findProjectRoute(
  policy: AutomationLaunchPolicy,
  project: string,
): ProjectLaunchRoute | undefined {
  const routes = policy.projectRoutes;
  if (!routes) return undefined;
  const key = canonicalProjectKey(project);
  const exact = routes[key];
  if (exact) return exact;
  const folded = foldProjectKey(key);
  for (const [candidate, route] of Object.entries(routes)) {
    if (foldProjectKey(candidate) === folded) return route;
    if (route.aliases?.some((alias) => foldProjectKey(alias) === folded)) return route;
  }
  return undefined;
}

/** Case-folded comparison key for a project path or a declared alias. */
function foldProjectKey(value: string): string {
  return canonicalProjectKey(value).toLocaleLowerCase("en-US");
}

/** Canonical project key: an absolute path without a trailing separator. */
export function canonicalProjectKey(project: string): string {
  return typeof project === "string" ? project.replace(/\/+$/, "") : "";
}

/**
 * Documented starting values for the known projects.
 *
 * They are presets, not defaults: a preset is applied only when an operator
 * saves it, so every unconfigured project keeps the default launch path. The
 * roots are the verified real checkouts, and the aliases are the identifiers
 * real Notice cards carry.
 */
export const PROJECT_ROUTE_PRESETS: Readonly<Record<string, ProjectLaunchRoute>> = {
  "/home/roomhacker/PycharmProjects/TelegramAuto": {
    harnesses: ["opencode", "zcode"],
    aliases: ["tg-commentator", "autotelegramviews", "canonicalTelegramAuto"],
  },
  "/home/roomhacker/PycharmProjects/AutoFindClient": {
    harnesses: ["codex", "zcode", "opencode"],
  },
};

export type AutomationLaunchPolicyLoad =
  | { kind: "absent" }
  | { kind: "valid"; policy: AutomationLaunchPolicy }
  | { kind: "invalid"; error: string };

const HARNESSES: readonly HarnessType[] = ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
export const MAX_MODEL_LENGTH = 256;

export function validateAutomationLaunchPolicy(value: unknown): AutomationLaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch policy must be an object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["version", "allowedHarnesses", "preferredHarness", "models", "incidentExecution", "projectRoutes"]);
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
  const projectRoutes = input.projectRoutes === undefined ? undefined : validateProjectRoutes(input.projectRoutes, allowedHarnesses, models);
  return {
    version: 1,
    allowedHarnesses,
    preferredHarness: input.preferredHarness,
    models,
    ...(input.incidentExecution === undefined ? {} : { incidentExecution: normalizeIncidentExecution(input.incidentExecution) }),
    ...(projectRoutes ? { projectRoutes } : {}),
  };
}

const MAX_PROJECT_ROUTES = 64;
const MAX_PROJECT_ROUTE_LENGTH = 4096;
const MAX_ROUTE_HARNESSES = 8;

function validateProjectRoutes(
  value: unknown,
  allowedHarnesses: HarnessType[],
  models: Partial<Record<HarnessType, string>>,
): Record<string, ProjectLaunchRoute> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("projectRoutes must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROJECT_ROUTES) throw new Error(`projectRoutes must not hold more than ${MAX_PROJECT_ROUTES} projects`);
  const routes: Record<string, ProjectLaunchRoute> = {};
  for (const [project, route] of entries) {
    const key = canonicalProjectKey(project);
    if (key.length === 0 || key.length > MAX_PROJECT_ROUTE_LENGTH) throw new Error("A project route path must be a nonempty path of at most 4096 characters");
    if (!key.startsWith("/")) throw new Error(`Project route '${project}' must be an absolute path`);
    if (/[\u0000-\u001f\u007f]/u.test(key)) throw new Error(`Project route '${project}' must not contain control characters`);
    if (!route || typeof route !== "object" || Array.isArray(route)) throw new Error(`Project route '${project}' must be an object`);
    const input = route as Record<string, unknown>;
    if (!Array.isArray(input.harnesses) || input.harnesses.length === 0) throw new Error(`Project route '${project}' needs at least one harness`);
    if (input.harnesses.length > MAX_ROUTE_HARNESSES) throw new Error(`Project route '${project}' must not hold more than ${MAX_ROUTE_HARNESSES} harnesses`);
    const harnesses: HarnessType[] = [];
    for (const harness of input.harnesses) {
      if (!isHarness(harness)) throw new Error(`Unknown harness '${String(harness)}' in project route '${project}'`);
      if (harnesses.includes(harness)) throw new Error(`Duplicate harness '${harness}' in project route '${project}'`);
      if (allowedHarnesses.length > 0 && !allowedHarnesses.includes(harness)) {
        throw new Error(`Project route '${project}' uses harness '${harness}' that is not allowed for automated launch`);
      }
      harnesses.push(harness);
    }
    let routeModels: Partial<Record<HarnessType, string>> | undefined;
    if (input.models !== undefined) {
      if (!input.models || typeof input.models !== "object" || Array.isArray(input.models)) {
        throw new Error(`Project route '${project}' models must be an object`);
      }
      routeModels = {};
      for (const [harness, model] of Object.entries(input.models as Record<string, unknown>)) {
        if (!isHarness(harness)) throw new Error(`Unknown model harness '${harness}' in project route '${project}'`);
        if (!harnesses.includes(harness)) throw new Error(`Project route '${project}' has a model for unused harness '${harness}'`);
        if (typeof model !== "string" || model.trim().length === 0 || model.length > MAX_MODEL_LENGTH) {
          throw new Error(`Model for '${harness}' in project route '${project}' must be a nonempty string of at most ${MAX_MODEL_LENGTH} characters`);
        }
        if (/[\u0000-\u001f\u007f]/u.test(model)) {
          throw new Error(`Model for '${harness}' in project route '${project}' must not contain control characters`);
        }
        routeModels[harness] = model.trim();
      }
    }
    // An explicit provider/model is preserved: a routed harness always has one.
    for (const harness of harnesses) {
      if (!routeModels?.[harness] && !models[harness]) {
        throw new Error(`Project route '${project}' has no model for harness '${harness}'`);
      }
    }
    let aliases: string[] | undefined;
    if (input.aliases !== undefined) {
      if (!Array.isArray(input.aliases) || input.aliases.length === 0 || input.aliases.length > 16) {
        throw new Error(`Project route '${project}' aliases must be a list of 1 to 16 identifiers`);
      }
      const seen = new Set<string>();
      aliases = [];
      for (const alias of input.aliases) {
        if (typeof alias !== "string" || alias.trim().length === 0 || alias.length > MAX_PROJECT_ROUTE_LENGTH) {
          throw new Error(`Project route '${project}' has an invalid alias`);
        }
        const normalized = alias.trim();
        if (seen.has(normalized.toLocaleLowerCase("en-US"))) throw new Error(`Project route '${project}' repeats alias '${normalized}'`);
        seen.add(normalized.toLocaleLowerCase("en-US"));
        aliases.push(normalized);
      }
    }
    routes[key] = {
      harnesses,
      ...(routeModels && Object.keys(routeModels).length > 0 ? { models: routeModels } : {}),
      ...(aliases ? { aliases } : {}),
    };
  }
  return routes;
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
