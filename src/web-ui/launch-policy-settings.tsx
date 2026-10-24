import { INCIDENT_EXECUTION, normalizeIncidentExecution, type HealthExecutionProfile } from "../health-remediation.js";
import * as React from "react";

export type ProjectLaunchRoute = {
  harnesses: string[];
  models?: Record<string, string>;
  /** Real card project identifiers that resolve to this route. */
  aliases?: string[];
  /** Model ids this project may run on. Empty or absent means no restriction. */
  allowedModels?: string[];
  /** Model ids this project must never run on. A denial always wins. */
  deniedModels?: string[];
  /**
   * The identifier of the AI profile this project uses.
   *
   * The profile itself lives in the settings layer and is named here by a
   * reference, so the panel keeps one truth about it and never a second copy.
   */
  profileId?: string;
};

export type LaunchPolicy = {
  version: 1;
  allowedHarnesses: string[];
  preferredHarness: string;
  models: Record<string, string>;
  incidentExecution?: HealthExecutionProfile;
  projectRoutes?: Record<string, ProjectLaunchRoute>;
};

export type LaunchRuntimeOption = { id: string; name: string; active: boolean };

/** The top-level parts of the launch policy document an editor may own. */
export type LaunchPolicyField = "allowedHarnesses" | "preferredHarness" | "models" | "incidentExecution" | "projectRoutes";

export const LAUNCH_POLICY_FIELDS: readonly LaunchPolicyField[] = [
  "allowedHarnesses",
  "preferredHarness",
  "models",
  "incidentExecution",
  "projectRoutes",
];

export const DEFAULT_LAUNCH_POLICY: LaunchPolicy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode"],
  preferredHarness: "codex",
  models: {
    codex: "gpt-6.1-sol",
    zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
  },
};

/** The document identity of a policy that was never saved. */
export const ABSENT_POLICY_ETAG = '"absent"';

export const FALLBACK_LABELS: Record<string, string> = {
  codex: "Codex",
  zcode: "ZCode",
  opencode: "OpenCode",
  claude: "Claude Code",
  qoder: "Qoder",
  hermes: "Hermes",
  "fast-agent": "Fast Agent",
  chatgpt: "ChatGPT",
};

export function updateAllowedHarness(policy: LaunchPolicy, harness: string, allowed: boolean): LaunchPolicy {
  const allowedHarnesses = allowed
    ? [...new Set([...policy.allowedHarnesses, harness])]
    : policy.allowedHarnesses.filter((item) => item !== harness);
  const preferredHarness = allowedHarnesses.length === 0
    ? policy.preferredHarness
    : allowedHarnesses.includes(policy.preferredHarness) ? policy.preferredHarness : allowedHarnesses[0]!;
  return { ...policy, allowedHarnesses, preferredHarness };
}

export function updatePreferredHarness(policy: LaunchPolicy, harness: string): LaunchPolicy {
  return policy.allowedHarnesses.includes(harness) ? { ...policy, preferredHarness: harness } : policy;
}

export function normalizeProjectKey(project: string): string {
  return project.trim().replace(/\/+$/, "");
}

export function updateProjectRoute(
  policy: LaunchPolicy,
  project: string,
  update: (route: ProjectLaunchRoute) => ProjectLaunchRoute,
): LaunchPolicy {
  const key = normalizeProjectKey(project);
  const routes = { ...(policy.projectRoutes ?? {}) };
  if (key.length === 0 || !routes[key]) return { ...policy, projectRoutes: routes };
  routes[key] = update(routes[key]);
  return { ...policy, projectRoutes: routes };
}

export function moveProjectRouteHarness(route: ProjectLaunchRoute, harness: string, offset: -1 | 1): ProjectLaunchRoute {
  const index = route.harnesses.indexOf(harness);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= route.harnesses.length) return route;
  const harnesses = [...route.harnesses];
  [harnesses[index], harnesses[target]] = [harnesses[target]!, harnesses[index]!];
  return { ...route, harnesses };
}

export function updateProjectRouteModel(route: ProjectLaunchRoute, harness: string, model: string): ProjectLaunchRoute {
  const models = { ...(route.models ?? {}) };
  if (model.trim()) models[harness] = model;
  else delete models[harness];
  return { ...route, models };
}

export function removeProjectRouteHarness(route: ProjectLaunchRoute, harness: string): ProjectLaunchRoute {
  const updated = updateProjectRouteModel(route, harness, "");
  return { ...updated, harnesses: route.harnesses.filter((item) => item !== harness) };
}

/** One model list of a project route, read from the stored document. */
function parseModelList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 256);
  return models.length > 0 ? [...new Set(models)] : undefined;
}

