// Operator controls for the existing Rust owner. Only an explicit session switch can hand it a turn.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CanonicalHerderError, type CanonicalAutomationClient } from "../canonical-herder.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { GoalStore } from "./goal-store.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./policy-store.js";
import { readGoalSnapshot, type AutopilotHarness, type AutopilotSessionStore } from "./session-store.js";

type Target = { harness: AutopilotHarness; sessionId: string; cwd: string };
type Command = "on" | "status" | "off" | "reset";
type Call = CanonicalAutomationClient["call"];
const instructions = "Check the human's assignment, subsequent clarifications and the latest assistant answer. Continue only when work on the assignment remains.";

async function readOwner<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      // The automation driver briefly holds the same nonblocking store gate.
      if (!(error instanceof CanonicalHerderError) || error.effect !== "none" || attempt >= 3
        || !["session_unavailable", "scope_unavailable", "store_unavailable", "autopilot_store_unavailable"].includes(error.code)) throw error;
      await sleep(50 * 2 ** attempt);
    }
  }
}

async function sessionRef(client: CanonicalAutomationClient, id: string, register: boolean) {
  const lookup = () => readOwner(() => client.resolveNative("codex", id));
  try { return (await lookup()).sessionRef; }
  catch (error) {
    if (!(error instanceof CanonicalHerderError && error.code === "native_session_not_registered" && error.effect === "none")) throw error;
    if (!register) return;
  }
  const node = client.config.node_ref;
  const inventory = await readOwner(() => client.call("discover", { action: "instances", ...(node && { node_ref: node }) }));
  if (inventory.complete !== true || !Array.isArray(inventory.instances)) throw new Error("Incomplete registered owner inventory");
  const matches = inventory.instances.filter(owner => owner?.harness === "codex" && (!node || owner.node_ref === node));
  const owner = matches[0];
  if (matches.length !== 1 || !owner.node_ref || typeof owner.node_ref !== "string"
    || !owner.instance_ref || typeof owner.instance_ref !== "string") throw new Error("Exact Codex instance required to register this session");
  await client.call("session", { action: "register", native_session_id: id, instance_ref: owner.instance_ref,
    request_key: "autopilot-register-" + createHash("sha256").update(id).digest("hex") });
  const bound = await lookup();
  if (bound.nodeRef !== owner.node_ref || bound.instanceRef !== owner.instance_ref) throw new Error("Codex autopilot session binding mismatch");
  return bound.sessionRef;
}

type Rule = { kind: "autopilot"; rule_ref: string; revision: number; enabled: boolean; phase: string;
  rule: { kind: "autopilot"; instructions: string } };
function ruleReceipt(raw: Record<string, unknown>, session: string, ref?: string): Rule {
  const rule = raw as unknown as Rule;
  if (raw.session_ref !== session || rule.kind !== "autopilot" || !rule.rule_ref || typeof rule.rule_ref !== "string"
    || (ref !== undefined && rule.rule_ref !== ref) || !Number.isSafeInteger(rule.revision) || rule.revision < 1
    || typeof rule.enabled !== "boolean" || typeof rule.phase !== "string" || rule.rule?.kind !== "autopilot"
    || typeof rule.rule.instructions !== "string") throw new Error("Invalid Codex autopilot rule receipt");
  return rule;
}

async function currentRule(call: Call, session: string): Promise<Rule | undefined> {
  const list = await readOwner(() => call("automation", { action: "list", session_ref: session }));
  if (list.complete !== true || !Array.isArray(list.rules)) throw new Error("Incomplete Codex autopilot rule list");
  const matches = list.rules.filter(r => r.kind === "autopilot");
  if (!matches.length) return;
  if (matches.length !== 1) throw new Error("Ambiguous Codex autopilot rule");
  const { rule_ref } = ruleReceipt(matches[0], session);
  return ruleReceipt(await readOwner(() => call("automation", { action: "get", rule_ref })), session, rule_ref);
}

