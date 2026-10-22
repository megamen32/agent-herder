import type { AutomationDisarmDocument, AutomationDisarmRecord, AutomationDisarmStore } from "./state.js";
import { ALL_SCOPES, canonicalScopePath, scopeCovers, scopeSpecificity, workKeyDirectory } from "./scope.js";

/**
 * The stable machine-readable code of an owner refusal.
 *
 * The code says one thing: the owner forbids the automatic launch of this
 * scope. It is deliberately distinct from the human-stop message, which says
 * that a person stopped this chat. A caller may retry a failed delivery, but
 * a retry of a forbidden launch is pointless: only an explicit owner action
 * lifts it.
 *
 * The literal is the one the whole cluster agreed on: `automation_disabled`,
 * the same class the health contour already names in its set of refusal
 * codes. One line carries one value, so a third spelling of the same refusal
 * is not introduced.
 */
export const AUTOMATION_FORBIDDEN_CODE = "automation_disabled";

/** The reason an automatic run is refused because the whole lever is on. */
export const AUTOMATION_DISARMED_MESSAGE =
  "Автоматический запуск запрещён владельцем: автоматика отключена до явного действия владельца.";

/** The reason an automatic run is refused because this area is forbidden. */
export const AUTOMATION_SCOPE_FORBIDDEN_MESSAGE =
  "Автоматический запуск запрещён владельцем: автоматика запрещена в этой области до явного действия владельца.";

/** The reason an automatic run is refused because this work is blocked. */
export const AUTOMATION_WORK_DISARMED_MESSAGE =
  "Автоматический запуск этой работы запрещён владельцем: работа заблокирована по логическому ключу, а не по id сессии.";

/**
 * Who starts a run.
 *
 * `human` is work a person started explicitly, `explicit` is an explicit call
 * of the session-creation tool for one concrete session, and `automation` is
 * every automatic path. The lever only ever refuses `automation`.
 */
export type AutomationLaunchSource = "human" | "explicit" | "automation";

export interface AutomationDisarmDecision {
  allowed: boolean;
  /** The stable code of the refusal. */
  code?: typeof AUTOMATION_FORBIDDEN_CODE;
  /** Why the run was refused. */
  reason?: string;
  /** The logical work key the refusal was made on. */
  workKey?: string;
  /** The scope that refused the run. */
  scope?: string;
  /**
   * The area of the refusal, as a structured value beside the code.
   *
   * The area is never carried by the wording alone: the code says that the
   * automation is off, and this field says where. The catch-all scope keeps
   * its own literal, so a reader tells the whole contour from one project
   * without reading the wording.
   */
  routingReasonDetail?: string;
}

/**
 * Decide whether one run may start, resolving the work keys only when they
 * can matter.
 *
 * The work key of a session is only known from a native read, so the resolver
 * is called only when the owner actually named a scope or a work. A runtime
 * that is armed and has no record costs no native call at all, and a guard
 * placed before an admission check never changes what that check observes.
 */
export async function automationDisarmDecisionWithWork(
  store: AutomationDisarmStore,
  resolveWorkKeys: () => Promise<string[]>,
  source: AutomationLaunchSource,
): Promise<AutomationDisarmDecision> {
  if (source !== "automation") return { allowed: true };
  const state = await store.read();
  if (!needsWorkKeys(state)) return decisionOf(state, []);
  const workKeys = await resolveWorkKeys();
  return decisionOf(state, workKeys);
}

/**
 * Decide whether one run may start.
 *
 * The decision is fail-closed for automation: a forbidden scope refuses every
 * automatic run of that scope, and a runtime whose owner file cannot be
 * trusted refuses every automatic run too. A human-started or explicitly
 * created session is never refused, so the lever is not a "stop everything"
 * switch.
 *
 * `workKeys` are the logical identities of the run, not its session id.
 */
export async function automationDisarmDecision(
  store: AutomationDisarmStore,
  workKeys: readonly string[],
  source: AutomationLaunchSource,
): Promise<AutomationDisarmDecision> {
  if (source !== "automation") return { allowed: true };
  const state = await store.read();
  return decisionOf(state, workKeys);
}

/**
 * Does the state need the work keys at all?
 *
 * The catch-all record without named works decides every run by itself, so a
 * runtime in that state costs no native read.
 */
