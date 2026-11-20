import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registeredTransport(root, selector, authority) {
  return { call(target, name, a) {
    if (target !== authority) throw new Error("wrong registered authority");
    if (existsSync(join(root, "transport-down"))) throw new Error("registered_transport_unavailable");
    const path = join(root, "rule.json");
    const registration = join(root, "registered");
    const err = code => ({ isError: true, structuredContent: { code, effect: "none" }, content: [] });
    appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ name, ...a }) + "\n");
    if (name === "discover" && a.action === "instances") {
      const profiles = JSON.parse(readFileSync(selector, "utf8")).profiles;
      return { complete: true, instances: profiles.map(file => {
        const { owner } = JSON.parse(readFileSync(file, "utf8"));
        return { harness: owner.kind, node_ref: owner.node, instance_ref: owner.instance };
      }) };
    }
    let rule = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    let data;
    if (name === "session" && a.native_session_id === "exact-thread") {
      if (a.action === "resolve" && existsSync(join(root, "busy-once"))) {
        unlinkSync(join(root, "busy-once"));
        return err("session_unavailable");
      }
      if (a.action === "register" && a.instance_ref === "codex-local") writeFileSync(registration, "");
      if (!existsSync(registration)) return err("native_session_not_registered");
      data = { complete: true, session_ref: "ses_exact", owner: { harness: "codex", node_ref: "local",
        instance_ref: "codex-local", native_session_id: a.native_session_id } };
    } else if (name === "automation" && a.action === "list" && a.session_ref === "ses_exact") {
      data = { complete: true, rules: rule ? [rule] : [] };
    } else if (name === "automation" && a.action === "get" && rule && a.rule_ref === rule.rule_ref) {
      data = rule;
    } else if (name === "automation" && a.action === "create" && a.session_ref === "ses_exact" && !rule
      || name === "automation" && rule && ["update", "pause"].includes(a.action) && a.revision === rule.revision && a.rule_ref === rule.rule_ref) {
      const enabled = a.action !== "pause";
      const personal = JSON.parse(readFileSync(join(root, "state/sessions.json"), "utf8")).sessions.find(r => r.sessionId === "exact-thread");
      if (personal?.executor !== "rust" || personal.enabled !== enabled) return err("personal_policy_required");
      rule = { rule_ref: "autopilot-rule:exact", session_ref: "ses_exact", kind: "autopilot", rule: a.rule ?? rule.rule,
        revision: (rule?.revision ?? 0) + 1, enabled, phase: enabled ? "armed" : "paused" };
      writeFileSync(path, JSON.stringify(rule));
      if (a.action === "pause" && existsSync(join(root, "lose-pause"))) throw new Error("registered_pause_ack_lost");
      if (a.action === "pause" && existsSync(join(root, "concurrent-pause"))) return err("revision_conflict");
      data = rule;
    } else return err("unexpected_operation");
    return { structuredContent: data, content: [] };
  } };
}
