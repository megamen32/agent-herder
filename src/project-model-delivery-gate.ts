/**
 * The per-project model gate for deliveries.
 *
 * The tool gate protects a session that herder creates itself. A session that
 * was born outside herder's tools - a note delivered into a native session, or
 * a session the user started in the app - never passed through that gate, so
 * a model that a project forbids could still run in that project.
 *
 * This module closes that hole for every delivery: the model the session would
 * run on is checked against the same project lists the tool gate uses, and an
 * uncertain answer refuses the delivery instead of allowing it.
 *
 * The rules are the rules of the tool gate:
 * - the project is the route that contains the working directory of the
 *   session: exact path, then case-folded path, then a declared alias, then
 *   the longest containing root;
 * - a delivery that names a model is checked against that model, a delivery
 *   that names none is checked against the model the project would run on for
 *   the harness of the session (route model first, global model otherwise);
 * - a project without a route keeps the global policy and is unaffected.
 *
 * Two answers are not the tool gate's business and are decided here: a policy
 * document that cannot be read, and a session whose working directory is
 * unknown. Both refuse the delivery, because an unreadable rule is not a
 * permission.
 */

import {
  ModelNotPermittedError,
  assertModelAllowedForDirectory,
  findModelPolicyRouteForPath,
  policyRestrictsModels,
  type ProjectModelPolicy,
} from "./project-model-gate.js";

/** The state of the stored policy document: absent, readable or broken. */
export type ProjectModelPolicyState =
  | { kind: "absent" }
  | { kind: "valid"; policy: ProjectModelPolicy }
  | { kind: "invalid"; error: string };

/** Reads the current policy document with its state, not only its content. */
export type ProjectModelPolicyStateProvider = () => Promise<ProjectModelPolicyState>;

/** Why a delivery was refused. */
export type DeliveryModelRefusalReason =
  | "model_not_permitted"
  | "project_model_policy_unreadable"
  | "session_work_directory_unknown";

/**
 * A delivery the project policy does not allow.
 *
 * It is a `ModelNotPermittedError`, so every caller of the tool gate reads the
 * same code and the same shape of answer.
 */
export class DeliveryModelRefusedError extends ModelNotPermittedError {
  constructor(
    project: string,
    model: string,
    readonly refusalReason: DeliveryModelRefusalReason,
    detail: string,
  ) {
    super(project, model, [], []);
    this.message = detail.startsWith(this.code) ? detail : `${this.code}: ${detail}`;
    this.name = "DeliveryModelRefusedError";
  }
}

/** What one delivery is checked against. */
export interface DeliveryModelCheck {
  /** The working directory of the session, or null when it is unknown. */
  directory: string | null;
  /** The harness that runs the session. */
  harness: string;
  /** The model the delivery names, when it names one. */
  model?: string;
}

/**
 * The working directory of a session, as the project policy sees it.
 *
 * The declared work place of the session wins: it is the directory the
 * session really works in. A harness that reports a pseudo project (one
 * working directory for the whole runtime) does not know where its session
 * works, so its work directory stays unknown until the session declares it.
 */
export function resolveSessionWorkDirectory(
  session: { id: string; cwd: string; meta?: Record<string, unknown> } | null | undefined,
  declaredCwd?: string | null,
): string | null {
  const declared = typeof declaredCwd === "string" ? declaredCwd.trim() : "";
  if (declared) return declared;
  if (!session) return null;
  if (session.meta?.workDirectory === "pseudo") return null;
  const cwd = typeof session.cwd === "string" ? session.cwd.trim() : "";
  return cwd || null;
}

/**
 * The model the delivery would run on, or undefined when there is none.
 *
 * A named model wins. Otherwise the project route of the session decides for
 * its harness, and the global policy of the harness decides when the project
 * has no route of its own.
 */
export function deliveryEffectiveModel(
  policy: ProjectModelPolicy | undefined,
  directory: string | null,
  harness: string,
  model?: string,
): string | undefined {
  if (model) return model;
  if (!policy) return undefined;
  const route = directory ? findModelPolicyRouteForPath(policy.projectRoutes, directory) : undefined;
  return route?.models?.[harness] ?? policy.models?.[harness];
}

/**
 * Check one delivery against the project model policy.
 *
 * Throws a `ModelNotPermittedError` when the delivery must not happen, and
 * returns quietly when it may.
 */
export function checkDeliveryModel(state: ProjectModelPolicyState, check: DeliveryModelCheck): void {
  if (state.kind === "invalid") {
    throw new DeliveryModelRefusedError(
      "unknown",
      "unknown",
      "project_model_policy_unreadable",
      `the project model policy cannot be read (${state.error}), so no delivery may start work in a project that restricts models`,
    );
  }
  const policy = state.kind === "valid" ? state.policy : undefined;
  // A policy without per-project model lists restricts nothing at all.
  if (!policyRestrictsModels(policy)) return;
  const effective = deliveryEffectiveModel(policy, check.directory, check.harness, check.model);
  if (!check.directory) {
    throw new DeliveryModelRefusedError(
      "unknown",
      effective ?? "unknown",
      "session_work_directory_unknown",
      `the working directory of the session is unknown, so the project model policy of model "${effective ?? "unknown"}" cannot be checked; declare the work place of the session first`,
    );
  }
  if (!effective) return;
  try {
    assertModelAllowedForDirectory(policy, check.directory, check.model, check.harness);
  } catch (error) {
    if (error instanceof ModelNotPermittedError) {
      throw new DeliveryModelRefusedError(error.project, error.model, "model_not_permitted", error.message);
    }
    throw error;
  }
}

/** The refusal of one delivery, as the sender reads it. */
export function deliveryRefusalText(error: unknown): string {
  if (error instanceof DeliveryModelRefusedError) return error.message;
  if (error instanceof ModelNotPermittedError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
