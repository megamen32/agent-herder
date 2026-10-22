import * as React from "react";
import {
  labelFor,
  mergeProjectRouteParts,
  moveProjectRouteHarness,
  normalizeProjectKey,
  removeProjectRouteHarness,
  removeProjectRouteModelList,
  routeInputId,
  sameProjectRoute,
  updateProjectRouteModel,
  updateProjectRouteModelList,
  useHarnessModelCatalog,
  useLaunchPolicyDraft,
  useRuntimeModels,
  type LaunchPolicy,
  type LaunchRuntimeOption,
  type PolicyMergeContext,
  type PolicyMergeResult,
  type ProjectLaunchRoute,
} from "./launch-policy-settings.js";
import { conflictingModelEntries, modelMatchesEntry, routeModelViolation } from "../project-model-gate.js";
import { modelRouteLabel } from "./model-route-label.js";
import {
  MODEL_STATUS_WORDS,
  MODEL_VERDICT_LABELS,
  explainModelListError,
  hasRestrictedProviderToken,
  modelVerdict,
  unusedListEntries,
  workingModelId,
  type ModelVerdict,
} from "./model-status.js";
import { machineName } from "./fleet/machine-labels.js";

export { BLOCKED_MODEL_ACTION, hasRestrictedProviderToken } from "./model-status.js";

/**
 * The Projects screen of the panel.
 *
 * The screen shows one collapsed row per project: the human name of the
 * project, the machine it runs on, how many environments and models it has and
 * when it changed last. Everything else lives inside the row, so the list of
 * the projects is readable at a glance instead of a wall of open cards.
 *
 * The facts of the machine and of the freshness come from the fleet of the
 * panel itself: `/api/fleet/hosts` names the machines and `/api/fleet/sessions`
 * says where the sessions of the project run and when they were last active.
 */

/**
 * Merge the edited project routes into a newer document.
 *
 * Only the parts the operator changed are carried over. The merge is per part:
 * an edit of the model lists of a project does not overwrite a route change
 * that happened elsewhere at the same time, and the other way round. A part
 * both sides changed is a real conflict: the server value survives, the
 * operator's draft stays in the form, and the project is reported.
 */
