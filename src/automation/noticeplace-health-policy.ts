import { isHealthPlanId, type HealthPlanId } from "../autopilot/notice-incident.js";

/**
 * The one model allowlist of Notice Place health work.
 *
 * The analysis of an incident and the repair of an incident must be able to
 * run on the same approved models, otherwise a repair can be refused for a
 * reason that the analysis never had. The list holds exactly the approved
 * MiniMax routes: the official subscription route and the OmniRoute gateway
 * route to the same upstream model. No other provider is allowed, and there
 * is no automatic fallback.
 */
export const NOTICEPLACE_HEALTH_MODELS: readonly string[] = [
  "omniroute/minimax/MiniMax-M3.1-Flash",
  "minimax-coding-plan/MiniMax-M3.1-Flash",
  "omniroute/glm-5.3-flash-minimax-m3.1",
];

/** True only for an approved Notice Place health model. */
export function isNoticeplaceHealthModel(value: unknown): value is string {
  return typeof value === "string" && NOTICEPLACE_HEALTH_MODELS.includes(value);
}

/** Where the plan of a launch was read from. */
export type LaunchPlanSource = "selected-plan" | "repair-first";

/**
 * The health plan of one launch request.
 *
 * The center states the selected plan in the launch message of a remediation
 * job. A repair-first job has no plan card yet: the center publishes its
 * repair-first progress under the repair plan, which is the same plan this
 * observer uses for such a launch.
 */
export interface LaunchHealthPlan {
  planId: HealthPlanId;
  source: LaunchPlanSource;
}

const SELECTED_PLAN_LINE = /^selected plan ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/m;
const SELECTED_PLAN_DETAILS = /selected plan details \(untrusted data\):\s*(\{[^}]*\})/;
/** The center's own marker of a repair-first launch, which has no plan card. */
const REPAIR_FIRST_MARKER = /repair-first/i;

/**
 * Read the health plan of a launch message.
 *
 * Returns undefined when the message states no plan at all: the caller must
 * then refuse to publish instead of guessing a plan, because the center only
 * accepts progress for the selected plan.
 */
export function resolveLaunchHealthPlan(message: string): LaunchHealthPlan | undefined {
  if (typeof message !== "string" || !message) return undefined;
  const details = SELECTED_PLAN_DETAILS.exec(message);
  if (details?.[1]) {
    try {
      const parsed = JSON.parse(details[1]) as { plan_id?: unknown };
      if (isHealthPlanId(parsed.plan_id)) return { planId: parsed.plan_id, source: "selected-plan" };
    } catch {
      // A malformed details block is not a plan; fall through to the line.
    }
  }
  const line = SELECTED_PLAN_LINE.exec(message);
  if (line?.[1] && isHealthPlanId(line[1])) return { planId: line[1], source: "selected-plan" };
  if (REPAIR_FIRST_MARKER.test(message)) return { planId: "repair", source: "repair-first" };
  return undefined;
}
