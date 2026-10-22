/**
 * Per-project model policy: which models a project may run on.
 *
 * The module is deliberately free of node imports: the web UI imports it to
 * show the operator the effective model of every harness of a route, and the
 * server imports it for the one gate that decides whether a model may be
 * applied. Both sides must agree on the matching rules, so the rules live here
 * exactly once.
 *
 * The rules are:
 * - a model id matches an entry by exact comparison after trimming and
 *   ignoring case, or by prefix when the entry ends with `*`;
 * - a denial always wins: a denied model is never used in the project, even
 *   when it is also listed as allowed or when it is the global model of the
 *   harness;
 * - an empty or absent allow list means no restriction at all: the global
 *   policy of the harness decides.
 *
 * The module also holds the one lookup that resolves a directory to the route
 * that governs it, so the launch resolution and the model gate can never
 * disagree about the project of a session.
 */

/** The parts of a project route this module reads. */
export interface ProjectModelRoute {
  /** Additional project identifiers that resolve to this route. */
  aliases?: string[];
  /** Model ids allowed for work in this project. Empty or absent means no restriction. */
  allowedModels?: string[];
  /** Model ids denied for work in this project. A denial always wins. */
  deniedModels?: string[];
  /** The model of a harness inside this route, when the route overrides the global one. */
  models?: Record<string, string>;
}

/** The parts of the launch policy document this module reads. */
export interface ProjectModelPolicy {
  projectRoutes?: Record<string, ProjectModelRoute>;
  /** The model of a harness in the whole fleet, used when a route does not override it. */
  models?: Record<string, string>;
}

/** At most this many entries in one model list of a project route. */
export const MAX_PROJECT_MODEL_ENTRIES = 64;

/** At most this many characters in one model list entry. */
export const MAX_PROJECT_MODEL_LENGTH = 256;

/** The stable error code of a rejected model request. */
export const MODEL_NOT_PERMITTED_CODE = "model_not_permitted_for_project";

/**
 * A model request that the project policy does not permit.
 *
 * The code is stable so a caller can react to it without parsing the message.
 */
export class ModelNotPermittedError extends Error {
  readonly code = MODEL_NOT_PERMITTED_CODE;

  constructor(
    readonly project: string,
    readonly model: string,
    readonly allowedModels: readonly string[],
    readonly deniedModels: readonly string[],
  ) {
    super(
      `${MODEL_NOT_PERMITTED_CODE}: model "${model}" is not permitted for project "${project}".`
      + ` Allowed models: ${allowedModels.length > 0 ? allowedModels.join(", ") : "none"}.`
      + ` Denied models: ${deniedModels.length > 0 ? deniedModels.join(", ") : "none"}.`,
    );
    this.name = "ModelNotPermittedError";
  }
}

/** Canonical project key: an absolute path without a trailing separator. */
export function canonicalProjectKey(project: string): string {
  return typeof project === "string" ? project.replace(/\/+$/, "") : "";
}

/** Case-folded comparison key for a project path or a declared alias. */
export function foldProjectKey(value: string): string {
  return canonicalProjectKey(value).toLocaleLowerCase("en-US");
}
/**
 * How a directory was matched to the route that governs it.
 *
 * - `exact` — the canonical path of the directory is the key of the route;
 * - `case` — the path of the directory is the key of the route in another case;
 * - `alias` — the directory is one of the declared aliases of the route;
 * - `nested` — the directory lies inside the root of the route.
 */
export type ProjectRouteMatchKind = "exact" | "case" | "alias" | "nested";

/** The route that governs a directory, with the key it is configured under. */
export interface ProjectRouteMatch<T extends ProjectModelRoute> {
  /** The route that governs the directory. */
  route: T;
  /** The key of the route in the routes map: the canonical path of the project root. */
  key: string;
  /** How the directory matched the route. */
  kind: ProjectRouteMatchKind;
}

