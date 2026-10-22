/**
 * The one gate that decides whether a model may be applied to a project.
 *
 * Both the launch resolution and the explicit model tools ask this module, so
 * a denied model cannot reach a launch through one path while another path
 * still allows it.
 *
 * The module is free of node imports: it only reads the plain shape of the
 * policy document, so the web UI can reuse the same rules to warn the operator
 * before a route is saved.
 */

import {
  ModelNotPermittedError,
  assertModelPermittedForProject,
  effectiveModelForProject,
  findModelPolicyRoute,
  findModelPolicyRouteForPath,
  findProjectModelRoute,
  modelMatchesEntry,
  modelPermittedForRoute,
  type ProjectModelPolicy,
} from "./project-model-policy.js";

export {
  MODEL_NOT_PERMITTED_CODE,
  ModelNotPermittedError,
  assertModelPermittedForProject,
  conflictingModelEntries,
  findModelPolicyRoute,
  findModelPolicyRouteForPath,
  findProjectModelRoute,
  modelMatchesEntry,
  modelPermittedForProject,
  modelPermittedForRoute,
  normalizeModelEntry,
  type ProjectModelPolicy,
  type ProjectModelRoute,
  type ProjectRouteMatchKind,
  type ProjectRouteResolution,
} from "./project-model-policy.js";

/**
 * Reads the current launch policy.
 *
 * The provider resolves to undefined when no usable policy document exists.
 * A document without a project route leaves the global policy unchanged, so
 * an absent policy means no per-project restriction at all.
 */
export type ProjectModelPolicyProvider = () => Promise<ProjectModelPolicy | undefined>;

/** The effective model of one harness of a route: the route model wins over the global one. */
export function effectiveRouteModel(
  route: { models?: Record<string, string> },
  harness: string,
  globalModels: Record<string, string>,
): string | undefined {
  return route.models?.[harness] ?? globalModels[harness];
}

/**
 * Why an effective model is not usable in its project.
 *
 * `denied` means the project forbids the model outright. `not_allowed` means
 * the project lists the allowed models and this one is not among them.
 */
export type RouteModelViolation = "denied" | "not_allowed";

/** The violation of one effective model, or undefined when the model is usable. */
export function routeModelViolation(
  route: { allowedModels?: string[]; deniedModels?: string[] },
  model: string | undefined,
): RouteModelViolation | undefined {
  if (!model) return undefined;
  const denied = route.deniedModels ?? [];
  if (denied.some((entry) => modelMatchesEntry(model, entry))) return "denied";
  const allowed = route.allowedModels ?? [];
  if (allowed.length === 0) return undefined;
  return allowed.some((entry) => modelMatchesEntry(model, entry)) ? undefined : "not_allowed";
}

/**
 * Reject an explicitly requested model that the project does not permit.
 *
 * The project is resolved from the working directory the same way the launch
 * route is resolved, so a route reached by an alias is enforced too.
 */
export async function assertModelAllowedForProject(
  provider: ProjectModelPolicyProvider | undefined,
  project: string,
  model: string | undefined,
): Promise<void> {
  if (!model || !provider) return;
  const policy = await provider();
  if (!policy) return;
  assertModelPermittedForProject(policy, project, model);
}

/**
 * Reject a model the caller named that the route of the project forbids.
 *
 * The launch path judges the effective model of the route: the model the route
 * configures for the harness. A request may carry another model, and on the
 * analysis path that model is the one that really starts, so the lists of the
 * route have to judge it too. Without this check the lists of a project stay
 * incomplete: they permit the model of the route and never see the model of
 * the request.
 *
 * The route is resolved by the one shared lookup, so a project is judged by the
 * rules of the route that governs it. A project without a route keeps the
 * global policy and is not checked.
 */
export function assertModelAllowedForProjectRoute(
  policy: ProjectModelPolicy | undefined,
  project: string,
  model: string | undefined,
): void {
  if (!policy || !model) return;
  const resolution = findProjectModelRoute(policy.projectRoutes, project);
  if (!resolution) return;
  if (modelPermittedForRoute(resolution.route, model)) return;
  throw new ModelNotPermittedError(
    project,
    model,
    resolution.route.allowedModels ?? [],
    resolution.route.deniedModels ?? [],
  );
}

/**
 * Does the policy restrict the models of any project at all?
 *
 * A gate that has nothing to enforce must not make the caller do extra work.
 */
export function policyRestrictsModels(policy: ProjectModelPolicy | undefined): boolean {
  if (!policy?.projectRoutes) return false;
  return Object.values(policy.projectRoutes).some((route) =>
    (route.allowedModels?.length ?? 0) > 0 || (route.deniedModels?.length ?? 0) > 0);
}

/**
 * Reject an explicitly requested model for a session working directory.
 *
 * A session may run in a subdirectory of its project, so the governing route is
 * the one that contains that directory. The route is resolved by the one
 * shared lookup, the same one the launch permission uses, so a directory can
 * never be launched by one rule and policed by another.
 *
 * When the caller names no model, the model the project would run on for that
 * harness decides: a project that forbids its own model must not start a
 * session on it, not even through the default of the harness.
 */
export function assertModelAllowedForDirectory(
  policy: ProjectModelPolicy | undefined,
  directory: string,
  model: string | undefined,
  harness?: string,
): void {
  if (!policy) return;
  const route = findModelPolicyRouteForPath(policy.projectRoutes, directory);
  if (!route) return;
  const effective = model ?? (harness ? effectiveModelForProject(policy, directory, harness) : undefined);
  if (!effective) return;
  if (modelPermittedForRoute(route, effective)) return;
  throw new ModelNotPermittedError(
    directory,
    effective,
    route.allowedModels ?? [],
    route.deniedModels ?? [],
  );
}

/**
 * Reject an explicitly requested model of a working directory, reading the
 * current policy first.
 */
export async function assertModelAllowedForDirectoryWithPolicy(
  provider: ProjectModelPolicyProvider | undefined,
  directory: string,
  model: string | undefined,
  harness?: string,
): Promise<void> {
  if (!provider) return;
  const policy = await provider();
  if (!policy) return;
  assertModelAllowedForDirectory(policy, directory, model, harness);
}