async function changeRule(call: Call, session: string, current: Rule, enabled: boolean) {
  const { rule_ref, revision } = current;
  try {
    const result = await call("automation", { action: enabled ? "update" : "pause", rule_ref, revision,
      ...(enabled && { rule: current.rule }) });
    const next = ruleReceipt(result, session, rule_ref);
    if (next.enabled !== enabled || next.revision !== revision + 1) throw new Error("Unconfirmed Codex autopilot revision");
    return next;
  } catch (error) {
    if (error instanceof CanonicalHerderError && error.code === "revision_conflict" && error.effect === "none") {
      const observed = ruleReceipt(await readOwner(() => call("automation", { action: "get", rule_ref })), session, rule_ref);
      if (observed.enabled === enabled && (!enabled || observed.rule.instructions === current.rule.instructions)) return observed;
    }
    throw error;
  }
}

export async function nativeAutopilotCommand(client: CanonicalAutomationClient | undefined, command: Command,
  target: Target, store: AutopilotSessionStore, policyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(store.stateDir))) {
  if (target.harness !== "codex") return;
  const previous = await store.get(target.harness, target.sessionId);
  if (command === "reset" && previous?.executor !== "rust") return;
  if (previous?.executor === "typescript" || previous?.noticeIncident || previous?.noticeAttempt) return;
  if (!client && previous?.executor !== "rust") return;
  const policy = await policyStore.readEffective();
  if (policy.policy.judgeMode === "self") return;
  const identity = { ...target, cwd: previous?.cwd ?? resolve(target.cwd) };
  if (await readGoalSnapshot(new GoalStore(store.stateDir), identity)) return;

  const status = { ok: true, command, harness: target.harness, sessionId: target.sessionId,
    session_id: target.sessionId, cwd: identity.cwd, source: "session", executor: "rust" };

  const operate = async () => {
    const row = await store.get(target.harness, target.sessionId);
    const disabling = command === "off" || command === "reset";
    if (disabling && row?.executor === "rust" && row.enabled)
      await store.set({ ...identity, executor: "rust" }, false);
    if (!client) throw new Error("Registered Rust autopilot owner unavailable");
    const held = await getHumanStopStore().isHeld(target.harness, target.sessionId);
    if (command === "on" && held) return { ...status, enabled: false, human_stop_held: true };
    if (command === "on" && policy.source === "error") throw new Error("Invalid Codex autopilot policy");
    const session = await sessionRef(client, target.sessionId, command === "on");
    // Read-only inspection preserves the saved evaluator until a personal switch hands it to Rust.
    if (command === "status" && row?.executor !== "rust") return;
    const call = client.call.bind(client);
    let rule = session ? await currentRule(call, session) : undefined;
    if (command === "on" && session) {
      if (row?.executor !== "rust" || row.enabled !== true) await store.set({ ...identity, executor: "rust" }, true);
      if (!rule) {
        rule = ruleReceipt(await call("automation", { action: "create", session_ref: session,
          request_key: "autopilot-" + createHash("sha256").update(session).digest("hex"),
          rule: { kind: "autopilot", instructions } }), session);
      } else if (!rule.enabled || row?.executor !== "rust" || row.enabled !== true) {
        rule = await changeRule(call, session, rule, true);
      }
      if (!rule.enabled) throw new Error("Rust did not enable the selected rule");
    } else if (disabling) {
      if (row?.executor !== "rust") await store.set({ ...identity, executor: "rust" }, false);
      if (rule?.enabled && session) rule = await changeRule(call, session, rule, false);
      if (command === "reset") await store.delete(target.harness, target.sessionId);
    }
    return { ...status, enabled: !!rule?.enabled && !held && (command === "on" || row?.enabled === true),
      ...(held && { human_stop_held: true }),
      ...(rule && { rule_ref: rule.rule_ref, revision: rule.revision, phase: rule.phase }) };
  };
  return command === "status" ? operate() : store.withNativeCommand(target.sessionId, operate);
}
