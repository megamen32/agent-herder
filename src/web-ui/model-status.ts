/**
 * The status of a model for the owner.
 *
 * The screen of the projects answers one question: what happens with this
 * model in this project, and what do I press to fix it. The answer has three
 * parts, and every part is computed from data the panel already has:
 *
 * - the rule of the owner: codex, claude and anthropic are closed for the
 *   closed projects;
 * - the two lists of the project: what the project may run and what it must
 *   never run;
 * - the environment: the list of the models it confirms (`/api/models`).
 *
 * Nothing here guesses by the shape of the id: whether the environment sends a
 * model is answered by the list of the environment, and the list of the
 * project is answered by the same rule the gate of the launch uses
 * (`modelMatchesEntry`).
 */

import { modelMatchesEntry } from "../project-model-gate.js";
import { DEFAULT_PROFILES } from "../web/settings-catalog.js";

/** The same rule of the guard of the OpenCode integration: codex, claude, anthropic. */
const RESTRICTED_MODEL_TOKEN = /(^|[^a-z0-9])(codex|claude|anthropic)([^a-z0-9]|$)/i;

/** True when the route leads to a provider the rule of the owner closes. */
export function hasRestrictedProviderToken(modelId: string): boolean {
  return RESTRICTED_MODEL_TOKEN.test(modelId);
}

/**
 * The providers of a paid plan.
 *
 * A plan is a subscription with its own quota: `minimax-coding-plan/*`,
 * `zai-coding-plan/*`, `account:*` and `builtin:*`. The plan is not a route of
 * Herder: the gateway route of the model is named another way, and the plan
 * runs out of its quota on its own.
 */
const PAID_ROUTE_PATTERN = /(coding-plan|^account:|^builtin:)/i;

/** True when the id belongs to a paid plan. */
export function isPaidRoute(modelId: string): boolean {
  return PAID_ROUTE_PATTERN.test(modelId.trim());
}

/**
 * The patterns of the paid routes.
 *
 * The one-click action of the denied list writes exactly these, so the owner
 * never types a pattern by hand.
 */
export const PAID_ROUTE_PATTERNS: readonly string[] = [
  "minimax-coding-plan/*",
  "zai-coding-plan/*",
  "account:*",
  "builtin:*",
];

/**
 * The id the environment runs for a harness when the project names none.
 *
 * The profile of the product is the first answer: it is the route the product
 * ships with. The global model of the harness is the second one, and the
 * confirmed list is the last resort. An id that the environment does not
 * confirm is never offered.
 */
export function workingModelId(
  harness: string,
  options: { policyModels?: Record<string, string>; confirmed?: string[] } = {},
): string {
  const confirmed = options.confirmed ?? [];
  const profile = DEFAULT_PROFILES.find((item) => item.harness === harness)?.model;
  const global = options.policyModels?.[harness];
  for (const candidate of [profile, global]) {
    const id = candidate?.trim();
    if (id && confirmed.includes(id)) return id;
  }
  return confirmed[0]?.trim() ?? "";
}

/** What the panel knows about one model id. */
export type ModelVerdictKind =
  | "works"
  | "paid"
  | "unconfirmed"
  | "noModels"
  | "missing"
  | "closed"
  | "denied"
  | "notAllowed";

/** How the status is shown: a word and a colour, never a colour alone. */
export type ModelVerdictTone = "ok" | "warn" | "error" | "unknown";

/** The verdict of one model of one project. */
export type ModelVerdict = {
  kind: ModelVerdictKind;
  /** One word for the owner: what happens with this model. */
  label: string;
  /** Why it is so, in one sentence. */
  detail: string;
  /** The reason of the card of the block. */
  reason: string;
  /** What to press. Empty when there is nothing to press. */
  action: string;
  tone: ModelVerdictTone;
  /** True when the model belongs to a paid plan. */
  paid: boolean;
  /** The id that works instead, when this one does not. */
  worksInstead?: string;
};