/**
 * The one lookup that resolves a directory to the route that governs it.
 *
 * The rule is the same for the launch permission and for the model gate:
 * 1. the exact canonical folder of the route wins;
 * 2. then the same folder in another case;
 * 3. then a declared alias of the route;
 * 4. and finally the route root that contains the directory.
 *
 * A directory inside a routed project is governed by the rules of that project,
 * so a session cannot escape them by starting in a subdirectory. When several
 * route roots contain the directory, the longest one wins: the route of a
 * subdirectory overrides the route of its parent.
 *
 * The nesting is matched literally, because the production paths are
 * case-sensitive, while the exact folder and the alias are matched
 * case-insensitively, exactly as before.
 */
export function findProjectModelRoute<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  directory: string,
): ProjectRouteMatch<T> | undefined {
  if (!routes) return undefined;
  const key = canonicalProjectKey(directory);
  const exact = routes[key];
  if (exact) return { route: exact, key, kind: "exact" };
  const folded = foldProjectKey(key);
  let aliasMatch: ProjectRouteMatch<T> | undefined;
  for (const [candidate, route] of Object.entries(routes)) {
    if (foldProjectKey(candidate) === folded) return { route, key: candidate, kind: "case" };
    if (!aliasMatch && route.aliases?.some((alias) => foldProjectKey(alias) === folded)) {
      aliasMatch = { route, key: candidate, kind: "alias" };
    }
  }
  if (aliasMatch) return aliasMatch;
  // Nesting: the longest route root that contains the directory governs it.
  let nested: ProjectRouteMatch<T> | undefined;
  for (const [candidate, route] of Object.entries(routes)) {
    const root = canonicalProjectKey(candidate);
    if (!root.startsWith("/")) continue;
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    if (!nested || root.length > canonicalProjectKey(nested.key).length) {
      nested = { route, key: candidate, kind: "nested" };
    }
  }
  return nested;
}

/**
 * Find the route that governs a project.
 *
 * The lookup is the one rule of {@link findProjectModelRoute}: the exact
 * canonical folder, its case variant, a declared alias and finally the longest
 * route root that contains the project.
 */
export function findModelPolicyRoute<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  project: string,
): T | undefined {
  return findProjectModelRoute(routes, project)?.route;
}

/**
 * Find the route that governs a working directory.
 *
 * The named entry point of the tools gate. It is the same lookup as
 * {@link findModelPolicyRoute}, because a session that runs in a subdirectory
 * of a project is governed by the rules of that project.
 */
export function findModelPolicyRouteForPath<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  directory: string,
): T | undefined {
  return findProjectModelRoute(routes, directory)?.route;
}

/** Normalized comparison form of one model list entry. */
export function normalizeModelEntry(entry: string): string {
  return entry.trim().toLocaleLowerCase("en-US");
}

/**
 * Does a model id match one policy entry?
 *
 * An entry that ends with `*` is a prefix rule, everything else is an exact
 * comparison. Both ignore the case and the surrounding whitespace.
 */
export function modelMatchesEntry(model: string, entry: string): boolean {
  const candidate = model.trim().toLocaleLowerCase("en-US");
  const rule = entry.trim().toLocaleLowerCase("en-US");
  if (rule.length === 0) return false;
  if (rule.endsWith("*")) return candidate.startsWith(rule.slice(0, -1));
  return candidate === rule;
}

/**
 * May this model be used under this route?
 *
 * A denial always wins over an allowance. An empty or absent allow list means
 * no restriction at all.
 */
export function modelPermittedForRoute(route: ProjectModelRoute, model: string): boolean {
  const denied = route.deniedModels ?? [];
  if (denied.some((entry) => modelMatchesEntry(model, entry))) return false;
  const allowed = route.allowedModels ?? [];
  if (allowed.length === 0) return true;
  return allowed.some((entry) => modelMatchesEntry(model, entry));
}

