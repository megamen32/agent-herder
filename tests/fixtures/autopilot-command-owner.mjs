#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const root = dirname(process.env.HERDER_V1_ENTRY);
const path = join(root, "rule.json");
const registration = join(root, "registered");
const err = code => ({ isError: true, structuredContent: { code, effect: "none" }, content: [] });
function call(name, a) {
  appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ name, ...a }) + "\n");
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
    if (a.action === "pause" && existsSync(join(root, "lose-pause"))) process.exit(0);
    if (a.action === "pause" && existsSync(join(root, "concurrent-pause"))) return err("revision_conflict");
    data = rule;
  } else return err("unexpected_operation");
  return { structuredContent: data, content: [] };
}
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (method === "tools/list") result = { tools: ["automation", "session"].map(name => ({ name, inputSchema: { type: "object" } })) };
  else if (method === "tools/call") result = call(params.name, params.arguments);
  else throw new Error("unexpected MCP method");
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