/** Add or remove one model in the allowed or the denied list of a route. */
export function updateProjectRouteModelList(
  route: ProjectLaunchRoute,
  field: "allowedModels" | "deniedModels",
  model: string,
): ProjectLaunchRoute {
  const normalized = model.trim();
  const current = route[field] ?? [];
  if (normalized.length === 0) return route;
  if (current.some((entry) => entry.trim().toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US"))) return route;
  return { ...route, [field]: [...current, normalized] };
}

/** Remove one model from the allowed or the denied list of a route. */
export function removeProjectRouteModelList(
  route: ProjectLaunchRoute,
  field: "allowedModels" | "deniedModels",
  model: string,
): ProjectLaunchRoute {
  const current = route[field] ?? [];
  const next = current.filter((entry) => entry !== model);
  if (next.length === current.length) return route;
  return { ...route, [field]: next };
}

export function parseProjectRoutes(value: unknown): Record<string, ProjectLaunchRoute> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Маршруты проектов должны быть объектом");
  const routes: Record<string, ProjectLaunchRoute> = {};
  for (const [project, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeProjectKey(project);
    if (!key.startsWith("/")) throw new Error(`Маршрут проекта «${project}» должен быть абсолютным путём`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Маршрут проекта «${project}» имеет неверный формат`);
    const route = raw as { harnesses?: unknown; models?: unknown };
    if (!Array.isArray(route.harnesses) || route.harnesses.length === 0
      || !route.harnesses.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`Маршрут проекта «${project}» должен содержать среды`);
    }
    const aliases = Array.isArray((route as { aliases?: unknown }).aliases)
      ? [...new Set((route as { aliases: string[] }).aliases
        .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
        .map((alias) => alias.trim()))]
      : undefined;
    const models: Record<string, string> | undefined = route.models && typeof route.models === "object" && !Array.isArray(route.models)
      ? Object.fromEntries(Object.entries(route.models as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0 && entry[1].length <= 256))
      : undefined;
    const allowedModels = parseModelList((route as { allowedModels?: unknown }).allowedModels);
    const deniedModels = parseModelList((route as { deniedModels?: unknown }).deniedModels);
    routes[key] = {
      harnesses: [...new Set(route.harnesses as string[])],
      ...(models && Object.keys(models).length > 0 ? { models } : {}),
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      ...(allowedModels ? { allowedModels } : {}),
      ...(deniedModels ? { deniedModels } : {}),
    };
  }
  return routes;
}

export function parseLaunchPolicy(value: unknown): LaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ответ настроек запуска имеет неверный формат");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.allowedHarnesses)
    || !candidate.allowedHarnesses.every((item) => typeof item === "string")
    || typeof candidate.preferredHarness !== "string"
    || !candidate.models || typeof candidate.models !== "object" || Array.isArray(candidate.models)
    || Object.values(candidate.models as Record<string, unknown>).some((model) => typeof model !== "string")) {
    throw new Error("Ответ настроек запуска имеет неверный формат");
  }
  const models = candidate.models as Record<string, string>;
  const policy = {
    version: 1 as const,
    allowedHarnesses: [...new Set(candidate.allowedHarnesses as string[])],
    preferredHarness: candidate.preferredHarness,
    models,
    ...(candidate.incidentExecution === undefined ? {} : { incidentExecution: normalizeIncidentExecution(candidate.incidentExecution) }),
    ...(candidate.projectRoutes === undefined ? {} : { projectRoutes: parseProjectRoutes(candidate.projectRoutes) }),
  };
  if (policy.allowedHarnesses.length > 0 && !policy.allowedHarnesses.includes(policy.preferredHarness)) {
    throw new Error("Основная среда должна входить в разрешённые варианты");
  }
  return policy;
}

/**
 * Apply only the fields the operator actually changed onto a newer document.
 *
 * A save that lost the race must not carry the stale copy of every untouched
 * field back to the server: a concurrent change of the global allowlist or of
 * the incident route stays untouched.
 */
export function mergePolicyChanges(
  fresh: LaunchPolicy,
  draft: LaunchPolicy,
  dirty: readonly LaunchPolicyField[],
): LaunchPolicy {
  const changed = new Set(dirty);
  return {
    ...fresh,
    ...(changed.has("allowedHarnesses") ? { allowedHarnesses: draft.allowedHarnesses } : {}),
    ...(changed.has("preferredHarness") ? { preferredHarness: draft.preferredHarness } : {}),
    ...(changed.has("models") ? { models: draft.models } : {}),
    ...(changed.has("incidentExecution") ? { incidentExecution: draft.incidentExecution } : {}),
    ...(changed.has("projectRoutes") ? { projectRoutes: draft.projectRoutes } : {}),
  };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export type PolicyLoad =
  | { kind: "ready"; policy: LaunchPolicy; etag: string }
  | { kind: "absent"; etag: string }
  | { kind: "invalid"; error: string }
  | { kind: "unavailable"; error: string };

/**
 * Read the launch policy together with the identity of the stored document.
 *
 * An absent document and a broken document are different states: only an
 * absent one may be created from the form, a broken one must be shown as an
 * error instead of being replaced.
 */
export async function loadLaunchPolicy(): Promise<PolicyLoad> {
  let response: Response;
  try {
    response = await fetch("/api/automation/launch-policy", { headers: { accept: "application/json" }, cache: "no-store" });
  } catch {
    return { kind: "unavailable", error: "Не удалось связаться с сервером настроек запуска." };
  }
  const etag = response.headers.get("etag") ?? "";
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) {
    if (!etag) return { kind: "unavailable", error: "Сервер не вернул версию настроек запуска. Обновите страницу и повторите." };
    try {
      return { kind: "ready", policy: parseLaunchPolicy(body), etag };
    } catch (error) {
      return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
    }
  }
  const state = typeof body.state === "string" ? body.state : "";
  const detail = typeof body.detail === "string" && body.detail
    ? body.detail
    : typeof body.error === "string" ? body.error : "";
  if (response.status === 503 && state === "absent") return { kind: "absent", etag: etag || ABSENT_POLICY_ETAG };
  if (response.status === 503 && state === "invalid") return { kind: "invalid", error: detail || "Политика запуска повреждена." };
  return { kind: "unavailable", error: detail || `Сервер настроек запуска ответил кодом ${response.status}.` };
}

export type PolicySave =
  | { kind: "saved"; policy: LaunchPolicy; etag: string }
  | { kind: "conflict" }
  | { kind: "rejected"; error: string };

/** Write the whole document, but only over the exact version that was read. */
export async function saveLaunchPolicy(policy: LaunchPolicy, etag: string): Promise<PolicySave> {
  let response: Response;
  try {
    response = await fetch("/api/automation/launch-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": etag },
      body: JSON.stringify(policy),
    });
  } catch {
    return { kind: "rejected", error: "Не удалось связаться с сервером настроек запуска." };
  }
  if (response.status === 412) return { kind: "conflict" };
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" && body.error
      ? body.error
      : `Сервер отклонил настройки (код ${response.status}).`;
    return { kind: "rejected", error: message };
  }
  try {
    return { kind: "saved", policy: parseLaunchPolicy(body), etag: response.headers.get("etag") ?? etag };
  } catch (error) {
    return { kind: "rejected", error: error instanceof Error ? error.message : String(error) };
  }
}

export type LaunchPolicyDraft = {
  /** The document the form shows. It is the draft until it is saved. */
  policy: LaunchPolicy;
  /** The parts of the document the operator actually changed. */
  dirty: LaunchPolicyField[];
  /** The identity of the stored document the draft was read from. */
  etag: string;
  /** "absent" means the policy was never saved; "invalid" means it is broken. */
  phase: "loading" | "ready" | "absent" | "invalid" | "error";
  loadError?: string;
  saveError?: string;
  /** The server holds a newer document than the one this form was read from. */
  conflict: boolean;
  /** The project keys that could not be merged after a conflict. */
  conflicts: string[];
  saving: boolean;
  saved: boolean;
};

/** The result of merging a draft into a newer document. */
export type PolicyMergeResult = {
  /** The document to send to the server. */
  merged: LaunchPolicy;
  /** The project keys whose server value changed and whose draft was kept. */
  conflicts: string[];
  /** The draft route values that stay in the form instead of being saved. */
  kept?: Record<string, ProjectLaunchRoute | undefined>;
};

export type PolicyMergeContext = {
  /** The document the form was read from. */
  base: LaunchPolicy;
  /** The document the server holds right now. */
  fresh: LaunchPolicy;
  /** The document the form shows. */
  draft: LaunchPolicy;
  /** The parts the operator changed since the last read. */
  dirty: LaunchPolicyField[];
  /** The route values that already lost a conflict and were not re-edited. */
  kept: Record<string, ProjectLaunchRoute | undefined>;
};

export type PolicyMergeStrategy = (context: PolicyMergeContext) => PolicyMergeResult;

/** Compare two project routes by value. */
export function sameProjectRoute(left?: ProjectLaunchRoute, right?: ProjectLaunchRoute): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.harnesses.length !== right.harnesses.length) return false;
  if (!left.harnesses.every((harness, index) => harness === right.harnesses[index])) return false;
  if (!sameStringMap(left.models, right.models)) return false;
  if (!sameStringList(left.allowedModels, right.allowedModels)) return false;
  if (!sameStringList(left.deniedModels, right.deniedModels)) return false;
  // The reference to the AI profile is a part of the route: a route that
  // changed only its profile is a changed route, and a comparison that did
  // not know about it would drop the change without saying so.
  if ((left.profileId ?? undefined) !== (right.profileId ?? undefined)) return false;
  return sameStringList(left.aliases, right.aliases);
}

/**
 * The parts of a project route that differ between two values.
 *
 * The merge uses this to tell a parallel edit of one part from a real
 * conflict on the same part: an edit of the model lists must not overwrite a
 * route change made elsewhere, and the other way round. The model map is
 * compared per harness, so two harnesses do not conflict with each other.
 */
export type ProjectRoutePart = "harnesses" | "aliases" | "allowedModels" | "deniedModels" | "profileId" | `model:${string}`;

export function changedProjectRouteParts(
  left?: ProjectLaunchRoute,
  right?: ProjectLaunchRoute,
): Set<ProjectRoutePart> {
  const parts = new Set<ProjectRoutePart>();
  if (!left || !right) {
    if (left || right) {
      parts.add("harnesses");
      parts.add("aliases");
      parts.add("allowedModels");
      parts.add("deniedModels");
      parts.add("profileId");
      for (const harness of new Set([...Object.keys(left?.models ?? {}), ...Object.keys(right?.models ?? {})])) {
        parts.add(`model:${harness}`);
      }
    }
    return parts;
  }
  if (left.harnesses.length !== right.harnesses.length
    || !left.harnesses.every((harness, index) => harness === right.harnesses[index])) parts.add("harnesses");
  if (!sameStringList(left.aliases, right.aliases)) parts.add("aliases");
  if (!sameStringList(left.allowedModels, right.allowedModels)) parts.add("allowedModels");
  if (!sameStringList(left.deniedModels, right.deniedModels)) parts.add("deniedModels");
  if ((left.profileId ?? undefined) !== (right.profileId ?? undefined)) parts.add("profileId");
  for (const harness of new Set([...Object.keys(left.models ?? {}), ...Object.keys(right.models ?? {})])) {
    if ((left.models ?? {})[harness] !== (right.models ?? {})[harness]) parts.add(`model:${harness}`);
  }
  return parts;
}

/**
 * Merge one project route part by part.
 *
 * A part the operator changed and the server did not is taken from the
 * operator. A part both sides changed is a real conflict and keeps the server
 * value; the caller then reports the project as conflicted.
 */
export function mergeProjectRouteParts(
  base: ProjectLaunchRoute | undefined,
  fresh: ProjectLaunchRoute | undefined,
  draft: ProjectLaunchRoute | undefined,
): { route?: ProjectLaunchRoute; conflict: boolean } {
  if (!base) return { route: draft ?? fresh, conflict: false };
  if (!draft) return { route: fresh, conflict: false };
  if (!fresh) return { route: draft, conflict: false };
  const draftParts = changedProjectRouteParts(base, draft);
  const freshParts = changedProjectRouteParts(base, fresh);
  const models: Record<string, string> = { ...(fresh.models ?? {}) };
  const merged: ProjectLaunchRoute = {
    harnesses: [...fresh.harnesses],
    ...(fresh.aliases ? { aliases: [...fresh.aliases] } : {}),
    ...(fresh.allowedModels ? { allowedModels: [...fresh.allowedModels] } : {}),
    ...(fresh.deniedModels ? { deniedModels: [...fresh.deniedModels] } : {}),
    // The reference to the AI profile travels with the route: a merge that
    // rebuilt the route from a known set of fields would drop it, and the
    // project would lose its profile without saying so.
    ...(fresh.profileId ? { profileId: fresh.profileId } : {}),
  };
  let conflict = false;
  for (const part of draftParts) {
    // A part both sides changed is a real conflict: the server value stays.
    if (freshParts.has(part)) {
      conflict = true;
      continue;
    }
    switch (part) {
      case "harnesses": merged.harnesses = [...draft.harnesses]; break;
      case "aliases": merged.aliases = draft.aliases ? [...draft.aliases] : undefined; break;
      case "allowedModels": merged.allowedModels = draft.allowedModels ? [...draft.allowedModels] : undefined; break;
      case "deniedModels": merged.deniedModels = draft.deniedModels ? [...draft.deniedModels] : undefined; break;
      case "profileId": merged.profileId = draft.profileId; break;
      default: {
        const harness = part.slice("model:".length);
        const model = draft.models?.[harness];
        if (model) models[harness] = model;
        else delete models[harness];
      }
    }
  }
  if (Object.keys(models).length > 0) merged.models = models;
  return { route: merged, conflict };
}

function sameStringMap(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left![key] === right![key]);
}

function sameStringList(left?: string[], right?: string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The default merge: only the parts the operator changed are carried over. */
export const defaultPolicyMerge: PolicyMergeStrategy = ({ fresh, draft, dirty }) => ({
  merged: mergePolicyChanges(fresh, draft, dirty),
  conflicts: [],
});

/** Put the kept draft values back into the document the form shows. */
function withKeptDraft(document: LaunchPolicy, kept: Record<string, ProjectLaunchRoute | undefined>, draft: LaunchPolicy): LaunchPolicy {
  const keys = Object.keys(kept);
  if (keys.length === 0) return document;
  const routes = { ...(document.projectRoutes ?? {}) };
  for (const key of keys) {
    const value = draft.projectRoutes?.[key];
    if (value === undefined) delete routes[key];
    else routes[key] = value;
  }
  return { ...document, projectRoutes: routes };
}

/** The document to send: the kept values stay at the server's version. */
function withoutKeptDraft(document: LaunchPolicy, base: LaunchPolicy, kept: Record<string, ProjectLaunchRoute | undefined>): LaunchPolicy {
  const keys = Object.keys(kept);
  if (keys.length === 0) return document;
  const baseRoutes = base.projectRoutes ?? {};
  const routes = { ...(document.projectRoutes ?? {}) };
  for (const key of keys) {
    const value = baseRoutes[key];
    if (value === undefined) delete routes[key];
    else routes[key] = value;
  }
  return { ...document, projectRoutes: routes };
}

/**
 * One editable copy of the launch policy document.
 *
 * Every write carries the identity of the document it was read from, so a
 * concurrent change is reported instead of being overwritten. A conflict
 * keeps the draft: the operator's edits stay in the form until they are
 * applied on top of a fresh read or thrown away explicitly.
 */
export function useLaunchPolicyDraft(options: { merge?: PolicyMergeStrategy } = {}) {
  const merge = options.merge ?? defaultPolicyMerge;
  const [policy, setPolicy] = React.useState<LaunchPolicy>(DEFAULT_LAUNCH_POLICY);
  const [base, setBase] = React.useState<LaunchPolicy>(DEFAULT_LAUNCH_POLICY);
  const [dirty, setDirty] = React.useState<LaunchPolicyField[]>([]);
  const [kept, setKept] = React.useState<Record<string, ProjectLaunchRoute | undefined>>({});
  const [etag, setEtag] = React.useState(ABSENT_POLICY_ETAG);
  const [phase, setPhase] = React.useState<LaunchPolicyDraft["phase"]>("loading");
  const [loadError, setLoadError] = React.useState<string>();
  const [saveError, setSaveError] = React.useState<string>();
  const [conflict, setConflict] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // The kept values are exactly the parts that lost a conflict.
  const conflicts = Object.keys(kept);

  const load = React.useCallback(async () => {
    setPhase("loading");
    const result = await loadLaunchPolicy();
    if (result.kind === "ready") {
      setPolicy(result.policy);
      setBase(result.policy);
      setKept({});
      setEtag(result.etag);
      setPhase("ready");
      setLoadError(undefined);
      return;
    }
    if (result.kind === "absent") {
      setPolicy(DEFAULT_LAUNCH_POLICY);
      setBase(DEFAULT_LAUNCH_POLICY);
      setKept({});
      setEtag(result.etag || ABSENT_POLICY_ETAG);
      setPhase("absent");
      setLoadError(undefined);
      return;
    }
    setPhase(result.kind === "invalid" ? "invalid" : "error");
    setLoadError(result.error);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  /** Record an edit of one part of the document. */
  const edit = React.useCallback((next: LaunchPolicy, field: LaunchPolicyField) => {
    setPolicy(next);
    setDirty((current) => (current.includes(field) ? current : [...current, field]));
    // A value that changed after it lost a conflict is an explicit re-edit.
    setKept((current) => {
      const keys = Object.keys(current);
      if (keys.length === 0) return current;
      const nextKept: Record<string, ProjectLaunchRoute | undefined> = { ...current };
      for (const key of keys) {
        if (!sameProjectRoute(current[key], next.projectRoutes?.[key])) delete nextKept[key];
      }
      return nextKept;
    });
    setSaved(false);
    setSaveError(undefined);
  }, []);

  const save = React.useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setSaveError(undefined);
    try {
      const result = await saveLaunchPolicy(withoutKeptDraft(policy, base, kept), etag);
      if (result.kind === "saved") {
        setPolicy(withKeptDraft(result.policy, kept, policy));
        setBase(result.policy);
        setDirty([]);
        setConflict(false);
        setSaved(true);
        setPhase("ready");
        return;
      }
      if (result.kind === "conflict") {
        // The draft stays untouched: nothing of the operator's work is lost.
        setConflict(true);
        return;
      }
      setSaveError(result.error);
    } finally {
      setSaving(false);
    }
  }, [policy, base, kept, etag, saving]);

  /**
   * Read the current document and apply the draft on top of it.
   *
   * Only the parts the operator changed are carried over, so a concurrent
   * change of the untouched parts survives the retry.
   */
  const resolveConflict = React.useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const fresh = await loadLaunchPolicy();
      if (fresh.kind !== "ready" && fresh.kind !== "absent") {
        setSaveError(fresh.kind === "invalid" ? fresh.error : "Не удалось получить актуальную политику запуска.");
        return;
      }
      const freshPolicy = fresh.kind === "ready" ? fresh.policy : DEFAULT_LAUNCH_POLICY;
      const result = merge({ base, fresh: freshPolicy, draft: policy, dirty, kept });
      const saved = await saveLaunchPolicy(result.merged, fresh.etag || ABSENT_POLICY_ETAG);
      if (saved.kind === "saved") {
        setPolicy(withKeptDraft(saved.policy, result.kept ?? {}, policy));
        setBase(saved.policy);
        setKept(result.kept ?? {});
        setDirty([]);
        setConflict(false);
        setSaved(true);
        setPhase("ready");
        return;
      }
      if (saved.kind === "conflict") {
        setConflict(true);
        setSaveError("Политика запуска изменилась ещё раз. Повторите обновление.");
        return;
      }
      setSaveError(saved.error);
    } finally {
      setSaving(false);
    }
  }, [base, policy, dirty, kept, merge, saving]);

  return {
    policy,
    base,
    dirty,
    kept,
    etag,
    phase,
    loadError,
    saveError,
    conflict,
    conflicts,
    saving,
    saved,
    edit,
    save,
    reload: load,
    resolveConflict,
  } as const;
}

/** The runtime names and the model list of every active harness. */
export function useRuntimeModels() {
  const [runtimes, setRuntimes] = React.useState<LaunchRuntimeOption[]>([]);
  const [modelOptions, setModelOptions] = React.useState<Record<string, string[]>>({});
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await requestJson<{ adapters?: Array<{ id: string; name: string; active: boolean }> }>("/api/adapters");
        if (cancelled) return;
        setRuntimes((result.adapters ?? []).filter((item) => item.active).map(({ id, name, active: isActive }) => ({ id, name, active: isActive })));
      } catch {
        if (!cancelled) setRuntimes([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(runtimes.map(async ({ id }) => {
        try {
          const result = await requestJson<{ models?: string[] }>(`/api/models?harness=${encodeURIComponent(id)}`);
          return [id, result.models ?? []] as const;
        } catch { return [id, []] as const; }
      }));
      if (!cancelled) setModelOptions(Object.fromEntries(results));
    };
    if (runtimes.length > 0) void load();
    return () => { cancelled = true; };
  }, [runtimes]);
  return { runtimes, modelOptions };
}

/**
 * The model catalog of the given harnesses.
 *
 * The route may name a harness that is not an active adapter, so the catalog
 * is requested per harness of the route instead of reusing the runtime list.
 */
export function useHarnessModelCatalog(harnesses: string[]) {
  const [catalog, setCatalog] = React.useState<Record<string, string[]>>({});
  const key = [...new Set(harnesses)].sort().join(",");
  React.useEffect(() => {
    let cancelled = false;
    const targets = key ? key.split(",") : [];
    const load = async () => {
      const results = await Promise.all(targets.map(async (harness) => {
        try {
          const result = await requestJson<{ models?: string[] }>(`/api/models?harness=${encodeURIComponent(harness)}`);
          return [harness, result.models ?? []] as const;
        } catch { return [harness, []] as const; }
      }));
      if (!cancelled) setCatalog(Object.fromEntries(results));
    };
    if (targets.length > 0) void load();
    return () => { cancelled = true; };
  }, [key]);
  return catalog;
}

export function labelFor(harness: string, runtimes: LaunchRuntimeOption[]): string {
  const label = runtimes.find((runtime) => runtime.id === harness)?.name ?? FALLBACK_LABELS[harness];
  if (label) return label;
  const humanized = harness.replace(/[-_]+/g, " ").trim();
  return humanized ? humanized[0]!.toUpperCase() + humanized.slice(1) : harness;
}

export function inputId(harness: string): string {
  return `launch-model-${harness.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** The datalist id of the incident model field. */
export const INCIDENT_MODEL_LIST_ID = "launch-model-incident";

/**
 * The fully qualified route of the incident model of the policy.
 *
 * The stored model is the route the owner typed. A bare model id is carried
 * by the approved OmniRoute provider, so the route of both forms is the same.
 */
export function incidentModelRoute(policy: LaunchPolicy): string {
  const execution = policy.incidentExecution;
  if (!execution) return "";
  const model = execution.model.trim();
  if (!model) return "";
  return model.includes("/") ? model : `${execution.provider}/${model}`;
}

/** The problem of a hand-typed model, if there is one. */
export function modelValueIssue(value: string): string | undefined {
  const model = value.trim();
  if (!model) return "Укажите модель.";
  if (model.length > 256) return "Модель должна быть не длиннее 256 символов.";
  if (/[\u0000-\u001f\u007f]/u.test(model)) return "Модель не должна содержать управляющие символы.";
  return undefined;
}

/** The problem of a hand-typed incident model, if there is one. */
export function incidentModelIssue(value: string): string | undefined {
  const issue = modelValueIssue(value);
  if (issue) return issue;
  const model = value.trim();
  const gateway = model.toLocaleLowerCase("en-US").startsWith("omniroute/");
  const miniMaxRoute = model.toLocaleLowerCase("en-US").startsWith("minimax-coding-plan/");
  if (model.includes("/") && !gateway && !miniMaxRoute) {
    return "Маршрут инцидента должен вести через OmniRoute (или через маршрут MiniMax), без подмены провайдера.";
  }
  return undefined;
}

/**
 * The warning of a hand-typed model that the harness catalog does not list.
 *
 * The owner is the authority, so an unknown model is never refused: the form
 * only says that the model is not in the live catalog and cannot be
 * route-verified.
 */
export function modelCatalogIssue(harness: string, value: string, options: readonly string[] | undefined): string | undefined {
  const model = value.trim();
  if (!model) return undefined;
  const catalog = options ?? [];
  if (catalog.length === 0) return undefined;
  if (catalog.includes(model)) return undefined;
  return `Модель «${model}» не найдена в каталоге harness ${harness} — будет сохранена как есть.`;
}

/** A unique list id for one model field of one project route. */
export function routeInputId(project: string, harness: string): string {
  return `launch-model-${project.replace(/[^a-zA-Z0-9_-]/g, "-")}-${harness.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function LaunchPolicySettings({ onOpenProjects }: { onOpenProjects?: () => void } = {}) {
  const draft = useLaunchPolicyDraft();
  const { runtimes, modelOptions } = useRuntimeModels();
  const policy = draft.policy;
  const loading = draft.phase === "loading";
  const needsSetup = draft.phase === "absent";
  const loadError = draft.loadError;
  const saving = draft.saving;
  const saved = draft.saved;
  const saveError = draft.saveError;

  const known = [...runtimes];
  const displayedHarnesses = [...new Set([
    ...runtimes.map(({ id }) => id),
    ...policy.allowedHarnesses,
    policy.preferredHarness,
  ])];
  const optionsForSelect = policy.allowedHarnesses.length > 0 ? policy.allowedHarnesses : displayedHarnesses;
  const projectRoutes = Object.entries(policy.projectRoutes ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const routesValid = projectRoutes.every(([project, route]) =>
    project.startsWith("/") && route.harnesses.length > 0
    && route.harnesses.every((harness) => policy.allowedHarnesses.length === 0 || policy.allowedHarnesses.includes(harness))
    && route.harnesses.every((harness) => {
      const model = route.models?.[harness] ?? policy.models[harness];
      return Boolean(model?.trim()) && model.length <= 256;
    }));
  // The gateway combo route stays the first choice; the MiniMax route
  // is allowed as a fallback, so nothing is filtered out of the list.
  const incidentModelOptions = (() => {
    const options = [...(modelOptions.opencode ?? [])];
    const first = "omniroute/minimax-combo-m3.1";
    return options.sort((left, right) => (left === first ? -1 : right === first ? 1 : 0));
  })();
  const incidentIssue = policy.incidentExecution ? incidentModelIssue(policy.incidentExecution.model) : undefined;
  const incidentWarning = policy.incidentExecution
    ? modelCatalogIssue("opencode", incidentModelRoute(policy), modelOptions.opencode)
    : undefined;
  const valid = routesValid
    && (policy.allowedHarnesses.length === 0 || policy.allowedHarnesses.includes(policy.preferredHarness))
    && policy.preferredHarness.length > 0
    && policy.allowedHarnesses.every((harness) => !modelValueIssue(policy.models[harness] ?? ""))
    && !incidentIssue;

  return <section className="global-autopilot-card launch-policy-settings" aria-label="Запуск новых сессий">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">НОВЫЕ СЕССИИ</span><h3>Запуск новых сессий</h3><p>Выберите, где Herder может создавать новые сессии и какая среда основная. Текущие сессии и автопродолжение это не затрагивает.</p></div>
    </div>
    {loading ? <p className="settings-loading" role="status">Загружаем настройки запуска…</p> : <>
      {needsSetup && <p className="launch-policy-notice" role="status">Настройки запуска ещё не сохранены. До сохранения автоматический запуск новых сессий запрещён.</p>}
      {draft.phase === "invalid" && <p className="autopilot-error" role="alert">Политика запуска повреждена, поэтому сохранить её из формы нельзя: {loadError}. Файл политики на сервере нужно исправить вручную.</p>}
      {draft.phase === "error" && <p className="autopilot-error" role="alert">Не удалось загрузить настройки запуска: {loadError}. Обновите страницу и повторите.</p>}
      <details className="settings-advanced"><summary>Дополнительно: локальный маршрут инцидентов Herder</summary>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Локальный маршрут инцидентов Herder</legend>
        <p>Модель для анализа инцидентов Notice Place выбирается в <a href="https://notify.bezrabotnyi.com/admin/#health-model">админке Notice Place</a>. Herder проверяет допустимость запуска и запускает сессию. Поля ниже задают локальный маршрут Herder и не меняют выбор модели в Notice Place.</p>
        <label className="launch-policy-field"><span>Среда локального маршрута Herder</span>
          <select aria-label="Среда локального маршрута Herder" value={policy.incidentExecution?.runtime ?? ""} onChange={() => {
            draft.edit({ ...policy, incidentExecution: { ...INCIDENT_EXECUTION } }, "incidentExecution");
          }}><option value="" disabled>Выберите среду</option><option value="opencode">OpenCode · MiniMax через OmniRoute</option></select>
        </label>
        <label className="launch-policy-field"><span>Модель локального маршрута Herder</span>
          <input type="text" maxLength={256} list={INCIDENT_MODEL_LIST_ID} value={policy.incidentExecution?.model ?? ""}
            placeholder="omniroute/провайдер/модель" aria-label="Модель локального маршрута Herder" aria-invalid={Boolean(incidentIssue)}
            onChange={(event) => {
              draft.edit({ ...policy, incidentExecution: { ...(policy.incidentExecution ?? INCIDENT_EXECUTION), model: event.target.value } }, "incidentExecution");
            }} />
          <datalist id={INCIDENT_MODEL_LIST_ID}>{incidentModelOptions.map((model) => <option value={model} key={model} />)}</datalist>
        </label>
        {incidentIssue && <small className="autopilot-error" role="alert">{incidentIssue}</small>}
        {incidentWarning && <small className="settings-help" role="status">{incidentWarning}</small>}
        <small>Провайдер: omniroute. При отказе запуск сохраняет причину и не меняет провайдера.</small>
        {policy.incidentExecution && <small className="settings-help">Маршрут запуска: {incidentModelRoute(policy)}</small>}
        {!policy.incidentExecution && <p role="status">Маршрут инцидентов ещё не сохранён.</p>}
      </fieldset>
      </details>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Разрешённые среды</legend>
        {displayedHarnesses.length === 0
          ? <p className="settings-help">Нет доступных сред запуска.</p>
          : <div className="launch-runtime-list">{displayedHarnesses.map((harness) => {
            const harnessLabel = labelFor(harness, known);
            const allowed = policy.allowedHarnesses.includes(harness);
            return <label className="launch-runtime-option" key={harness} title={harness === harnessLabel ? undefined : harness}>
              <span>
                <strong>{harnessLabel}</strong>
                <small aria-hidden="true">{allowed ? "вкл" : "выкл"}</small>
              </span>
              <input type="checkbox" checked={allowed} aria-label={`${harnessLabel}: ${allowed ? "вкл" : "выкл"}`} onChange={(event) => {
                const next = updateAllowedHarness(policy, harness, event.target.checked);
                draft.edit(next, "allowedHarnesses");
                draft.edit(next, "preferredHarness");
              }} />
            </label>;
          })}</div>}
        {policy.allowedHarnesses.length > 0 && <label className="launch-policy-field"><span>Основная среда</span><select value={policy.preferredHarness} aria-label="Основная среда запуска" onChange={(event) => {
          draft.edit(updatePreferredHarness(policy, event.target.value), "preferredHarness");
        }}>{optionsForSelect.map((harness) => <option value={harness} key={harness}>{labelFor(harness, known)}</option>)}</select></label>}
        {policy.allowedHarnesses.map((harness) => {
          const model = policy.models[harness] ?? "";
          const issue = modelValueIssue(model);
          const warning = modelCatalogIssue(harness, model, modelOptions[harness]);
          return <label className="launch-policy-field" key={harness}>
            <span>Модель · {labelFor(harness, known)}</span>
            <input type="text" maxLength={256} list={inputId(harness)} value={model} placeholder="Укажите модель" aria-label={`Модель для среды ${labelFor(harness, known)}`} aria-invalid={Boolean(issue)} onChange={(event) => {
              draft.edit({ ...policy, models: { ...policy.models, [harness]: event.target.value } }, "models");
            }} />
            <datalist id={inputId(harness)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model} />)}</datalist>
            {issue && <small className="autopilot-error" role="alert">{issue}</small>}
            {warning && <small className="settings-help" role="status">{warning}</small>}
          </label>;
        })}
        {policy.allowedHarnesses.length === 0 && <p className="settings-help">Автоматический запуск новых сессий отключён. Основной вариант сохранён и будет доступен после выбора разрешённой среды.</p>}
      </fieldset>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Порядок сред для проектов</legend>
        <p>Маршрут каждого проекта задаётся на вкладке «Проекты»: порядок сред, модель маршрута и идентификаторы карточек. Здесь видно только текущее состояние.</p>
        {projectRoutes.length === 0
          ? <p className="settings-help">Маршруты проектов не настроены. Для всех проектов используется основная среда.</p>
          : <div className="launch-runtime-list">{projectRoutes.map(([project, route]) => <div className="launch-runtime-option" key={project}>
            <span>
              <strong>{project}</strong>
              <small aria-hidden="true">
                {route.harnesses.map((harness) => labelFor(harness, known)).join(" → ")}
                {route.aliases?.length ? ` · карточки: ${route.aliases.join(", ")}` : ""}
              </small>
            </span>
            {onOpenProjects && <button type="button" aria-label={`Изменить маршрут проекта ${project}`} onClick={onOpenProjects}>Изменить</button>}
          </div>)}</div>}
        {onOpenProjects && <button type="button" className="quiet-button" aria-label="Открыть настройки проектов" onClick={onOpenProjects}>Открыть проекты</button>}
        {!routesValid && <p className="settings-help" role="alert">Маршрут проекта задан некорректно. Исправьте его на вкладке «Проекты», иначе политика запуска не сохранится.</p>}
      </fieldset>
      {draft.conflict && <p className="autopilot-error" role="alert">Политика запуска изменилась в другой вкладке. Ваши правки сохранены в форме и не отправлены.
        <button type="button" className="quiet-button" aria-label="Обновить политику запуска и применить правки заново" disabled={saving} onClick={() => void draft.resolveConflict()}>Обновить и применить заново</button>
      </p>}
      {saveError && <p className="autopilot-error" role="alert">Не удалось сохранить настройки: {saveError}</p>}
      <div className="settings-save-row"><span>{saved ? <span className="settings-saved" role="status">Настройки сохранены</span> : needsSetup ? "Сохраните выбор, чтобы разрешить создание сессий." : "Изменения применятся только к новым сессиям."}</span>
        <button className="primary-button" aria-label="Сохранить настройки запуска" disabled={!valid || saving || loading || Boolean(loadError)} onClick={() => void draft.save()}>{saving ? "Сохраняем…" : "Сохранить"}</button></div>
    </>}
  </section>;
}
