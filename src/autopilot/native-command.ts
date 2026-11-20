// Operator controls for the existing Rust owner. Only an explicit session switch can hand it a turn.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CanonicalHerderError, readCanonicalPrivateBytes, unwrapCanonicalResult } from "../canonical-herder.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { GoalStore } from "./goal-store.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./policy-store.js";
import { readGoalSnapshot, type AutopilotHarness, type AutopilotSessionStore } from "./session-store.js";

type Target = { harness: AutopilotHarness; sessionId: string; cwd: string };
type Command = "on" | "status" | "off" | "reset";
type Owner = { node: string; instance: string };
type Selection = { selector: string; owners: Owner[] };
type Call = (name: "session" | "automation", args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const instructions = "Check the human's assignment, subsequent clarifications and the latest assistant answer. Continue only when work on the assignment remains.";

async function privateJson(path: string) {
  if (!isAbsolute(path)) throw new Error("Invalid local owner profile path");
  // The installed selector can point through the release directory symlink.
  const canonical = join(await realpath(dirname(path)), basename(path));
  return JSON.parse((await readCanonicalPrivateBytes(canonical)).toString("utf8"));
}

async function selectedOwners(stateDir: string): Promise<Selection | undefined> {
  const selector = process.env.HERDER_V1_ENTRY ?? join(homedir(), ".config/agent-herder/v1-entry.json");
  let selection;
  try { selection = await privateJson(selector); }
  catch (error) {
    if (!process.env.HERDER_V1_ENTRY && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!Array.isArray(selection.profiles)) throw new Error("Invalid local owner selector");
  const owners: Owner[] = [];
  for (const path of selection.profiles) {
    const { owner } = await privateJson(path);
    const profile = owner?.codex_autopilot;
    if (owner?.kind !== "codex" || !profile || profile.state_dir !== stateDir) continue;
    if (typeof owner.node !== "string" || !owner.node || typeof owner.instance !== "string" || !owner.instance)
      throw new Error("Invalid Codex autopilot owner");
    if ((profile.policy_file ?? join(stateDir, "autopilot-policy.json")) !== resolveAutopilotPolicyStorePath(stateDir))
      throw new Error("Codex autopilot policy path mismatch");
    owners.push({ node: owner.node, instance: owner.instance });
  }
  return owners.length ? { selector, owners } : undefined;
}

async function withOwner<T>(selector: string, operation: (call: Call) => Promise<T>): Promise<T> {
  const client = new Client({ name: "agent-herder-autopilot", version: "1" });
  const transport = new StdioClientTransport({ command: join(homedir(), ".local/bin/agent-herder-v1"),
    env: { HERDER_V1_ENTRY: selector }, stderr: "ignore" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    return await operation(async (name, args) => {
      const read = args.action === "resolve" || args.action === "list" || args.action === "get";
      for (let attempt = 0; ; attempt++) {
        try { return unwrapCanonicalResult(await client.callTool({ name, arguments: args }, { timeout: 10_000 })); }
        catch (error) {
          if (!(error instanceof CanonicalHerderError)) throw error;
          // The native driver briefly holds the same nonblocking store gate.
          if (read && attempt < 3 && error.effect === "none"
            && ["session_unavailable", "scope_unavailable", "store_unavailable", "autopilot_store_unavailable"].includes(error.code)) {
            await sleep(50 * 2 ** attempt);
            continue;
          }
          throw new CanonicalHerderError(error.code, error.effect, `${name}.${args.action}: ${error.code}`);
        }
      }
    });
  } finally { await client.close(); }
}

async function sessionRef(call: Call, owners: Owner[], id: string, register: boolean) {
  const owner = owners.length === 1 ? owners[0] : undefined;
  const lookup = () => call("session", { action: "resolve", harness: "codex", native_session_id: id,
    ...(owner && { node_ref: owner.node }) });
  let result;
  try { result = await lookup(); }
  catch (error) {
    if (!(error instanceof CanonicalHerderError && error.code === "native_session_not_registered" && error.effect === "none")) throw error;
    if (!register) return;
    if (!owner) throw new Error("Exact Codex instance required to register this session");
    await call("session", { action: "register", native_session_id: id, instance_ref: owner.instance,
      request_key: "autopilot-register-" + createHash("sha256").update(id).digest("hex") });
    result = await lookup();
  }
  const proof = result.owner as Record<string, unknown> | undefined;
  if (result.complete !== true || typeof result.session_ref !== "string" || !result.session_ref || proof?.harness !== "codex"
    || proof.native_session_id !== id || !owners.some(o => proof.node_ref === o.node && proof.instance_ref === o.instance))
    throw new Error("Codex autopilot session binding mismatch");
  return result.session_ref;
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
  const list = await call("automation", { action: "list", session_ref: session });
  if (list.complete !== true || !Array.isArray(list.rules)) throw new Error("Incomplete Codex autopilot rule list");
  const matches = list.rules.filter(r => r.kind === "autopilot");
  if (!matches.length) return;
  if (matches.length !== 1) throw new Error("Ambiguous Codex autopilot rule");
  const { rule_ref } = ruleReceipt(matches[0], session);
  return ruleReceipt(await call("automation", { action: "get", rule_ref }), session, rule_ref);
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
      const observed = ruleReceipt(await call("automation", { action: "get", rule_ref }), session, rule_ref);
      if (observed.enabled === enabled && (!enabled || observed.rule.instructions === current.rule.instructions)) return observed;
    }
    throw error;
  }
}

export async function nativeAutopilotCommand(command: Command, target: Target, store: AutopilotSessionStore,
  policyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(store.stateDir))) {
  if (target.harness !== "codex") return;
  const previous = await store.get(target.harness, target.sessionId);
  if (previous?.executor !== "rust" && command !== "on" && command !== "off") return;
  if (previous?.executor === "typescript" || previous?.noticeIncident || previous?.noticeAttempt) return;
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
    const selection = await selectedOwners(store.stateDir);
    if (!selection) {
      if (row?.executor === "rust") throw new Error("Selected Rust autopilot owner unavailable");
      return;
    }
    const held = await getHumanStopStore().isHeld(target.harness, target.sessionId);
    if (command === "on" && held) return { ...status, enabled: false, human_stop_held: true };
    if (command === "on" && policy.source === "error") throw new Error("Invalid Codex autopilot policy");
    return withOwner(selection.selector, async call => {
      const session = await sessionRef(call, selection.owners, target.sessionId, command === "on");
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
    });
  };
  return command === "status" ? operate() : store.withNativeCommand(target.sessionId, operate);
}
