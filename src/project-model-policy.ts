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
 * The module also holds the two lookups of a project route. The containment
 * lookup resolves a directory to the route that GOVERNS it, so the launch
 * resolution and the model gate can never disagree about the model of a
 * session. The identity lookup resolves a directory to the route it IS, so the
 * working folder and the work key of a session stay its own. The wrappers
 * below exist only to name the two sides of them.
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

/**
 * Canonical path of a project: its segments, resolved.
 *
 * The empty segments and the `.` segments are dropped, and a `..` segment
 * removes the segment before it, so `/a/b/../c` is `/a/c` and `/a/b/./c` is
 * `/a/b/c`. A `..` without a segment to remove is dropped as well, so a path
 * never leaves its root. A relative path stays relative: it is the name of a
 * project, not a path below a root.
 *
 * The directory of a session and the root of a route are canonicalized by this
 * one rule, so a directory that walks out of a route with `..` cannot inherit
 * the lists of that route.
 */
export function normalizeProjectPath(value: string): string {
  if (typeof value !== "string") return "";
  const absolute = value.startsWith("/");
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return absolute ? `/${joined}` : joined;
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
export interface ProjectRouteResolution<T extends ProjectModelRoute> {
  /** The route that governs the directory. */
  route: T;
  /** The key of the route in the routes map: the path the route is configured under. */
  routeKey: string;
  /** How the directory matched the route. */
  matchKind: ProjectRouteMatchKind;
}

/** One candidate route of the lookup, with the root it was matched by. */
interface RouteCandidate<T extends ProjectModelRoute> {
  route: T;
  /** The key of the route in the routes map. */
  routeKey: string;
  /** The canonical path of the key: the root of the route. */
  root: string;
}

/**
 * Does the candidate root govern the directory better than the current one?
 *
 * The longer root wins, because it is the nearer project. At an equal length
 * the lexicographically smaller canonical root wins, so the result depends on
 * the content of the document and not on the order of its keys.
 */
function isBetterRoot(
  candidateRoot: string,
  candidateKey: string,
  currentRoot: string,
  currentKey: string,
): boolean {
  if (candidateRoot.length !== currentRoot.length) {
    return candidateRoot.length > currentRoot.length;
  }
  if (candidateRoot !== currentRoot) return candidateRoot < currentRoot;
  return candidateKey < currentKey;
}

/** The better of two candidates, or the only one when there is no current. */
function betterCandidate<T extends ProjectModelRoute>(
  current: RouteCandidate<T> | undefined,
  candidate: RouteCandidate<T>,
): RouteCandidate<T> {
  if (!current) return candidate;
  return isBetterRoot(candidate.root, candidate.routeKey, current.root, current.routeKey)
    ? candidate
    : current;
}

/**
 * The containment lookup that resolves a directory to the route that governs it.
 *
 * The rule is the same for the launch permission and for the model gate:
 * 1. the exact canonical folder of the route wins;
 * 2. then the same folder in another case;
 * 3. then a declared alias of the route;
 * 4. and finally the route root that contains the directory.
 *
 * A directory inside a routed project is governed by the rules of that project,
 * so a session cannot escape them by starting in a subdirectory.
 *
 * The root of a route is the canonical path of its key. An alias resolves to the
 * root of its route, but an alias is never a root itself: containment is only
 * ever tested against the canonical path a route is configured under.
 *
 * Containment is a segment boundary, not a string prefix. The root `/a/b`
 * contains `/a/b/c` and does not contain `/a/bc` nor `/a/b-backup`, so a
 * sibling project cannot be captured by a common prefix.
 *
 * When several route roots contain the directory, the longest one wins: the
 * route of a subdirectory overrides the route of its parent. At an equal
 * length the lexicographically smaller canonical root wins, so the lookup
 * returns the same route whatever order the keys of the document have.
 *
 * The nesting is matched literally, because the production paths are
 * case-sensitive, while the exact folder and the alias are matched
 * case-insensitively, exactly as before.
 *
 * This lookup answers the question "which model is allowed in this project and
 * which route governs it". The question "which project is this directory" is
 * answered by {@link findProjectRouteIdentity}, which knows no containment.
 */
// TODO(owner of src/integrator-fleet-runtime.ts): that file resolves a route by
// exact key and alias only (src/integrator-fleet-runtime.ts:382) and reports
// project_route_ambiguous when more than one route matches. Its contract is a
// single route whose first harness is codex, so switching it to containment
// would change which project a launch belongs to. It must not be changed
// silently: if its owner agrees, it should call this lookup and keep the
// ambiguity check explicit.
export function findProjectModelRoute<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  directory: string,
): ProjectRouteResolution<T> | undefined {
  const identity = findProjectRouteIdentity(routes, directory);
  if (identity) return identity;
  if (!routes) return undefined;
  const key = normalizeProjectPath(directory);
  const entries = Object.entries(routes).map(([routeKey, route]) => ({
    route,
    routeKey,
    root: normalizeProjectPath(routeKey),
  }));

  // Nesting: the longest route root that contains the directory governs it.
  let nested: RouteCandidate<T> | undefined;
  for (const entry of entries) {
    if (!entry.root.startsWith("/")) continue;
    if (key !== entry.root && !key.startsWith(`${entry.root}/`)) continue;
    nested = betterCandidate(nested, entry);
  }
  if (nested) return { route: nested.route, routeKey: nested.routeKey, matchKind: "nested" };
  return undefined;
}

