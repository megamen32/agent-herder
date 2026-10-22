import { normalizeIncidentExecution, type HealthExecutionProfile } from "./health-remediation.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { HarnessType } from "./types/common.js";
import {
  canonicalProjectKey,
  findModelPolicyRoute,
  modelPermittedForRoute,
  validateProjectModelLists,
} from "./project-model-policy.js";

export { canonicalProjectKey } from "./project-model-policy.js";

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
  /** First-party hosted web search is granted only to the named integrator project route. */
  nativeWebSearch?: "live";
  /** Operator-authorized historical recovery is withheld until provider and descendant policy is enforced. */
  operatorCohortRecovery?: "deny";
  /**
   * Additional project identifiers that resolve to this route, matched
   * case-insensitively. Real cards carry their own service identifier, for
   * example `tg-commentator` or `autotelegramviews`, not the checkout path.
   */
  aliases?: string[];
  /**
   * Model ids this project may run on. An empty or absent list means no
   * restriction: the global model of the harness decides.
   */
  allowedModels?: string[];
  /**
   * Model ids this project must never run on. A denial always wins over an
   * allowance and over the global model of the harness.
   */
  deniedModels?: string[];
}

export interface AutomationLaunchPolicy {
  version: 1;
  allowedHarnesses: HarnessType[];
  preferredHarness: HarnessType;
  models: Partial<Record<HarnessType, string>>;
  /** Ordered, fully qualified OmniRoute fallback models for these native harnesses. */
  fallbackModels?: Partial<Record<"opencode" | "zcode", string[]>>;
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
  | { kind: "exhausted"; reason: "accepted" | "admission_unknown" | "no_harness_left" | "model_not_permitted" }
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
  const candidates = route.harnesses.filter((candidate) => !attempted.has(candidate));
  if (candidates.length === 0) return { kind: "exhausted", reason: "no_harness_left" };
  // A model the project forbids is a definite pre-admission refusal, exactly
  // like an unavailable harness: the route moves on to the next harness
  // instead of launching a model the operator denied.
  const harness = candidates.find((candidate) => {
    const candidateModel = route.models?.[candidate] ?? policy.models[candidate];
    return !candidateModel || modelPermittedForRoute(route, candidateModel);
  });
  if (!harness) return { kind: "exhausted", reason: "model_not_permitted" };
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

/** Historical operator enrollment has stricter scope than ordinary launch routing. */
export function operatorCohortRecoveryAllowed(policy: AutomationLaunchPolicy, project: string): boolean {
  const route = findProjectRoute(policy, project);
  if (route && (!route.harnesses.includes("opencode") || route.operatorCohortRecovery === "deny")) return false;
  const key = foldProjectKey(project);
  // These two product projects are the explicitly restricted cohort; keep
  // historical enrollment closed until resolved-provider/child checks land.
  if (key === foldProjectKey("/home/roomhacker/PycharmProjects/video_watching")) return false;
  for (const [presetPath, preset] of Object.entries(PROJECT_ROUTE_PRESETS)) {
    if (presetPath !== "/home/roomhacker/PycharmProjects/TelegramAuto") continue;
    if (foldProjectKey(presetPath) === key || preset.aliases?.some((alias) => foldProjectKey(alias) === key)) return false;
  }
  // No launch route means no ordinary automation authority, but this helper is
  // only for a human-authorized exact-session cohort enrollment. The separate
  // global ordered fallback and native terminal checks still apply.
  return true;
}

/** Case-folded comparison key for a project path or a declared alias. */
function foldProjectKey(value: string): string {
  return canonicalProjectKey(value).toLocaleLowerCase("en-US");
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

/** The stored document together with the identity of the exact stored bytes. */
export type AutomationLaunchPolicyDocument =
  | { kind: "absent"; etag: string }
  | { kind: "valid"; policy: AutomationLaunchPolicy; etag: string }
  | { kind: "invalid"; error: string; etag: string };

/** The document identity of a launch policy that does not exist yet. */
export const ABSENT_LAUNCH_POLICY_ETAG = '"absent"';

/**
 * A strong opaque ETag over the stored document.
 *
 * The value is a hash of the exact file bytes, so it identifies the document
 * without exposing its content and changes whenever the document changes.
 */
export function launchPolicyEtag(raw: string | Buffer): string {
  return `"${createHash("sha256").update(raw).digest("hex").slice(0, 32)}"`;
}

/** A full-document write lost the race against a newer document. */
export class LaunchPolicyConflictError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super("The launch policy changed since it was loaded");
    this.name = "LaunchPolicyConflictError";
  }
}

