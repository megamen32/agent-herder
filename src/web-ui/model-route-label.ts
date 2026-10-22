/**
 * The state of a model of a project, as the owner reads it.
 *
 * A model id in the panel is a name, and the names drift: an id that the
 * environment does not confirm any more is stale, and a plan the owner pays
 * for is not the same as a free one. The panel says which is which, so the
 * difference is visible before the route is saved and not after a refusal.
 *
 * The state of a route is a separate thing and it is not decided here: the
 * route behind an OmniRoute model is known to the node that holds the proof
 * of it, and the node decides whether a route that ends in codex, claude or
 * anthropic is closed for a project under the restriction.
 */

/** The plans the owner pays for. The owner keeps the paid route as the second one. */
export const PAID_MODEL_PLANS = ["minimax-coding-plan"] as const;

/** The state of a model of a project, in the words of the owner. */
export type ModelRouteState = "рабочая" | "устаревшая" | "платная";

/** The tone of the state: the colour of the badge, not the word of it. */
export type ModelRouteTone = "ok" | "stale" | "paid";

/** The state of a model and the reason of it. */
export interface ModelRouteLabel {
  /** The state, in the words of the owner. */
  state: ModelRouteState;
  /** The tone of the badge. */
  tone: ModelRouteTone;
  /** Why the model is in this state, in words. */
  reason: string;
}

/** The provider of a model id: the part before the slash. */
export function modelProvider(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "";
}

/**
 * The state of a model of a project.
 *
 * A model the environment does not confirm is stale: its route cannot be
 * verified, and the request of it is refused by the guard of the node. A
 * model of a plan the owner pays for is paid, and the owner keeps it as the
 * second one. The rest is working: the environment confirms it.
 *
 * An empty catalog means the environment has not answered yet, and an unknown
 * state is not a state: the panel says nothing until the catalog is known.
 */
export function modelRouteLabel(input: {
  modelId: string;
  confirmed: readonly string[];
  paidPlans?: readonly string[];
}): ModelRouteLabel | undefined {
  const modelId = input.modelId.trim();
  if (!modelId) return undefined;
  if (input.confirmed.length === 0) return undefined;
  const paidPlans = input.paidPlans ?? PAID_MODEL_PLANS;
  if (!input.confirmed.includes(modelId)) {
    return {
      state: "устаревшая",
      tone: "stale",
      reason: "Маршрут не верифицируется: id отсутствует в каталоге моделей OpenCode.",
    };
  }
  const provider = modelProvider(modelId);
  if (provider && paidPlans.includes(provider)) {
    return {
      state: "платная",
      tone: "paid",
      reason: `Платный маршрут (${provider}). Владелец оставил его вторым.`,
    };
  }
  return {
    state: "рабочая",
    tone: "ok",
    reason: "Среда подтверждает этот маршрут.",
  };
}