/**
 * The lookup that answers which project a directory is.
 *
 * The rule is the identity of a project: the exact canonical folder of the
 * route, then the same folder in another case, then a declared alias of the
 * route. A directory inside a routed project is not the project: it has no
 * route of its own, so it keeps its own working folder and its own work key.
 *
 * The containment of {@link findProjectModelRoute} belongs to the model
 * contour alone, where a directory inherits the rules and the model of the
 * project that contains it.
 */
export function findProjectRouteIdentity<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  directory: string,
): ProjectRouteResolution<T> | undefined {
  if (!routes) return undefined;
  const key = normalizeProjectPath(directory);
  const entries = Object.entries(routes).map(([routeKey, route]) => ({
    route,
    routeKey,
    root: normalizeProjectPath(routeKey),
  }));

  const exact = entries.find((entry) => entry.root === key);
  if (exact) return { route: exact.route, routeKey: exact.routeKey, matchKind: "exact" };
  const folded = foldProjectKey(key);

  // A case variant of the key is nearer to the key than a declared alias, so
  // the case is decided before the alias, whatever order the keys have.
  let byCase: RouteCandidate<T> | undefined;
  for (const entry of entries) {
    if (foldProjectKey(entry.root) !== folded) continue;
    byCase = betterCandidate(byCase, entry);
  }
  if (byCase) return { route: byCase.route, routeKey: byCase.routeKey, matchKind: "case" };

  let byAlias: RouteCandidate<T> | undefined;
  for (const entry of entries) {
    if (!entry.route.aliases?.some((alias) => foldProjectKey(alias) === folded)) continue;
    byAlias = betterCandidate(byAlias, entry);
  }
  if (byAlias) return { route: byAlias.route, routeKey: byAlias.routeKey, matchKind: "alias" };
  return undefined;
}

/**
 * Find the route that governs a project.
 *
 * A thin wrapper over the containment lookup {@link findProjectModelRoute}:
 * the exact canonical folder, its case variant, a declared alias and finally
 * the longest route root that contains the project. This is the lookup of the
 * model contour: the lists of a project are the lists of the route that
 * contains it.
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
 * A thin wrapper over the same containment lookup
 * {@link findProjectModelRoute}, because a session that runs in a subdirectory
 * of a project is governed by the rules of that project. The gate of the tools
 * and the model resolution of the launch share this one lookup.
 */
export function findModelPolicyRouteForPath<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  directory: string,
): T | undefined {
  return findProjectModelRoute(routes, directory)?.route;
}

/**
 * Find the route a directory IS, without the containment of a parent route.
 *
 * A thin wrapper over the identity lookup {@link findProjectRouteIdentity}:
 * the exact canonical folder, its case variant and a declared alias. It answers
 * which project a directory is, so it never returns the route of a parent
 * directory.
 */
export function findModelPolicyRouteIdentity<T extends ProjectModelRoute>(
  routes: Record<string, T> | undefined,
  project: string,
): T | undefined {
  return findProjectRouteIdentity(routes, project)?.route;
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
 * The project is resolved by the containment lookup, so a directory inside a
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
