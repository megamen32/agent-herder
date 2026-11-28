// OmniRoute's discrete reasoning vocabulary and default-rule precedence.
export const efforts = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const taskClasses = ["investigation", "edit", "refactor", "architecture", "debug", "review", "monitor", "judge", "triage"] as const;
type Effort = typeof efforts[number];
type TaskClass = typeof taskClasses[number];
export interface TaskOptions {
  taskClass?: TaskClass;
  reasoningEffort?: Effort;
  latencySensitive?: boolean;
  serviceTier?: "normal" | "fast";
}

export function classifyTask(text: string): TaskClass {
  const title = text.trim().toLowerCase().slice(0, 240);
  const rules: [TaskClass, RegExp][] = [
    ["triage", /incident triage|urgent triage|аварийн.{0,12}разбор/],
    ["architecture", /architect|архитект/], ["refactor", /refactor|рефактор/],
    ["debug", /root cause|hard debug|первопричин/], ["review", /review|ревью/],
    ["monitor", /monitor|health check|монитор/], ["judge", /judge|вердикт/],
    ["investigation", /read.only|investigat|inspect|проверь|исслед/],
  ];
  return rules.find(([, pattern]) => pattern.test(title))?.[0] ?? "edit";
}

export interface ModelCapability {
  model?: string;
  id?: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  serviceTiers?: { id: string }[];
  additionalSpeedTiers?: string[];
}

export function chooseSettings(options: TaskOptions, task: TaskClass, model: ModelCapability | undefined, quotaAvailable: boolean) {
  const taskClass = options.taskClass ?? task;
  const desired: Effort = options.reasoningEffort ?? ({
    investigation: "low", monitor: "low", judge: "low", edit: "medium", review: "medium",
    triage: "medium", architecture: "high", refactor: "high", debug: "high",
  } as const)[taskClass];
  const supported = efforts.filter(e => model?.supportedReasoningEfforts?.some(row => row.reasoningEffort === e));
  if (options.reasoningEffort && !supported.includes(options.reasoningEffort))
    throw new Error(`Model does not advertise requested reasoning effort '${options.reasoningEffort}'`);
  const reasoningEffort = supported.filter(e => efforts.indexOf(e) <= efforts.indexOf(desired)).at(-1) ?? supported[0];
  const wantsFast = options.serviceTier === "fast" || (options.serviceTier !== "normal" && (options.latencySensitive ?? taskClass === "triage"));
  const tiers = model?.serviceTiers?.map(row => row.id) ?? model?.additionalSpeedTiers ?? [];
  const supportsFast = tiers.some(id => id === "fast" || id === "priority");
  const serviceTier = wantsFast && supportsFast && quotaAvailable ? "fast" as const : "normal" as const;
  let tierReason = options.serviceTier ? "caller" : "standard";
  if (wantsFast) {
    if (!supportsFast) tierReason = "fast_not_advertised";
    else if (!quotaAvailable) tierReason = "reserve_unavailable";
    else if (!options.serviceTier) tierReason = "latency_sensitive";
  }
  let effortReason: string = taskClass;
  if (!reasoningEffort) effortReason = "catalog_unknown";
  else if (options.reasoningEffort) effortReason = "caller";
  else if (reasoningEffort !== desired) effortReason = "model_capability";
  return { model: model?.model ?? model?.id ?? null, taskClass, reasoningEffort, serviceTier, effortReason, tierReason };
}
export type SettingsDecision = ReturnType<typeof chooseSettings>;

export function taskOptions(input: TaskOptions, message?: string): TaskOptions {
  const taskClass = input.taskClass ?? (message ? classifyTask(message) : undefined);
  return {
    ...(taskClass && { taskClass }),
    ...(input.reasoningEffort && { reasoningEffort: input.reasoningEffort }),
    ...(input.latencySensitive !== undefined && { latencySensitive: input.latencySensitive }),
    ...(input.serviceTier && { serviceTier: input.serviceTier }),
  };
}