/** The status of one model, in the words of the owner. */
export const MODEL_VERDICT_LABELS: Readonly<Record<ModelVerdictKind, string>> = {
  works: "Работает",
  paid: "Платный маршрут — среда его не отправляет",
  unconfirmed: "Среда не подтверждает этот id",
  noModels: "Среда не подтвердила ни одной модели",
  missing: "Модель не задана",
  closed: "Закрыт правилом владельца",
  denied: "Запрещена в списке проекта",
  notAllowed: "Нет в списке разрешённых проекта",
};

/**
 * What the operator has to do when a model request is blocked.
 *
 * The answer is a button, not a rule: the panel knows the model of the
 * environment and can write it into the route of the project.
 */
export const BLOCKED_MODEL_ACTION = "Нажмите «Поставить рабочую модель» — панель запишет в маршрут проекта id, который среда подтверждает.";

/**
 * The short status of a model, for the list of the suggestions.
 *
 * The list of the suggestions has one line per model, so the status there is
 * one word: what the owner has to know before he picks the model.
 */
export const MODEL_STATUS_WORDS = {
  works: "Работает",
  unconfirmed: "Не подтверждена",
  paid: "Платная",
  closed: "Закрыта правилом",
} as const;

/**
 * The verdict of one model of one project.
 *
 * The order of the checks is the order of the rules that decide a launch: the
 * rule of the owner comes first, then the lists of the project, and the
 * environment last. A closed provider is a block even when the environment
 * knows the model.
 */
export function modelVerdict(input: {
  harness: string;
  model: string;
  confirmed: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  restricted?: boolean;
  workingModel?: string;
}): ModelVerdict {
  const model = input.model.trim();
  const confirmed = input.confirmed ?? [];
  const allowed = input.allowedModels ?? [];
  const denied = input.deniedModels ?? [];
  const restricted = Boolean(input.restricted);
  const working = input.workingModel?.trim()
    || workingModelId(input.harness, { confirmed });
  const paid = isPaidRoute(model);
  const put = working
    ? `Нажмите «Поставить рабочую модель» — запишется ${working}.`
    : BLOCKED_MODEL_ACTION;

  if (!model) {
    return {
      kind: "missing",
      label: MODEL_VERDICT_LABELS.missing,
      detail: "Ни маршрут проекта, ни общая модель среды не называют модель.",
      reason: "модель не задана",
      action: "",
      tone: "unknown",
      paid: false,
    };
  }
  if (restricted && hasRestrictedProviderToken(model)) {
    return {
      kind: "closed",
      label: MODEL_VERDICT_LABELS.closed,
      detail: "Провайдер codex, claude или anthropic закрыт правилом владельца для этого проекта.",
      reason: "маршрут ведёт к провайдеру, который закрыт правилом владельца (codex, claude или anthropic)",
      action: put,
      tone: "error",
      paid: false,
    };
  }
  const deniedEntry = denied.find((entry) => modelMatchesEntry(model, entry));
  if (deniedEntry) {
    return {
      kind: "denied",
      label: MODEL_VERDICT_LABELS.denied,
      detail: `Модель попала в «Запрещённые модели» этого проекта (${deniedEntry}).`,
      reason: `модель запрещена в списке проекта (${deniedEntry})`,
      action: `Уберите модель из «Запрещённых моделей» или ${put.charAt(0).toLowerCase()}${put.slice(1)}`,
      tone: "error",
      paid: false,
    };
  }
  if (allowed.length > 0 && !allowed.some((entry) => modelMatchesEntry(model, entry))) {
    return {
      kind: "notAllowed",
      label: MODEL_VERDICT_LABELS.notAllowed,
      detail: "В «Разрешённых моделях» этого проекта есть список, и этой модели в нём нет.",
      reason: "модели нет в списке разрешённых моделей проекта",
      action: `Нажмите «Добавить в разрешённые» или «Поставить рабочую модель» — запишется ${working || "рабочая модель среды"}.`,
      tone: "error",
      paid: false,
    };
  }
  if (confirmed.length === 0) {
    return {
      kind: "noModels",
      label: MODEL_VERDICT_LABELS.noModels,
      detail: "Список моделей среды пуст — проверить нечего, это не значит, что модель плохая.",
      reason: "среда не подтвердила ни одной модели",
      action: "",
      tone: "unknown",
      paid: false,
    };
  }
  if (!confirmed.includes(model)) {
    return {
      kind: "unconfirmed",
      label: MODEL_VERDICT_LABELS.unconfirmed,
      detail: "В списке моделей среды этого id нет. Запуск на ней не пройдёт.",
      reason: restricted
        ? "маршрут не совпал с подтверждённым нативным маршрутом среды"
        : "модели нет в списке моделей среды — среда её не подтверждает",
      action: put,
      tone: restricted ? "error" : "warn",
      paid,
      worksInstead: working || undefined,
    };
  }
  // The plan of the OpenCode environment is not a route of Herder: the
  // environment sends the model by the subscription of the plan, and the plan
  // has its own quota.
  if (paid && input.harness === "opencode") {
    return {
      kind: "paid",
      label: MODEL_VERDICT_LABELS.paid,
      detail: `Это платный план (${model.split("/")[0]}). Рабочий маршрут этой среды: ${working || "не найден"}.`,
      reason: "платный маршрут: среда его не отправляет",
      action: put,
      tone: restricted ? "error" : "warn",
      paid: true,
      worksInstead: working || undefined,
    };
  }
  return {
    kind: "works",
    label: MODEL_VERDICT_LABELS.works,
    detail: "Среда подтверждает этот id: модель будет отправлена в среду.",
    reason: "",
    action: "",
    tone: "ok",
    paid,
  };
}