export function mergeProjectRoutes({ base, fresh, draft, kept }: PolicyMergeContext): PolicyMergeResult {
  const baseRoutes = base.projectRoutes ?? {};
  const freshRoutes = fresh.projectRoutes ?? {};
  const draftRoutes = draft.projectRoutes ?? {};
  const merged: Record<string, ProjectLaunchRoute> = { ...freshRoutes };
  const nextKept: Record<string, ProjectLaunchRoute | undefined> = {};
  const conflicts: string[] = [];

  const keys = new Set([...Object.keys(baseRoutes), ...Object.keys(draftRoutes)]);
  for (const key of keys) {
    const baseValue = baseRoutes[key];
    const draftValue = draftRoutes[key];
    if (sameProjectRoute(baseValue, draftValue)) continue;
    const frozen = kept[key];
    if (key in kept && sameProjectRoute(frozen, draftValue)) {
      // The operator already lost this project once and has not re-edited it.
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    const freshValue = freshRoutes[key];
    if (draftValue === undefined) {
      // The operator removed the project.
      if (sameProjectRoute(baseValue, freshValue)) {
        delete merged[key];
        continue;
      }
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    if (baseValue === undefined) {
      // The operator added the project.
      if (freshValue === undefined) {
        merged[key] = draftValue;
        continue;
      }
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    const result = mergeProjectRouteParts(baseValue, freshValue, draftValue);
    if (result.route === undefined) delete merged[key];
    else merged[key] = result.route;
    if (result.conflict) {
      conflicts.push(key);
      nextKept[key] = draftValue;
    }
  }
  return { merged: { ...fresh, projectRoutes: merged }, conflicts, kept: nextKept };
}

/* ---------- Данные флота: машина и свежесть проекта ---------- */

/** One machine of the fleet as the panel knows it. */
export type FleetHostFact = { hostId: string; label: string; state: string; reason?: string };

/** One session of the fleet, reduced to the facts a project row needs. */
export type FleetSessionFact = { hostId: string; launchCwd: string; lastActivity: string; model: string };

/** The state of one machine for one project: did it answer, does it run it. */
export type ProjectNodeState = { hostId: string; label: string; answered: boolean; applies: boolean };

/** How the state of a project is shown: an icon and a word, never a colour alone. */
export type ProjectStateTone = "done" | "partial" | "unknown";
export type ProjectStateView = { icon: string; label: string; detail: string; tone: ProjectStateTone };

/** One project of the list with everything the row needs. */
export type ProjectEntry = {
  project: string;
  route: ProjectLaunchRoute;
  name: string;
  aliases: string[];
  hostId: string;
  hostLabel: string;
  lastActivity: string;
  environmentCount: number;
  modelCount: number;
  nodeStates: ProjectNodeState[];
};

/** The order of the list of the projects. */
export type ProjectSort = "recent" | "machine" | "name";

/** The switcher of the order of the list, as the operator sees it. */
export const PROJECT_SORT_LABELS: ReadonlyArray<readonly [ProjectSort, string]> = [
  ["recent", "Недавние"],
  ["machine", "По машине"],
  ["name", "По имени"],
];

/**
 * The closed projects of the rule of the owner.
 *
 * The guard of the OpenCode integration is the source of truth:
 * `integrations/opencode/agent-herder-autopilot.js` (`restrictedProjectRoots`).
 * The list is repeated here only so the screen can explain a block in plain
 * words; the guard itself is never touched by this screen.
 */
export const RESTRICTED_PROJECT_ROOTS: readonly string[] = [
  "/home/roomhacker/PycharmProjects/TelegramAuto",
  "/home/roomhacker/PycharmProjects/video_watching",
];

/* ---------- Общие мелочи: путь, склонение, время ---------- */

/** The path without its trailing slash. */
export function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** True when the working directory lies inside the project folder. */
export function pathInsideProject(project: string, cwd: string): boolean {
  const left = normalizePath(project);
  const right = normalizePath(cwd);
  if (!left || !right) return false;
  return right === left || right.startsWith(`${left}/`);
}

/** The Russian plural of a count: 1 среда, 2 среды, 5 сред. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** The moment of the last change as a number, so the rows can be sorted. */
export function activityValue(iso: string): number {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

/** The last change in words: «5 минут назад». */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "время неизвестно";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${plural(months, "месяц", "месяца", "месяцев")} назад`;
  const years = Math.floor(months / 12);
  return `${years} ${plural(years, "год", "года", "лет")} назад`;
}

/** The same moment in full, for the tooltip of the row. */
export function absoluteTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("ru-RU");
}

/* ---------- Имя проекта, поиск, порядок, группировка ---------- */

/** The human name of the project: the first card identifier, else the folder name. */
export function projectName(project: string, route: ProjectLaunchRoute): string {
  const alias = (route.aliases ?? []).map((item) => item.trim()).filter(Boolean)[0];
  if (alias) return alias;
  const segments = normalizePath(project).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? project;
}

/** The search over the projects: the name, the path and the machine. */
export function filterProjectEntries(entries: ProjectEntry[], query: string): ProjectEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    entry.name.toLowerCase().includes(needle)
    || entry.aliases.some((alias) => alias.toLowerCase().includes(needle))
    || entry.project.toLowerCase().includes(needle)
    || entry.hostId.toLowerCase().includes(needle)
    || entry.hostLabel.toLowerCase().includes(needle));
}

/** The order of the list: by the last change, or by the name. */
export function sortProjectEntries(entries: ProjectEntry[], sort: ProjectSort): ProjectEntry[] {
  const copy = [...entries];
  if (sort === "name") {
    return copy.sort((left, right) => left.name.localeCompare(right.name, "ru") || left.project.localeCompare(right.project));
  }
  return copy.sort((left, right) =>
    activityValue(right.lastActivity) - activityValue(left.lastActivity)
    || left.name.localeCompare(right.name, "ru"));
}

/** The projects grouped by the machine they run on. */
export function groupProjectEntriesByMachine(entries: ProjectEntry[]): Array<{ hostId: string; label: string; entries: ProjectEntry[] }> {
  const groups = new Map<string, { hostId: string; label: string; entries: ProjectEntry[] }>();
  for (const entry of entries) {
    const key = entry.hostId || "unknown";
    const group = groups.get(key) ?? { hostId: entry.hostId, label: entry.hostLabel || "Машина неизвестна", entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  // The groups follow the freshness of their projects, so the machine that
  // worked last is the first one the operator sees.
  return [...groups.values()].sort((left, right) =>
    Math.max(...right.entries.map((entry) => activityValue(entry.lastActivity)))
      - Math.max(...left.entries.map((entry) => activityValue(entry.lastActivity)))
    || left.label.localeCompare(right.label, "ru"));
}

/* ---------- Список известных папок: мусор убран ---------- */

/** The parts of a path that never belong to a real project of the operator. */
const JUNK_PATH_PARTS = new Set([
  ".cache", ".codex", ".npm", ".local", ".config", ".cargo", ".rustup", ".bun", ".yarn",
  "node_modules", ".venv", "venv", "__pycache__", ".git", ".mypy_cache", ".pytest_cache",
  ".tmp", ".worktrees", "worktrees", "worktree", "tmp", "temp", "Library", ".Trash",
  ".mavis", ".agents", ".claude", ".codex-worktrees",
]);

/** True when the path is a real project folder and not a scratch copy of one. */
export function isRealProjectPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/")) return false;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => JUNK_PATH_PARTS.has(segment))) return false;
  const last = segments[segments.length - 1] ?? "";
  if (/^\.lhc-|\.lhc-|\.herder-|snapshot|scratch/i.test(last)) return false;
  return true;
}

/** The known project folders without the junk of the scratch copies. */
export function filterKnownProjectPaths(paths: string[]): string[] {
  return paths.filter((path) => isRealProjectPath(path));
}

/* ---------- Модель: имя, маршрут, проверка ---------- */

const MODEL_PROVIDER_NAMES: Record<string, string> = {
  omniroute: "OmniRoute",
  minimax: "MiniMax",
  "minimax-coding-plan": "MiniMax Coding Plan",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  zai: "Z.ai",
  "z-ai": "Z.ai",
  openrouter: "OpenRouter",
  azure: "Azure",
  groq: "Groq",
  codex: "Codex",
};

const MODEL_WORD_NAMES: Record<string, string> = {
  gpt: "GPT", minimax: "MiniMax", m3: "M3", "m3.1": "M3.1", m2: "M2", "m2.5": "M2.5",
  claude: "Claude", sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", gemini: "Gemini",
  qwen: "Qwen", glm: "GLM", kimi: "Kimi", deepseek: "DeepSeek", combo: "Combo",
  flash: "Flash", pro: "Pro", mini: "Mini", nano: "Nano", turbo: "Turbo", sol: "Sol",
  luna: "Luna", code: "Code", mmcode: "mmcode", codex: "Codex",
};

/** The name of the provider of a model route: `omniroute` becomes `OmniRoute`. */
export function humanProviderName(modelId: string): string {
  const provider = modelId.trim().split("/")[0] ?? "";
  if (!provider) return "";
  const known = MODEL_PROVIDER_NAMES[provider.toLowerCase()];
  if (known) return known;
  return provider.split(/[-_]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

/** The readable name of a model: `minimax-combo-m3.1` becomes `MiniMax Combo M3.1`. */
export function humanModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  const tail = parts.length > 1 ? parts.slice(1).join(" / ") : parts[0] ?? trimmed;
  return tail.split(/[-_\s]+/).filter(Boolean).map((word) => MODEL_WORD_NAMES[word.toLowerCase()] ?? word).join(" ");
}

/** The route of a model in words: `OmniRoute · MiniMax Combo M3.1`. */
export function modelRouteTitle(modelId: string): string {
  const provider = humanProviderName(modelId);
  const model = humanModelName(modelId);
  if (provider && model) return `${provider} · ${model}`;
  return provider || model || modelId;
}

/** True when the project is one of the closed projects of the rule of the owner. */
export function isRestrictedProject(project: string): boolean {
  const target = normalizePath(project);
  return RESTRICTED_PROJECT_ROOTS.some((root) => target === root || target.startsWith(`${root}/`));
}

/**
 * Write the model of one harness of a route.
 *
 * The one-click actions of the card and of the editor call it: the id lands in
 * the route of that harness only, and the models of the other harnesses stay
 * exactly as they were.
 */
export function setRouteModel(route: ProjectLaunchRoute, harness: string, model: string): ProjectLaunchRoute {
  return updateProjectRouteModel(route, harness, model);
}

/** The check of one model route of a project. */
export type ModelRouteCheck = {
  harness: string;
  model: string;
  state: "blocked" | "unconfirmed" | "ok";
  reason: string;
  action: string;
  /** The whole verdict of the model: what the owner sees and what to press. */
  verdict: ModelVerdict;
  /** The id that works instead, when this one does not. */
  working?: string;
};

/**
 * The check of the models of a route against the rules that decide a launch.
 *
 * Three things are checked, in the order of the rules themselves: the rule of
 * the owner (codex, claude and anthropic are closed for the closed projects),
 * the two lists of the project, and the list of the models the environment
 * confirms. The lists of the project are the same ones the gate of the launch
 * uses, so the reason the panel shows is the reason the launch refuses.
 */
export function checkProjectModelRoutes(
  project: string,
  route: ProjectLaunchRoute,
  policy: LaunchPolicy,
  confirmed: Record<string, string[]>,
): ModelRouteCheck[] {
  const restricted = isRestrictedProject(project);
  return route.harnesses.map((harness) => {
    const model = (route.models?.[harness] ?? policy.models[harness] ?? "").trim();
    const list = confirmed[harness] ?? [];
    const working = workingModelId(harness, { policyModels: policy.models, confirmed: list });
    const verdict = modelVerdict({
      harness,
      model,
      confirmed: list,
      allowedModels: route.allowedModels,
      deniedModels: route.deniedModels,
      restricted,
      workingModel: working,
    });
    if (verdict.kind === "missing") {
      return { harness, model: "", state: "ok", reason: "", action: "", verdict, working };
    }
    if (verdict.kind === "closed" || verdict.kind === "denied" || verdict.kind === "notAllowed") {
      return { harness, model, state: "blocked", reason: verdict.reason, action: verdict.action, verdict, working };
    }
    if (verdict.kind === "unconfirmed") {
      return {
        harness,
        model,
        state: restricted ? "blocked" : "unconfirmed",
        reason: verdict.reason,
        action: verdict.action,
        verdict,
        working,
      };
    }
    return { harness, model, state: "ok", reason: "", action: "", verdict, working };
  });
}

/* ---------- Состояние применения: иконка и слово ---------- */

/**
 * The state of a project across the machines of the fleet.
 *
 * A machine that answered and runs the project took the route. A machine that
 * did not answer is unknown, and it is never counted as taken.
 */
export function projectApplicationState(nodes: ProjectNodeState[]): ProjectStateView {
  const total = nodes.length;
  const accepted = nodes.filter((node) => node.answered && node.applies).length;
  const unanswered = nodes.filter((node) => !node.answered).length;
  if (total === 0) return { icon: "?", label: "Неизвестно", detail: "данных о флоте нет", tone: "unknown" };
  if (unanswered > 0) {
    if (accepted > 0) {
      return {
        icon: "◐",
        label: "Применено частично",
        detail: `${accepted} из ${total} узлов приняли, ${unanswered} не ответили`,
        tone: "partial",
      };
    }
    return { icon: "?", label: "Неизвестно", detail: "узел не ответил", tone: "unknown" };
  }
  if (accepted > 0) {
    return {
      icon: "✓",
      label: "Применено",
      detail: `${accepted} ${plural(accepted, "узел принял маршрут", "узла приняли маршрут", "узлов приняли маршрут")}`,
      tone: "done",
    };
  }
  return { icon: "?", label: "Неизвестно", detail: "проект не найден на узлах", tone: "unknown" };
}

/* ---------- Данные флота ---------- */

/**
 * The working directories of the live sessions, as known project paths.
 *
 * The list only helps the operator pick a path; the path field stays editable
 * by hand for a project that has no live session yet. The scratch copies of a
 * project (worktrees, caches, temporary worktrees) are not project folders, so
 * they are not offered.
 */
export function useKnownProjectPaths() {
  const [paths, setPaths] = React.useState<string[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The list of the sessions is huge without a limit, so the screen
        // always asks for a bounded part of it.
        const response = await fetch("/api/sessions?quick=1&limit=100");
        if (!response.ok) throw new Error("sessions unavailable");
        const result = await response.json() as { sessions?: Array<{ cwd?: string }> };
        if (cancelled) return;
        const directories = (result.sessions ?? [])
          .map((session) => session.cwd)
          .filter((cwd): cwd is string => typeof cwd === "string" && cwd.trim().length > 0)
          .map((cwd) => cwd.trim().replace(/\/+$/, ""));
        const real = filterKnownProjectPaths([...new Set(directories)]);
        setPaths(real.sort((left, right) => left.localeCompare(right)));
      } catch {
        if (!cancelled) setPaths([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return paths;
}

/**
 * How fresh the knowledge of the fleet is.
 *
 * `loading` means the answer is on the way, `ready` that it came, `failed`
 * that it did not. The screen shows the word instead of an empty cell, so a
 * slow answer never looks like a project without a machine.
 */
export type FleetFactsState = "loading" | "ready" | "failed";

/** What the row of a project knows about the fleet right now. */
export type FleetRowState = { hosts: FleetFactsState; sessions: FleetFactsState };

/**
 * The machines of the fleet and the sessions they run.
 *
 * The panel already knows both lists: `/api/fleet/hosts` names the machines and
 * `/api/fleet/sessions` says where every session runs and when it was last
 * active. The answer of the sessions is slow, so the screen does not wait for
 * it: the rows of the projects are drawn from the policy right away, and the
 * machine and the freshness arrive later, in the cells that wait for them.
 */
export function useFleetFacts() {
  const [hosts, setHosts] = React.useState<FleetHostFact[]>([]);
  const [sessions, setSessions] = React.useState<FleetSessionFact[]>([]);
  const [hostsState, setHostsState] = React.useState<FleetFactsState>("loading");
  const [sessionsState, setSessionsState] = React.useState<FleetFactsState>("loading");
  React.useEffect(() => {
    let cancelled = false;
    const read = async <T,>(path: string): Promise<T | undefined> => {
      try {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) return undefined;
        return await response.json() as T;
      } catch {
        return undefined;
      }
    };
    void (async () => {
      const [hostResult, sessionResult] = await Promise.all([
        read<{ hosts?: Array<{ hostId?: string; label?: string; state?: string; reason?: string }> }>("/api/fleet/hosts"),
        read<{ sessions?: Array<{ address?: { hostId?: string }; project?: { launchCwd?: string | null }; lastActivity?: string; model?: string }> }>("/api/fleet/sessions"),
      ]);
      if (cancelled) return;
      const nextHosts: FleetHostFact[] = (hostResult?.hosts ?? [])
        .filter((host): host is { hostId: string; label?: string; state?: string; reason?: string } => typeof host.hostId === "string" && host.hostId.length > 0)
        .map((host) => ({ hostId: host.hostId, label: host.label ?? host.hostId, state: host.state ?? "unavailable", reason: host.reason }));
      const nextSessions: FleetSessionFact[] = (sessionResult?.sessions ?? [])
        .map((session) => ({
          hostId: session.address?.hostId ?? "",
          launchCwd: typeof session.project?.launchCwd === "string" ? session.project.launchCwd : "",
          lastActivity: typeof session.lastActivity === "string" ? session.lastActivity : "",
          model: typeof session.model === "string" ? session.model : "",
        }))
        .filter((session) => session.hostId.length > 0);
      setHosts(nextHosts);
      setSessions(nextSessions);
      setHostsState(hostResult ? "ready" : "failed");
      setSessionsState(sessionResult ? "ready" : "failed");
    })();
    return () => { cancelled = true; };
  }, []);
  return { hosts, sessions, hostsState, sessionsState };
}

/**
 * The rows of the list: one entry per project with the machine, the freshness
 * and the state of the project on every machine of the fleet.
 */
export function buildProjectEntries(
  routes: Array<[string, ProjectLaunchRoute]>,
  hosts: FleetHostFact[],
  sessions: FleetSessionFact[],
): ProjectEntry[] {
  return routes.map(([project, route]) => {
    const facts = sessions
      .filter((session) => session.launchCwd && pathInsideProject(project, session.launchCwd))
      .sort((left, right) => activityValue(right.lastActivity) - activityValue(left.lastActivity));
    const hostId = facts[0]?.hostId ?? "";
    const host = hosts.find((item) => item.hostId === hostId);
    const nodeStates: ProjectNodeState[] = hosts.map((item) => ({
      hostId: item.hostId,
      label: machineName(item),
      answered: item.state === "ready",
      applies: facts.some((fact) => fact.hostId === item.hostId),
    }));
    return {
      project,
      route,
      name: projectName(project, route),
      aliases: (route.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
      hostId,
      hostLabel: hostId ? machineName({ hostId, label: host?.label ?? hostId }) : "",
      lastActivity: facts[0]?.lastActivity ?? "",
      environmentCount: route.harnesses.length,
      modelCount: (route.allowedModels?.length ?? 0) + (route.deniedModels?.length ?? 0),
      nodeStates,
    };
  });
}

/* ---------- Форма моделей ---------- */

/**
 * One model list of a project: the allowed or the denied models.
 *
 * The list is filled from the model catalog of the harnesses of the route and
 * accepts any model id by hand, so a model that is not in the catalog can be
 * named as well. Every model is shown with its readable name next to its id,
 * and the result of an add or a remove is announced right under the field.
 */
function ProjectModelList({
  project,
  route,
  field,
  title,
  hint,
  suggestions,
  knownIds,
  statusOf,
  disabled,
  onChange,
}: {
  project: string;
  route: ProjectLaunchRoute;
  field: "allowedModels" | "deniedModels";
  title: string;
  hint: string;
  suggestions: string[];
  /** Every model id the environments of the route confirm. */
  knownIds: string[];
  /** The short status of a model for the list of the suggestions. */
  statusOf: (model: string) => string;
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
}) {
  const [value, setValue] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const models = route[field] ?? [];
  const listId = `projects-${field}-${project}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const allowed = field === "allowedModels";
  const add = () => {
    const model = value.trim();
    if (!model) return;
    onChange(updateProjectRouteModelList(route, field, model));
    setValue("");
    setNotice(`Модель ${model} добавлена в список «${title}».`);
  };
  const remove = (model: string) => {
    onChange(removeProjectRouteModelList(route, field, model));
    setNotice(`Модель ${model} убрана из списка «${title}».`);
  };
  const unused = allowed && knownIds.length > 0 ? unusedListEntries(models, knownIds) : [];
  const typed = value.trim();
  const typedMatches = !typed || typed === "*" || knownIds.length === 0
    || knownIds.some((id) => modelMatchesEntry(id, typed));
  const typedWarning = typed && !typedMatches
    ? allowed
      ? `«${typed}» не совпадёт ни с одной моделью среды: впишите id модели или нажмите «Разрешить все модели» — запишется «*», это любая модель.`
      : `«${typed}» не совпадёт ни с одной моделью среды: запрет не сработает. Впишите id модели или шаблон с «*» в конце.`
    : "";
  return <div className={`projects-field projects-model-field${allowed ? "" : " projects-model-field-denied"}`}>
    <span className="projects-field-label">
      <span className={`projects-model-badge ${allowed ? "projects-model-badge-allowed" : "projects-model-badge-denied"}`} aria-hidden="true">{allowed ? "✓" : "✕"}</span>
      {title}
    </span>
    <ul className="projects-model-list" aria-label={`${title} для проекта ${project}`}>
      {models.length === 0
        ? <li className="projects-model-empty">{allowed ? "Пустой список разрешённых — без ограничений." : "Пустой список запрещённых — запретов нет."}</li>
        : models.map((model) => <li className={`projects-model-item${allowed ? "" : " projects-model-item-denied"}`} key={model}>
          <span className="projects-model-entry">
            <span className="projects-model-entry-name">{humanModelName(model)}</span>
            <code className="projects-model-entry-id">{model}</code>
          </span>
          <button type="button" aria-label={`Убрать модель ${model} из списка «${title}» проекта ${project}`}
            disabled={disabled} onClick={() => remove(model)}>Убрать</button>
        </li>)}
    </ul>
    {unused.length > 0 && <p className="projects-model-warn" role="status">{`В списке «${title}» есть запись, которой не соответствует ни одна модель среды: ${unused.map((entry) => `«${entry}»`).join(", ")}. Такая запись не разрешает ничего: гейт сравнивает id точно, с «*» только в конце. Нажмите «Разрешить все модели», и запишется «*» — любая модель.`}</p>}
    <div className="projects-model-add">
      <label htmlFor={listId}>{`${title} · добавить модель`}</label>
      <input id={listId} type="text" list={`${listId}-options`} value={value} maxLength={256}
        placeholder="model id" aria-label={`${title} для проекта ${project}: добавить модель`}
        disabled={disabled} onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      <datalist id={`${listId}-options`}>{suggestions.map((model) => <option value={model} key={model}>{`${modelRouteTitle(model)} — ${statusOf(model)}`}</option>)}</datalist>
      <button type="button" aria-label={`Добавить модель в список «${title}» проекта ${project}`}
        disabled={disabled || !value.trim()} onClick={add}>Добавить</button>
    </div>
    <small className="projects-help">{hint}</small>
    {typedWarning && <p className="projects-model-warn" role="status">{typedWarning}</p>}
    <div className="projects-model-actions">
      {allowed && <button type="button" aria-label={`Разрешить все модели проекта ${project}`} disabled={disabled}
        onClick={() => {
          onChange({ ...route, allowedModels: ["*"] });
          setNotice("В список «Разрешённые модели» записано «*» — любая модель.");
        }}>Разрешить все модели</button>}
      <button type="button" aria-label={`Очистить список «${title}» проекта ${project}`} disabled={disabled || models.length === 0}
        onClick={() => {
          onChange({ ...route, [field]: [] });
          setNotice(`Список «${title}» очищен.`);
        }}>Очистить список</button>
    </div>
    <p className="projects-model-notice" role="status">{notice}</p>
  </div>;
}

/**
 * The per-project model policy of one route.
 *
 * The empty allowed list means no restriction at all. A model that is denied
 * is never used in the project, even when it is the effective model of a
 * harness of the route: that harness simply stops being used.
 */
export function ProjectModelPolicyEditor({
  project,
  route,
  policy,
  runtimes,
  modelOptions,
  checks,
  disabled,
  onChange,
}: {
  project: string;
  route: ProjectLaunchRoute;
  policy: LaunchPolicy;
  runtimes: LaunchRuntimeOption[];
  modelOptions: Record<string, string[]>;
  checks?: ModelRouteCheck[];
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
}) {
  const catalog = useHarnessModelCatalog(route.harnesses);
  const suggestions = [...new Set(route.harnesses.flatMap((harness) => [
    ...(catalog[harness] ?? []),
    ...(modelOptions[harness] ?? []),
  ]))].sort((left, right) => left.localeCompare(right));
  const allowedModels = route.allowedModels ?? [];
  const deniedModels = route.deniedModels ?? [];
  const conflicts = conflictingModelEntries(allowedModels, deniedModels);
  const knownIds = [...new Set(route.harnesses.flatMap((harness) => catalog[harness] ?? []))];
  const restricted = isRestrictedProject(project);
  /** The short status of a model in the list of the suggestions. */
  const statusOf = (model: string): string => {
    if (restricted && hasRestrictedProviderToken(model)) return MODEL_STATUS_WORDS.closed;
    if (!knownIds.includes(model)) return MODEL_STATUS_WORDS.unconfirmed;
    return MODEL_STATUS_WORDS.works;
  };

  return <fieldset className="projects-fieldset" id={`projects-models-${project}`} disabled={disabled}>
    <legend>Модели проекта</legend>
    <div className="projects-legend" aria-label="Как читать правила моделей">
      <p><strong>«Разрешённые модели»</strong> — фильтр проекта: какие модели проект вообще может запускать. Пустой список — без ограничений. Шаблон с «*» в конце, например <code>omniroute/minimax-*</code>, разрешает всё с таким началом; <code>*</code> разрешает всё.</p>
      <p><strong>«Запрещённые модели»</strong> — что проект не может запускать никогда. Запрет сильнее разрешения.</p>
      <p><strong>Откуда берётся модель.</strong> Сначала модель маршрута проекта, иначе общая модель среды для этой среды.</p>
      <p><strong>Доступность модели — свойство среды.</strong> Панель показывает, подтверждает ли среда этот id, и больше ничего о нём не выдумывает: подписка, бесплатный пул и платный маршрут для среды выглядят одинаково.</p>
      <p><strong>Одно и то же бывает двумя написаниями.</strong> Маршрут <code>omniroute/minimax-combo-m3.1</code> и ключ каталога <code>omniroute/minimax/MiniMax-M3.1-Flash</code> — одна и та же модель. Пишите маршрут: его понимают политика и Herder.</p>
      <p><strong>Как убрать блок.</strong> В карточке блока написано, что заблокировано и почему. Нажмите «Поставить рабочую модель» — панель запишет id, который среда подтверждает.</p>
    </div>
    <ProjectModelList project={project} route={route} field="allowedModels" title="Разрешённые модели"
      hint="Что может запускаться в проекте. Пустой список разрешённых — без ограничений: работает общая модель среды. Шаблон «*» разрешает всё, например omniroute/minimax-*."
      suggestions={suggestions} knownIds={knownIds} statusOf={statusOf} disabled={disabled} onChange={onChange} />
    <ProjectModelList project={project} route={route} field="deniedModels" title="Запрещённые модели"
      hint="Что никогда не запускается в проекте. Запрет сильнее разрешения: запрещённая модель не используется, даже если она указана в разрешённых."
      suggestions={suggestions} knownIds={knownIds} statusOf={statusOf} disabled={disabled} onChange={onChange} />
    {conflicts.length > 0 && <p className="autopilot-error" role="alert">{`Модель «${conflicts[0]}» указана и как разрешённая, и как запрещённая. Уберите её из одного из списков, иначе политика не сохранится.`}</p>}
    <div className="projects-field">
      <span className="projects-field-label">Эффективная модель по средам маршрута</span>
      <ul className="projects-model-list" aria-label={`Эффективная модель по средам маршрута проекта ${project}`}>
        {route.harnesses.map((harness) => {
          const effective = route.models?.[harness] ?? policy.models[harness] ?? "";
          const label = effective ? modelRouteLabel({ modelId: effective, confirmed: catalog[harness] ?? [] }) : undefined;
          const violation = routeModelViolation(route, effective);
          const check = checks?.find((item) => item.harness === harness);
          const answer = catalog[harness];
          const list = answer ?? [];
          const working = workingModelId(harness, { policyModels: policy.models, confirmed: list });
          const verdict = modelVerdict({
            harness,
            model: effective,
            confirmed: list,
            allowedModels,
            deniedModels,
            restricted,
            workingModel: working,
          });
          // The answer of the environment is on the way: the screen says so
          // instead of blaming the model before anyone asked the environment.
          // One fact — one word. The state of the environment is the word of the
          // catalog of OpenCode (рабочая / устаревшая / платная) and it is shown
          // once, in its own block. The chip of the verdict speaks about the
          // lists of the project and the rule of the owner, so it stays for the
          // verdicts of the policy and steps aside for the state of the
          // environment.
          const environmentKind = verdict.kind === "works" || verdict.kind === "unconfirmed";
          const status = answer === undefined
            ? { label: "проверяем…", tone: "unknown" as const }
            : { label: verdict.label, tone: verdict.tone };
          return <li className={`projects-model-item projects-effective projects-model-status-${status.tone}`} key={harness}>
            <span className="projects-effective-environment">
              <span className="projects-model-caption">Среда</span>
              <strong>{labelFor(harness, runtimes)}</strong>
            </span>
            <span className="projects-effective-model">
              <span className="projects-model-caption">Модель</span>
              <code>{effective || "модель не задана"}</code>
              {effective && <small className="projects-model-route">{modelRouteTitle(effective)}</small>}
              {(!environmentKind || !label) && <span className={`projects-status projects-status-${status.tone}`} role="status">{status.label}</span>}
            </span>
            {label && <span className={`projects-model-state projects-model-state-${label.tone}`}>
              <span className="projects-model-caption">Состояние</span>
              <strong>{label.state}</strong>
              <small className="projects-model-state-reason">{label.reason}</small>
            </span>}
            {violation === "denied" && <span className="projects-model-warn" role="status">Модель запрещена в этом проекте: среда перестанет использоваться.</span>}
            {violation === "not_allowed" && <span className="projects-model-warn" role="status">Модель не разрешена в этом проекте: среда перестанет использоваться.</span>}
            {check?.state === "unconfirmed" && !label && <span className="projects-model-warn" role="status">{check.reason}.</span>}
            {verdict.kind === "closed" && <span className="projects-model-warn" role="status">{verdict.detail}</span>}
            {working && working !== effective && <span className="projects-model-actions">
              <button type="button" aria-label={`Поставить рабочую модель ${working} для среды ${labelFor(harness, runtimes)} в проекте ${project}`}
                disabled={disabled} onClick={() => onChange(setRouteModel(route, harness, working))}>Поставить рабочую модель</button>
            </span>}
          </li>;
        })}
        {route.harnesses.length === 0 && <li className="projects-model-empty" aria-hidden="true">В маршруте нет ни одной среды.</li>}
      </ul>
    </div>
  </fieldset>;
}

/* ---------- Карточка проекта ---------- */

/** One project route: the ordered harnesses, the model of each and the card ids. */
export function ProjectRoutesEditor({
  project,
  route,
  policy,
  runtimes,
  modelOptions,
  checks,
  entry,
  state,
  fleet,
  open,
  onOpenChange,
  disabled,
  onChange,
  onRemove,
}: {
  project: string;
  route: ProjectLaunchRoute;
  policy: LaunchPolicy;
  runtimes: LaunchRuntimeOption[];
  modelOptions: Record<string, string[]>;
  checks?: ModelRouteCheck[];
  entry?: ProjectEntry;
  state?: ProjectStateView;
  /** How fresh the knowledge of the fleet is, for the cells that wait for it. */
  fleet?: FleetRowState;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const allowed = policy.allowedHarnesses;
  const available = allowed.length > 0
    ? allowed
    : [...new Set([...runtimes.map(({ id }) => id), ...route.harnesses])];
  const addable = available.filter((harness) => !route.harnesses.includes(harness));
  const name = entry?.name ?? projectName(project, route);
  const aliases = entry?.aliases ?? (route.aliases ?? []).filter(Boolean);
  const environments = entry?.environmentCount ?? route.harnesses.length;
  const models = entry?.modelCount ?? ((route.allowedModels?.length ?? 0) + (route.deniedModels?.length ?? 0));
  const machine = entry?.hostLabel
    || (fleet?.hosts === "loading" ? "обновляю…" : "Машина неизвестна");
  const freshness = entry?.lastActivity
    ? relativeTime(entry.lastActivity)
    : fleet?.sessions === "loading" ? "обновляю…" : "время неизвестно";
  return <details className="projects-card" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary className="projects-card-summary">
      <span className="projects-card-name">{name}</span>
      {aliases.slice(1).map((alias) => <span className="projects-alias-chip" key={alias}>{alias}</span>)}
      <span className={`projects-machine-chip${entry?.hostId ? "" : " projects-machine-chip-unknown"}`}>
        <span aria-hidden="true">▣</span> {machine}
      </span>
      <span className="projects-card-counts">
        {`${environments} ${plural(environments, "среда", "среды", "сред")} · ${models} ${plural(models, "модель", "модели", "моделей")}`}
      </span>
      {state && <span className={`projects-state projects-state-${state.tone}`}>
        <span aria-hidden="true">{state.icon}</span> {state.label}
      </span>}
      <time className="projects-card-time" dateTime={entry?.lastActivity || undefined} title={absoluteTime(entry?.lastActivity ?? "")}>
        {freshness}
      </time>
      <code className="projects-card-path">{project}</code>
    </summary>
    <div className="projects-card-tools">
      <button type="button" className="projects-card-menu-button" aria-label={`Действия с маршрутом проекта ${project}`}
        aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>⋯</button>
      {menuOpen && <div className="projects-card-menu" role="menu">
        <button type="button" role="menuitem" disabled={disabled}
          onClick={() => { setMenuOpen(false); onRemove(); }}>Удалить маршрут</button>
      </div>}
    </div>
    {open && <div className="projects-card-body">
      {state && <p className={`projects-state-line projects-state-${state.tone}`}>
        <span aria-hidden="true">{state.icon}</span>
        <strong>{state.label}:</strong> {state.detail}
      </p>}
      <fieldset className="projects-fieldset" disabled={disabled}>
        <legend>Порядок сред</legend>
        {route.harnesses.length === 0
          ? <p className="projects-help" role="status">В маршруте нет ни одной среды. Добавьте хотя бы одну, иначе маршрут не сохранится.</p>
          : <ol className="projects-order" aria-label={`Порядок сред для проекта ${project}`}>
            {route.harnesses.map((harness, index) => <li className="projects-order-item" key={harness}>
              <span className="projects-order-name">
                <strong>{index + 1}. {labelFor(harness, runtimes)}</strong>
                <small aria-hidden="true">{route.models?.[harness] ?? policy.models[harness] ?? "модель не задана"}</small>
              </span>
              <span className="projects-order-actions">
                <button type="button" aria-label={`Поднять ${labelFor(harness, runtimes)} выше в маршруте ${project}`} disabled={index === 0}
                  onClick={() => onChange(moveProjectRouteHarness(route, harness, -1))}>↑</button>
                <button type="button" aria-label={`Опустить ${labelFor(harness, runtimes)} ниже в маршруте ${project}`} disabled={index === route.harnesses.length - 1}
                  onClick={() => onChange(moveProjectRouteHarness(route, harness, 1))}>↓</button>
                <button type="button" aria-label={`Убрать ${labelFor(harness, runtimes)} из маршрута ${project}`}
                  onClick={() => onChange(removeProjectRouteHarness(route, harness))}>Убрать</button>
              </span>
            </li>)}
          </ol>}
        <div className="projects-field">
          <label htmlFor={`projects-add-harness-${project}`}>Добавить среду в маршрут</label>
          <select id={`projects-add-harness-${project}`} value="" aria-label={`Добавить среду в маршрут проекта ${project}`}
            onChange={(event) => {
              const harness = event.target.value;
              if (!harness) return;
              onChange({ ...route, harnesses: [...route.harnesses, harness] });
            }}>
            <option value="">Выберите среду</option>
            {addable.map((harness) => <option value={harness} key={harness}>{labelFor(harness, runtimes)}</option>)}
          </select>
          <small className="projects-help">В маршрут можно добавить только среду из общего списка разрешённых.</small>
        </div>
      </fieldset>
      <fieldset className="projects-fieldset" disabled={disabled}>
        <legend>Модель маршрута</legend>
        <p className="projects-help">Укажите модель, которую Herder отдаст этой среде для этого проекта. Например, <code>omniroute/minimax-combo-m3.1</code> для OpenCode. Пустое поле берёт общую модель среды.</p>
        {route.harnesses.map((harness) => <div className="projects-field" key={`${project}-${harness}`}>
          <label htmlFor={routeInputId(project, harness)}>Модель · {labelFor(harness, runtimes)}</label>
          <input id={routeInputId(project, harness)} type="text" maxLength={256} list={routeInputId(project, harness)}
            value={route.models?.[harness] ?? ""} placeholder={policy.models[harness] ?? "Укажите модель"}
            aria-label={`Модель маршрута для ${project} и среды ${labelFor(harness, runtimes)}`}
            onChange={(event) => onChange(updateProjectRouteModel(route, harness, event.target.value))} />
          <datalist id={routeInputId(project, harness)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model}>{modelRouteTitle(model)}</option>)}</datalist>
          <small className="projects-help">Пустое поле использует общую модель среды {labelFor(harness, runtimes)}: {policy.models[harness] || "не задана"}.</small>
        </div>)}
      </fieldset>
      <fieldset className="projects-fieldset" disabled={disabled}>
        <legend>Идентификаторы карточек</legend>
        <div className="projects-field">
          <label htmlFor={`projects-aliases-${project}`}>Идентификаторы карточек · {project}</label>
          <input id={`projects-aliases-${project}`} type="text" value={(route.aliases ?? []).join(", ")} placeholder="tg-commentator, autotelegramviews"
            aria-label={`Идентификаторы карточек проекта ${project}`}
            onChange={(event) => {
              const aliases = event.target.value.split(",").map((alias) => alias.trim()).filter(Boolean);
              onChange(aliases.length > 0 ? { ...route, aliases } : { ...route, aliases: undefined });
            }} />
          <small className="projects-help">Через запятую. Карточка приходит с таким идентификатором, а не с путём к папке.</small>
        </div>
      </fieldset>
      <ProjectModelPolicyEditor project={project} route={route} policy={policy} runtimes={runtimes}
        modelOptions={modelOptions} checks={checks} disabled={disabled} onChange={onChange} />
    </div>}
  </details>;
}

/**
 * The card of a block: what is blocked, why, and what to press.
 *
 * The block is a check of the panel before the launch: the model of the route
 * is compared with the models the environment confirms and with the two lists
 * of the project. It is not a record of an observed refusal of the guard of the
 * OpenCode integration — that guard answers on its own, and the panel has no
 * feed of it.
 */
export function BlockedModelNotice({
  project,
  check,
  confirmed,
  onSetModel,
  onOpenModels,
}: {
  project: string;
  check: ModelRouteCheck;
  confirmed: string[];
  onSetModel: (model: string) => void;
  onOpenModels: () => void;
}) {
  const [routeOpen, setRouteOpen] = React.useState(false);
  const verdict = check.verdict;
  const title = verdict.kind === "closed"
    ? `Модель ${check.model} закрыта правилом владельца — запуск на ней не пройдёт`
    : verdict.kind === "denied"
      ? `Модель ${check.model} запрещена в списке проекта — запуск на ней не пройдёт`
      : verdict.kind === "notAllowed"
        ? `Модель ${check.model} не разрешена в проекте — запуск на ней не пройдёт`
        : `Модель ${check.model} среда не подтверждает — запуск на ней не пройдёт`;
  const working = check.working ?? "";
  return <div className="projects-blocked" role="alert">
    <p className="projects-blocked-title"><span aria-hidden="true">⛔</span> {title}</p>
    <p className="projects-blocked-note">Панель сверяет модель маршрута со списком моделей среды и со списками проекта. Это проверка до запуска, а не запись о случившемся отказе.</p>
    <dl className="projects-blocked-facts">
      <div><dt>Модель</dt><dd><code>{check.model}</code><small>{modelRouteTitle(check.model)}</small></dd></div>
      <div><dt>Проект</dt><dd>{project}</dd></div>
      <div><dt>Причина</dt><dd>{check.reason}</dd></div>
      <div><dt>Что делать</dt><dd>{check.action || "Откройте Модели проекта и поставьте модель, которую среда подтверждает."}</dd></div>
    </dl>
    <div className="projects-blocked-actions">
      {working && <button type="button" className="primary-button"
        aria-label={`Поставить рабочую модель ${working} в проекте ${project}`}
        onClick={() => onSetModel(working)}>Поставить рабочую модель</button>}
      <button type="button" className="quiet-button" onClick={onOpenModels}>Открыть Модели проекта</button>
      <button type="button" className="quiet-button" aria-expanded={routeOpen}
        onClick={() => setRouteOpen((value) => !value)}>Показать подтверждённый маршрут</button>
    </div>
    {working && <p className="projects-blocked-hint">Рабочая модель этой среды: <code>{working}</code>. Кнопка запишет её в маршрут проекта — больше ничего менять не нужно.</p>}
    {routeOpen && <div className="projects-blocked-route">
      <p>Среда подтверждает эти модели:</p>
      {confirmed.length === 0
        ? <p className="projects-help">Список моделей среды пуст — среда не подтвердила ни одного маршрута.</p>
        : <ul>{confirmed.map((model) => {
          const status = modelVerdict({ harness: check.harness, model, confirmed, restricted: isRestrictedProject(project) });
          return <li key={model}>
            <span className="projects-blocked-route-entry">
              <code>{model}</code>
              <small>{modelRouteTitle(model)}</small>
              <span className={`projects-status projects-status-${status.tone}`}>{status.label}</span>
            </span>
            {status.kind === "works" && <button type="button" aria-label={`Поставить модель ${model} в проекте ${project}`}
              onClick={() => onSetModel(model)}>Поставить</button>}
          </li>;
        })}</ul>}
    </div>}
  </div>;
}

/* ---------- Страница проектов ---------- */

/**
 * The first-class Projects screen.
 *
 * It edits only the project routes of the Herder launch policy. The model of
 * the incident analysis stays in Notice Place and the global allowlist stays
 * in the launch settings, so this page never touches either of them.
 *
 * The list is collapsed: one row per project with the name, the machine, the
 * counts and the time of the last change. The body of a row opens on demand.
 */
export function ProjectsSettings({ onOpenLaunchSettings }: { onOpenLaunchSettings?: () => void } = {}) {
  const draft = useLaunchPolicyDraft({ merge: mergeProjectRoutes });
  const { runtimes, modelOptions } = useRuntimeModels();
  const policy = draft.policy;
  const loading = draft.phase === "loading";
  const needsSetup = draft.phase === "absent";
  const loadError = draft.loadError;
  const saving = draft.saving;
  const saved = draft.saved;
  const saveError = draft.saveError;
  const [newProject, setNewProject] = React.useState("");
  const [newProjectHarnesses, setNewProjectHarnesses] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<ProjectSort>("recent");
  const [openCards, setOpenCards] = React.useState<Record<string, boolean>>({});
  const [scrollTo, setScrollTo] = React.useState<string | null>(null);
  const { hosts, sessions, hostsState, sessionsState } = useFleetFacts();

  const routes = Object.entries(policy.projectRoutes ?? {});
  const entries = buildProjectEntries(routes, hosts, sessions);
  const visible = sortProjectEntries(filterProjectEntries(entries, query), sort);
  const groups = groupProjectEntriesByMachine(visible);
  const harnesses = [...new Set(routes.flatMap(([, route]) => route.harnesses))];
  const confirmed = useHarnessModelCatalog(harnesses);
  const allowed = policy.allowedHarnesses;
  const available = allowed.length > 0 ? allowed : runtimes.map(({ id }) => id);
  const knownPaths = useKnownProjectPaths();
  // The common models of the environments: what rides when the project names
  // no model of its own.
  const globalModelRows = [...new Set([...Object.keys(policy.models ?? {}), ...harnesses])]
    .map((harness) => {
      const model = policy.models[harness] ?? "";
      const answer = confirmed[harness];
      const list = answer ?? [];
      const verdict = modelVerdict({
        harness,
        model,
        confirmed: list,
        workingModel: workingModelId(harness, { policyModels: policy.models, confirmed: list }),
      });
      return {
        harness,
        label: labelFor(harness, runtimes),
        model: model || "не задана",
        status: answer === undefined
          ? "проверяем…"
          : verdict.label,
        tone: answer === undefined ? "unknown" as const : verdict.tone,
      };
    });
  const routesValid = routes.every(([project, route]) =>
    project.startsWith("/") && route.harnesses.length > 0
    && route.harnesses.every((harness) => allowed.length === 0 || allowed.includes(harness))
    && route.harnesses.every((harness) => {
      const model = route.models?.[harness] ?? policy.models[harness];
      return Boolean(model?.trim()) && model.length <= 256;
    })
    // A model that is allowed and denied at the same time is ambiguous and
    // must not reach the saved policy.
    && conflictingModelEntries(route.allowedModels, route.deniedModels).length === 0
    && (route.allowedModels ?? []).every((model) => model.trim().length > 0 && model.length <= 256)
    && (route.deniedModels ?? []).every((model) => model.trim().length > 0 && model.length <= 256));
  const valid = routesValid;
  const unsaved = draft.dirty.length > 0;

  React.useEffect(() => {
    if (!scrollTo) return;
    const node = document.getElementById(`projects-models-${scrollTo}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    setScrollTo(null);
  }, [scrollTo, openCards]);

  const setRoutes = (next: Record<string, ProjectLaunchRoute>) => {
    draft.edit({ ...policy, projectRoutes: next }, "projectRoutes");
  };

  const renderProject = (entry: ProjectEntry) => {
    const { project, route } = entry;
    const checks = checkProjectModelRoutes(project, route, policy, confirmed);
    const blocked = checks.find((check) => check.state === "blocked");
    const state = projectApplicationState(entry.nodeStates);
    return <div className="projects-item" key={project}>
      {blocked && <BlockedModelNotice project={project} check={blocked} confirmed={confirmed[blocked.harness] ?? []}
        onSetModel={(model) => {
          const harness = blocked.harness;
          const next = setRouteModel(route, harness, model);
          setRoutes({ ...(policy.projectRoutes ?? {}), [project]: next });
          setOpenCards((current) => ({ ...current, [project]: true }));
        }}
        onOpenModels={() => {
          setOpenCards((current) => ({ ...current, [project]: true }));
          setScrollTo(project);
        }} />}
      <ProjectRoutesEditor
        project={project}
        route={route}
        policy={policy}
        runtimes={runtimes}
        modelOptions={modelOptions}
        checks={checks}
        entry={entry}
        state={state}
        fleet={{ hosts: hostsState, sessions: sessionsState }}
        open={Boolean(openCards[project])}
        onOpenChange={(next) => setOpenCards((current) => ({ ...current, [project]: next }))}
        disabled={saving || Boolean(loadError)}
        onChange={(next) => setRoutes({ ...(policy.projectRoutes ?? {}), [project]: next })}
        onRemove={() => {
          const next = { ...(policy.projectRoutes ?? {}) };
          delete next[project];
          setRoutes(next);
        }} />
    </div>;
  };

  return <section className="projects-page" aria-label="Проекты">
    <header className="projects-heading">
      <div>
        <span className="eyebrow">AGENT HERDER · ПРОЕКТЫ</span>
        <h1>Проекты</h1>
        <p>Здесь задаётся маршрут каждого проекта: в какой среде Herder запустит работу, какая модель у этой среды и по каким идентификаторам приходят карточки. Страница меняет только маршруты проектов в политике запуска Herder.</p>
      </div>
      {onOpenLaunchSettings && <button type="button" className="quiet-button projects-heading-action" aria-label="Открыть общие настройки запуска" onClick={onOpenLaunchSettings}>Общие настройки запуска</button>}
    </header>

    <details className="projects-explainer" open>
      <summary>Справка: что делают списки моделей и почему модель могут заблокировать</summary>
      <div className="projects-explainer-body">
        <p><strong>Списки моделей — это фильтр проекта.</strong> «Разрешённые модели» — что проект может запускать, «Запрещённые модели» — что не может никогда. Запрет всегда сильнее разрешения.</p>
        <p><strong>Блокирует запросы модельная защита интеграции OpenCode</strong> (<code>integrations/opencode/agent-herder-autopilot.js</code>, <code>enforceRestrictedModelRequest</code>). Для закрытых проектов (TelegramAuto, video_watching) маршрут модели должен совпасть с подтверждённым нативным маршрутом среды: иначе запрос отклоняется — «полный нативный маршрут провайдера запрещён или не подтверждён».</p>
        <p>Модели, которых нет в списке моделей OpenCode, получают отказ 409: маршрут не подтверждён. Маршрут <code>omniroute/minimax-combo-m3.1</code> подтверждается и приводит к конечной модели minimax-code/mmcode/MiniMax-M3.1-Flash — в нём нет ни codex, ни claude, ни anthropic.</p>
        <p><strong>Порядок сред.</strong> Herder идёт по списку сверху вниз и переключается на следующую среду только после отказа, когда запуск точно не состоялся. Проекты без маршрута работают как раньше.</p>
      </div>
    </details>

    <section className="projects-globals" aria-label="Общие настройки запуска">
      <div>
        <span className="eyebrow">РАЗРЕШЁННЫЕ СРЕДЫ</span>
        <p className="projects-globals-value">{allowed.length > 0 ? allowed.map((harness) => labelFor(harness, runtimes)).join(", ") : "Ни одна среда не разрешена"}</p>
        <small className="projects-help">В маршрут проекта попадают только эти среды. Список меняется в общих настройках запуска.</small>
      </div>
      <div>
        <span className="eyebrow">МОДЕЛЬ ДЛЯ АНАЛИЗА ИНЦИДЕНТОВ</span>
        <p className="projects-globals-value">Notice Place</p>
        <small className="projects-help">Модель для анализа инцидентов выбирается в <a href="https://notify.bezrabotnyi.com/admin/#health-model">админке Notice Place</a>. Эта страница её не меняет.</small>
      </div>
      <div>
        <span className="eyebrow">ОБЩИЕ МОДЕЛИ СРЕДЫ</span>
        <ul className="projects-globals-models" aria-label="Общие модели среды">
          {globalModelRows.map((row) => <li key={row.harness}>
            <strong>{row.label}</strong>
            <span className="projects-globals-model">{`общие модели среды: по умолчанию едет ${row.model}`}</span>
            <span className={`projects-status projects-status-${row.tone}`}>{row.status}</span>
          </li>)}
          {globalModelRows.length === 0 && <li className="projects-model-empty">У сред нет общих моделей.</li>}
        </ul>
        <small className="projects-help">Если проект ничего не задал, поедет общая модель среды. Меняется в общих настройках запуска.</small>
        {onOpenLaunchSettings && <button type="button" className="quiet-button" aria-label="Открыть общие настройки запуска: общие модели среды"
          onClick={onOpenLaunchSettings}>Открыть настройки запуска</button>}
      </div>
    </section>
    {loading ? <p className="settings-loading" role="status">Загружаем маршруты проектов…</p> : <>
      {needsSetup && <p className="launch-policy-notice" role="status">Настройки запуска ещё не сохранены. Сохраните маршрут проекта, чтобы он начал применяться.</p>}
      {draft.phase === "invalid" && <p className="autopilot-error" role="alert">Политика запуска повреждена, поэтому сохранить маршруты из формы нельзя: {loadError}. Файл политики на сервере нужно исправить вручную.</p>}
      {draft.phase === "error" && <p className="autopilot-error" role="alert">Не удалось загрузить настройки запуска: {loadError}. Обновите страницу и повторите.</p>}
      {(hostsState === "failed" || sessionsState === "failed") && <p className="projects-help" role="status">Машины флота сейчас недоступны: у проектов нет метки машины и времени последнего изменения.</p>}      <div className="projects-toolbar">
        <div className="projects-field projects-search">
          <label htmlFor="projects-search">Поиск по проектам</label>
          <input id="projects-search" type="search" value={query} placeholder="Поиск по названию, пути или машине"
            aria-label="Поиск по названию, пути или машине" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="projects-field projects-sort">
          <span className="projects-field-label" id="projects-sort-label">Порядок</span>
          <div className="projects-sort-switch" role="group" aria-labelledby="projects-sort-label">
            {PROJECT_SORT_LABELS.map(([value, label]) => <button type="button" key={value}
              className={sort === value ? "active" : ""} aria-pressed={sort === value}
              onClick={() => setSort(value)}>{label}</button>)}
          </div>
        </div>
      </div>
      <div className="projects-list">
        {routes.length === 0
          ? <p className="projects-empty">Маршруты проектов не настроены. Для всех проектов используется основная среда. Добавьте первый проект ниже.</p>
          : visible.length === 0
            ? <p className="projects-empty">Ничего не найдено: проверьте название, путь или машину.</p>
            : sort === "machine"
              ? groups.map((group) => <section className="projects-machine-group" key={group.hostId || "unknown"}>
                <h2 className="projects-machine-group-title">
                  {group.label}
                  <small>{group.entries.length} {plural(group.entries.length, "проект", "проекта", "проектов")}</small>
                </h2>
                {group.entries.map(renderProject)}
              </section>)
              : visible.map(renderProject)}
      </div>
      <section className="projects-card projects-card-new" aria-label="Новый проект">
        <h2 className="projects-card-title">Новый проект</h2>
        <fieldset className="projects-fieldset" disabled={saving || Boolean(loadError)}>
          <legend>Путь и среды</legend>
          <div className="projects-field">
            <label htmlFor="projects-new-path">Абсолютный путь проекта</label>
            <input id="projects-new-path" type="text" value={newProject} placeholder="/home/user/project"
              aria-label="Абсолютный путь проекта для маршрута" onChange={(event) => setNewProject(event.target.value)} />
            <small className="projects-help">Папка проекта на этой машине. Регистр и завершающий слеш не важны.</small>
          </div>
          <div className="projects-field">
            <label htmlFor="projects-new-known">Известные проекты</label>
            <select id="projects-new-known" value="" aria-label="Выбрать известный проект из списка живых сессий"
              onChange={(event) => {
                if (!event.target.value) return;
                setNewProject(event.target.value);
              }}>
              <option value="">Выберите папку проекта</option>
              {knownPaths.map((path) => <option value={path} key={path}>{path}</option>)}
            </select>
            <small className="projects-help">Папки живых сессий на этой машине. Можно и ввести путь руками.</small>
          </div>
          <div className="projects-field">
            <span className="projects-field-label">Среды маршрута</span>
            <div className="launch-runtime-list">{available.map((harness) => {
              const selected = newProjectHarnesses.includes(harness);
              return <label className="launch-runtime-option" key={`add-${harness}`}>
                <span><strong>{labelFor(harness, runtimes)}</strong><small aria-hidden="true">{selected ? `позиция ${newProjectHarnesses.indexOf(harness) + 1}` : "не в маршруте"}</small></span>
                <input type="checkbox" checked={selected} aria-label={`Добавить ${labelFor(harness, runtimes)} в маршрут нового проекта`} onChange={(event) => {
                  setNewProjectHarnesses((current) => event.target.checked
                    ? [...current, harness].slice(-4)
                    : current.filter((item) => item !== harness));
                }} />
              </label>;
            })}</div>
            {available.length === 0 && <p className="projects-help" role="status">Нет сред, которые можно добавить в маршрут. Сначала разрешите среду в общих настройках запуска.</p>}
          </div>
          <button type="button" className="primary-button" aria-label="Добавить маршрут проекта"
            disabled={!normalizeProjectKey(newProject).startsWith("/") || newProjectHarnesses.length === 0}
            onClick={() => {
              const key = normalizeProjectKey(newProject);
              if (!key.startsWith("/") || newProjectHarnesses.length === 0) return;
              setRoutes({ ...(policy.projectRoutes ?? {}), [key]: { harnesses: [...newProjectHarnesses] } });
              setNewProject("");
              setNewProjectHarnesses([]);
            }}>Добавить проект</button>
        </fieldset>
      </section>
      {draft.conflict && draft.conflicts.length === 0 && <p className="autopilot-error" role="alert">Политика запуска изменилась в другой вкладке. Ваши правки сохранены в форме и не отправлены.
        <button type="button" className="quiet-button" aria-label="Обновить маршруты и применить правки заново" disabled={saving} onClick={() => void draft.resolveConflict()}>Обновить и применить заново</button>
      </p>}
      {draft.conflicts.length > 0 && <p className="autopilot-error" role="alert">{`Проект${draft.conflicts.length > 1 ? "ы" : ""} ${draft.conflicts.join(", ")} изменились в другой вкладке. Ваша версия оставлена в форме, но не сохранена: перезагрузите страницу или измените проект заново.`}
        <button type="button" className="quiet-button" aria-label="Перезагрузить маршруты и отбросить правки" disabled={saving} onClick={() => void draft.reload()}>Перезагрузить и отбросить правки</button>
      </p>}
      {saveError && <p className="autopilot-error" role="alert">{`Не сохранено: ${explainModelListError(saveError)}`}</p>}
      {!valid && <p className="projects-help" role="alert">Маршрут задан некорректно: проверьте путь проекта, среды и модели. Пока это не исправлено, политика запуска не сохранится.</p>}
      <div className="settings-save-row projects-save-row">
        <span role="status">
          {unsaved
            ? <span className="projects-dirty"><span aria-hidden="true">●</span> Есть несохранённые изменения</span>
            : saved ? <span className="settings-saved">Маршруты сохранены</span> : "Изменения применятся к новым сессиям этого проекта."}
        </span>
        <button type="button" className="primary-button" aria-label="Сохранить маршруты проектов"
          disabled={!valid || saving || loading || Boolean(loadError)} onClick={() => void draft.save()}>{saving ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </>}
  </section>;
}