const HARNESSES: readonly HarnessType[] = ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
export const MAX_MODEL_LENGTH = 256;

export function validateAutomationLaunchPolicy(value: unknown): AutomationLaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch policy must be an object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["version", "allowedHarnesses", "preferredHarness", "models", "fallbackModels", "incidentExecution", "projectRoutes"]);
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
  const fallbackModels = input.fallbackModels === undefined ? undefined : validateFallbackModels(input.fallbackModels);
  const projectRoutes = input.projectRoutes === undefined ? undefined : validateProjectRoutes(input.projectRoutes, allowedHarnesses, models);
  return {
    version: 1,
    allowedHarnesses,
    preferredHarness: input.preferredHarness,
    models,
    ...(fallbackModels ? { fallbackModels } : {}),
    ...(input.incidentExecution === undefined ? {} : { incidentExecution: normalizeIncidentExecution(input.incidentExecution) }),
    ...(projectRoutes ? { projectRoutes } : {}),
  };
}

const MAX_FALLBACK_MODELS = 8;
const FALLBACK_MODEL_HARNESSES = ["opencode", "zcode"] as const;

function validateFallbackModels(value: unknown): Partial<Record<"opencode" | "zcode", string[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fallbackModels must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!FALLBACK_MODEL_HARNESSES.includes(key as typeof FALLBACK_MODEL_HARNESSES[number])) {
    throw new Error(`fallbackModels does not support '${key}'`);
  }
  const output: Partial<Record<"opencode" | "zcode", string[]>> = {};
  for (const harness of FALLBACK_MODEL_HARNESSES) {
    const candidate = input[harness];
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate) || candidate.length > 64) {
      throw new Error(`fallbackModels.${harness} must be an ordered list of at most 64 entries`);
    }
    const seen = new Set<string>();
    const models: string[] = [];
    for (const model of candidate) {
      if (typeof model !== "string") throw new Error(`fallbackModels.${harness} entries must be model IDs`);
      const normalized = model.trim();
      if (normalized.length === 0 || normalized.length > MAX_MODEL_LENGTH || /[\u0000-\u0020\u007f]/u.test(normalized)
      || !/^omniroute\/[A-Za-z0-9._-]+(?:\/[^/\\]+(?:\/[^/\\]+)*)?$/iu.test(normalized)) {
        throw new Error(`fallbackModels.${harness} entries must be fully qualified OmniRoute model IDs`);
      }
      const key = normalized.toLocaleLowerCase("en-US");
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(normalized);
      if (models.length > MAX_FALLBACK_MODELS) {
        throw new Error(`fallbackModels.${harness} may contain at most ${MAX_FALLBACK_MODELS} unique models`);
      }
    }
    output[harness] = models;
  }
  return output;
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
    if (input.nativeWebSearch !== undefined) {
      if (input.nativeWebSearch !== "live") {
        throw new Error(`Project route '${project}' nativeWebSearch must be 'live' when present`);
      }
      if (!harnesses.includes("codex") || harnesses.length !== 1
        || (routeModels?.codex ?? models.codex) !== "gpt-6-luna"
        || !aliases?.includes("Олег и Никита")) {
        throw new Error(`Project route '${project}' live native web search is restricted to the Codex GPT-6 Luna 'Олег и Никита' route`);
      }
    }
    if (input.operatorCohortRecovery !== undefined && input.operatorCohortRecovery !== "deny") {
      throw new Error(`Project route '${project}' operatorCohortRecovery must be 'deny' when present`);
    }
    const modelLists = validateProjectModelLists(project, {
      allowedModels: input.allowedModels,
      deniedModels: input.deniedModels,
    });
    routes[key] = {
      harnesses,
      ...(routeModels && Object.keys(routeModels).length > 0 ? { models: routeModels } : {}),
      ...(aliases ? { aliases } : {}),
      ...(input.nativeWebSearch === "live" ? { nativeWebSearch: "live" as const } : {}),
      ...(input.operatorCohortRecovery === "deny" ? { operatorCohortRecovery: "deny" as const } : {}),
      ...(modelLists.allowedModels ? { allowedModels: modelLists.allowedModels } : {}),
      ...(modelLists.deniedModels ? { deniedModels: modelLists.deniedModels } : {}),
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
    const document = await this.readDocument();
    if (document.kind === "valid") return { kind: "valid", policy: document.policy };
    if (document.kind === "absent") return { kind: "absent" };
    return { kind: "invalid", error: document.error };
  }

  /** Read the stored document and the identity of the exact stored bytes. */
  async readDocument(): Promise<AutomationLaunchPolicyDocument> {
    let raw: Buffer;
    try {
      raw = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", etag: ABSENT_LAUNCH_POLICY_ETAG };
      return { kind: "invalid", error: (error as Error).message, etag: ABSENT_LAUNCH_POLICY_ETAG };
    }
    const etag = launchPolicyEtag(raw);
    try {
      return { kind: "valid", policy: validateAutomationLaunchPolicy(JSON.parse(raw.toString("utf8")) as unknown), etag };
    } catch (error) {
      return { kind: "invalid", error: (error as Error).message, etag };
    }
  }

  /**
   * Replace the whole document.
   *
   * With `ifMatch` the write is a compare-and-swap: the current document is
   * read under the same lock that writes it, so a concurrent change is
   * reported as a conflict instead of being silently overwritten.
   */
  async replace(value: unknown, options: { ifMatch?: string } = {}): Promise<{ policy: AutomationLaunchPolicy; etag: string }> {
    let policy = validateAutomationLaunchPolicy(value);
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
        if (options.ifMatch !== undefined) {
          const current = await this.currentEtag();
          if (options.ifMatch !== current) throw new LaunchPolicyConflictError(options.ifMatch, current);
        }
        // Older full-document clients reconstruct only known fields. Preserve
        // the newer fallback list when such a client omits it; an explicit {}
        // remains the intentional clear operation.
        if (policy.fallbackModels === undefined) {
          const current = await this.load();
          if (current.kind === "valid" && current.policy.fallbackModels !== undefined) {
            policy = { ...policy, fallbackModels: current.policy.fallbackModels };
          }
        }
        // Older project-route editors reconstruct route objects without
        // operator cohort guard metadata. Keep that guard unless the route is
        // explicitly removed; callers cannot clear it accidentally.
        const currentPolicy = await this.load();
        if (currentPolicy.kind === "valid" && currentPolicy.policy.projectRoutes && policy.projectRoutes) {
          const routes = { ...policy.projectRoutes };
          let changed = false;
          for (const [project, route] of Object.entries(routes)) {
            const old = currentPolicy.policy.projectRoutes[project];
            if (!old) continue;
            // The per-project model lists are preserved the same way: an older
            // editor that does not know the fields omits them, and that must
            // not wipe a list the operator configured. An explicit empty list
            // stays the intentional clear operation.
            const preserved: ProjectLaunchRoute = { ...route };
            let routeChanged = false;
            if (old.operatorCohortRecovery === "deny" && route.operatorCohortRecovery === undefined) {
              preserved.operatorCohortRecovery = "deny";
              routeChanged = true;
            }
            if (old.allowedModels !== undefined && route.allowedModels === undefined) {
              preserved.allowedModels = old.allowedModels;
              routeChanged = true;
            }
            if (old.deniedModels !== undefined && route.deniedModels === undefined) {
              preserved.deniedModels = old.deniedModels;
              routeChanged = true;
            }
            if (routeChanged) {
              routes[project] = preserved;
              changed = true;
            }
          }
          if (changed) policy = { ...policy, projectRoutes: routes };
        }
        const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
        return { policy, etag: launchPolicyEtag(bytes) };
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

  /** The identity of the document as it is stored right now. */
  private async currentEtag(): Promise<string> {
    try {
      return launchPolicyEtag(await readFile(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_LAUNCH_POLICY_ETAG;
      throw error;
    }
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