/**
 * The entries of the allowed list that no model of the environment matches.
 *
 * Such an entry is a typo or a wish, not a rule: «все модели» matches no id
 * at all, so every model of the project is refused by the gate.
 */
export function unusedListEntries(entries: string[], knownIds: string[]): string[] {
  return (entries ?? []).filter((entry) => {
    const rule = entry.trim();
    if (!rule || rule === "*") return false;
    return !knownIds.some((id) => modelMatchesEntry(id, rule));
  });
}

/**
 * Explain a server error about the lists of models in Russian.
 *
 * The server speaks English and names the fields of the document; the owner
 * reads the form. Every known message of the validation of the lists is
 * translated, and the text says what to do.
 */
export function explainModelListError(message: string): string {
  const text = String(message ?? "");
  const field = text.match(/\b(allowedModels|deniedModels)\b/)?.[1];
  const list = field === "deniedModels"
    ? "«Запрещённые модели»"
    : field === "allowedModels"
      ? "«Разрешённые модели»"
      : "Список моделей";
  const model = text.match(/model '([^']*)'/)?.[1] ?? "";
  if (text.includes("as allowed and as denied at the same time")) {
    return `Модель «${model}» стоит и в «Разрешённых моделях», и в «Запрещённых». Уберите её из одного списка.`;
  }
  if (text.includes("repeats model")) {
    return `${list}: модель «${model}» повторяется дважды. Уберите дубль.`;
  }
  if (text.includes("must be an array")) {
    return `${list}: список должен быть списком моделей.`;
  }
  if (text.includes("must not hold more than 64 models")) {
    return `${list}: в списке больше 64 моделей. Оставьте только нужные.`;
  }
  if (text.includes("entries must be nonempty model IDs")) {
    return `${list}: в списке есть пустая строка. Уберите её или впишите id модели.`;
  }
  if (text.includes("entries must be at most 256 characters")) {
    return `${list}: id модели длиннее 256 символов. Впишите короче.`;
  }
  if (text.includes("entries must not contain control characters")) {
    return `${list}: в записи есть служебные символы. Оставьте только id модели.`;
  }
  return text;
}
