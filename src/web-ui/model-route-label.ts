/**
 * The state of a model of a project, as the owner reads it.
 *
 * A model id in the panel is a name, and the names drift: an id that the
 * environment does not confirm any more is stale. The panel says which is
 * which, so the difference is visible before the route is saved and not
 * after a refusal.
 *
 * The state of a route is a separate thing and it is not decided here: the
 * route behind an OmniRoute model is known to the node that holds the proof
 * of it, and the node decides whether a route that ends in codex, claude or
 * anthropic is closed for a project under the restriction.
 */

/** The state of a model of a project, in the words of the owner. */
export type ModelRouteState = "рабочая" | "устаревшая" | "не верифицирована" | "отказ";

/** The tone of the state: the colour of the badge, not the word of it. */
export type ModelRouteTone = "ok" | "stale" | "error";

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
 * verified, and the request of it is refused by the guard of the node. The
 * rest is working: the environment confirms it. The panel says nothing
 * about money: a subscription, a free pool and a metered route look the
 * same to the environment, and the name of the plan is part of the id.
 *
 * An empty catalog means the environment has not answered yet, and an unknown
 * state is not a state: the panel says nothing until the catalog is known.
 */
export function modelRouteLabel(input: {
  modelId: string;
  confirmed: readonly string[];
  /**
   * The verdict of the server about the launch of the route. It is the
   * authority for a closed project: the catalog says which models exist, and
   * the server says which route the launch will really take.
   */
  launch?: { verdict: "allowed" | "denied" | "unknown"; reason?: string };
}): ModelRouteLabel | undefined {
  const modelId = input.modelId.trim();
  if (!modelId) return undefined;
  if (input.confirmed.length === 0) return undefined;
  if (!input.confirmed.includes(modelId)) {
    return {
      state: "устаревшая",
      tone: "stale",
      reason: "Маршрут не верифицируется: id отсутствует в каталоге моделей OpenCode.",
    };
  }
  if (input.launch && input.launch.verdict === "unknown") {
    return {
      state: "не верифицирована",
      tone: "error",
      reason: "Сервер не подтвердил маршрут: провайдер за ним неизвестен, и защита среды отзовёт запуск.",
    };
  }
  if (input.launch && input.launch.verdict === "denied") {
    return {
      state: "отказ",
      tone: "error",
      reason: input.launch.reason === "closed-provider"
        ? "Сервер подтвердил: за маршрутом провайдер, закрытый правилом владельца."
        : "Сервер подтвердил: провайдер маршрута не входит в список разрешённых для закрытого проекта.",
    };
  }
  return {
    state: "рабочая",
    tone: "ok",
    reason: "Модель есть в каталоге моделей среды.",
  };
}