function needsWorkKeys(state: AutomationDisarmDocument): boolean {
  return state.records.some((record) => record.scope !== ALL_SCOPES || record.workKeys?.length);
}

/**
 * The decision of one state for the named works.
 *
 * The scope that decides is the most specific one that covers the run: a
 * project scope beats the catch-all scope, and a record that names exact
 * works beats a record that names the whole scope. An explicit permission
 * ends the search, so a scope that the owner permitted stays permitted.
 */
async function decisionOf(
  state: AutomationDisarmDocument,
  workKeys: readonly string[],
): Promise<AutomationDisarmDecision> {
  for (const workKey of workKeys) {
    const refusal = await refuseForWorkKey(state, workKey);
    if (refusal) return refusal;
  }
  if (workKeys.length > 0) return { allowed: true };
  // The work of the run is unknown, so only a record that forbids a whole
  // scope can decide. A record that names exact works cannot: the work it
  // names is the one that is unknown.
  return refuseWithoutWorkKey(state);
}

/** The refusal of the records that forbid a whole scope, without a work key. */
async function refuseWithoutWorkKey(state: AutomationDisarmDocument): Promise<AutomationDisarmDecision> {
  const broad = state.records
    .filter((record) => record.scope === ALL_SCOPES && !record.workKeys?.length)
    .sort((left, right) => scopeSpecificity(right.scope, false) - scopeSpecificity(left.scope, false))[0];
  if (!broad || broad.forbidden === false) return { allowed: true };
  return refusal(broad, undefined, undefined);
}

/** The refusal of one work key, or undefined when the run may start. */
async function refuseForWorkKey(
  state: AutomationDisarmDocument,
  workKey: string,
): Promise<AutomationDisarmDecision | undefined> {
  const pathRecords = state.records.filter((record) => record.scope !== ALL_SCOPES);
  const directory = pathRecords.length ? await canonicalDirectory(workKey) : undefined;
  const covering = state.records
    .filter((record) => record.scope === ALL_SCOPES || scopeCovers(record.scope, directory))
    .sort((left, right) => scopeSpecificity(right.scope, Boolean(right.workKeys?.length))
      - scopeSpecificity(left.scope, Boolean(left.workKeys?.length)));
  for (const record of covering) {
    // An explicit permission of this scope ends the search: the scope is
    // permitted, and no coarser record may forbid it again.
    if (record.forbidden === false) return undefined;
    const keys = record.workKeys ?? [];
    // A record without named works forbids the whole scope.
    if (keys.length === 0) return refusal(record, workKey, undefined);
    // A record with named works forbids only those works. Another record may
    // still forbid the rest of the scope.
    if (keys.includes(workKey)) return refusal(record, workKey, workKey);
  }
  return undefined;
}

/** The canonical directory of the work of one run. */
async function canonicalDirectory(workKey: string): Promise<string | undefined> {
  const directory = workKeyDirectory(workKey);
  if (!directory) return undefined;
  return canonicalScopePath(directory);
}

/** The refusal of one record, in words and in code. */
async function refusal(
  record: AutomationDisarmRecord,
  workKey: string | undefined,
  namedWork: string | undefined,
): Promise<AutomationDisarmDecision> {
  const message = namedWork
    ? AUTOMATION_WORK_DISARMED_MESSAGE
    : record.scope === ALL_SCOPES
      ? AUTOMATION_DISARMED_MESSAGE
      : AUTOMATION_SCOPE_FORBIDDEN_MESSAGE;
  const reason = record.reason ? `${message} Причина: ${record.reason}` : message;
  return {
    allowed: false,
    code: AUTOMATION_FORBIDDEN_CODE,
    reason,
    ...(workKey ? { workKey } : {}),
    scope: record.scope,
    // The area travels beside the code, never inside the wording.
    routingReasonDetail: await scopeDetail(record),
  };
}

/**
 * The area of one refusal, in its canonical form.
 *
 * The catch-all scope is the whole contour and keeps its own literal, so a
 * reader of the field tells "every automatic launch" from "this project"
 * without reading the wording. A path scope is canonicalized here, so the
 * field names one area in one form whatever the state file holds.
 */
async function scopeDetail(record: AutomationDisarmRecord): Promise<string> {
  if (record.scope === ALL_SCOPES) return ALL_SCOPES;
  return canonicalScopePath(record.scope);
}