/**
 * The model a project would run on for one harness when the caller names none.
 *
 * The route model wins over the global model of the harness, exactly like the
 * launch resolution does. A project without a route falls back to the global
 * model, and a harness without any model has none.
 */
export function effectiveModelForProject(
  policy: ProjectModelPolicy,
  project: string,
  harness: string,
): string | undefined {
  const route = findModelPolicyRouteForPath(policy.projectRoutes, project);
  return route?.models?.[harness] ?? policy.models?.[harness];
}

/**
 * May this model be used in this project?
 *
 * The project is resolved by the one route lookup, so a directory inside a
 * routed project is judged by the rules of that project. A project without a
 * route keeps the global policy unchanged.
 */
export function modelPermittedForProject(
  policy: ProjectModelPolicy,
  project: string,
  model: string,
): boolean {
  const route = findModelPolicyRoute(policy.projectRoutes, project);
  if (!route) return true;
  return modelPermittedForRoute(route, model);
}

/**
 * Reject a model that the project policy does not permit.
 *
 * The error names the project, the model and the lists that decided it, so an
 * operator can see which rule to change. The lists are the ones of the route
 * that governs the project, which is the route of the project root for a
 * directory inside that root.
 */
export function assertModelPermittedForProject(
  policy: ProjectModelPolicy,
  project: string,
  model: string,
): void {
  if (modelPermittedForProject(policy, project, model)) return;
  const route = findModelPolicyRoute(policy.projectRoutes, project);
  throw new ModelNotPermittedError(
    project,
    model,
    route?.allowedModels ?? [],
    route?.deniedModels ?? [],
  );
}

/** The entries that are listed as allowed and as denied at the same time. */
export function conflictingModelEntries(
  allowedModels: readonly string[] | undefined,
  deniedModels: readonly string[] | undefined,
): string[] {
  const denied = new Set((deniedModels ?? []).map((entry) => normalizeModelEntry(entry)));
  return (allowedModels ?? []).filter((entry) => denied.has(normalizeModelEntry(entry)));
}

/**
 * Validate the two model lists of one project route.
 *
 * The returned lists keep the operator's order. An empty list is kept as an
 * empty list, because that is the explicit act of clearing a restriction.
 */
export function validateProjectModelLists(
  project: string,
  input: { allowedModels?: unknown; deniedModels?: unknown },
): { allowedModels?: string[]; deniedModels?: string[] } {
  const allowedModels = validateModelList(project, "allowedModels", input.allowedModels);
  const deniedModels = validateModelList(project, "deniedModels", input.deniedModels);
  const conflicts = conflictingModelEntries(allowedModels, deniedModels);
  if (conflicts.length > 0) {
    throw new Error(
      `Project route '${project}' lists model '${conflicts[0]}' as allowed and as denied at the same time.`
      + " Remove it from one of the lists.",
    );
  }
  return {
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(deniedModels === undefined ? {} : { deniedModels }),
  };
}

function validateModelList(project: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Project route '${project}' ${field} must be an array`);
  if (value.length > MAX_PROJECT_MODEL_ENTRIES) {
    throw new Error(`Project route '${project}' ${field} must not hold more than ${MAX_PROJECT_MODEL_ENTRIES} models`);
  }
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`Project route '${project}' ${field} entries must be nonempty model IDs`);
    }
    if (entry.length > MAX_PROJECT_MODEL_LENGTH) {
      throw new Error(`Project route '${project}' ${field} entries must be at most ${MAX_PROJECT_MODEL_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(entry)) {
      throw new Error(`Project route '${project}' ${field} entries must not contain control characters`);
    }
    const normalized = entry.trim();
    const key = normalizeModelEntry(normalized);
    if (seen.has(key)) throw new Error(`Project route '${project}' repeats model '${normalized}' in ${field}`);
    seen.add(key);
    models.push(normalized);
  }
  return models;
}
