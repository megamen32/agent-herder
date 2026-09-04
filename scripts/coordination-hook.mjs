#!/usr/bin/env node
const endpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }
const event = input.hook_event_name || "";
const sessionId = String(input.session_id || "");
const cwd = String(input.cwd || process.cwd());
const harness = process.env.AGENT_HERDER_HARNESS || "codex";
const output = (name, context) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, ...(context ? { additionalContext: context } : {}) } }));
const fetchJson = async (url, options) => { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(1200) }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
function stringCommand(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["command", "cmd", "script"]) if (typeof value[key] === "string") return value[key];
  }
  return "";
}
function isWriteActivity(toolName, toolInput) {
  const name = String(toolName || "").toLowerCase();
  if (/(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)/.test(name)) return true;
  if (!/(?:bash|shell|terminal|exec|command)/.test(name)) return false;
  const command = stringCommand(toolInput);
  return [
    /(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)/,
    /(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)/,
    /(?:^|[^<])>{1,2}\s*[^&]/,
  ].some((pattern) => pattern.test(command));
}
function collectPaths(value, out = new Set()) {
  if (typeof value === "string") {
    for (const re of [/\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/g, /(?:^|\s)(\.?\.?\/[\w@%+.,~\-\/]+|\/[\w@%+.,~\-\/]+)/g, /(?:>{1,2}|tee(?:\s+-\S+)*|sed\s+-[^\n;]*i\s+(?:[^\s]+\s+)?)\s*["']?([\w@%+.,~\-]+(?:\/[\w@%+.,~\-]+)+|[\w@%+.,~\-]+\.[A-Za-z0-9_-]+)["']?/g]) {
      for (const match of value.matchAll(re)) { const p = (match[1] || "").trim().replace(/["'`,;:)]+$/g, ""); if (p && !p.includes('://')) out.add(p); }
    }
    return out;
  }
  if (Array.isArray(value)) { for (const item of value) collectPaths(item, out); return out; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(path|file|file_path|filepath|filename)$/i.test(key) && typeof item === "string") out.add(item);
      else if (/^(paths|files)$/i.test(key) && Array.isArray(item)) for (const p of item) if (typeof p === "string") out.add(p);
      collectPaths(item, out);
    }
  }
  return out;
}
function normalizePaths(paths) {
  const result = [];
  for (let p of paths) {
    p = p.trim(); if (!p) continue;
    if (p.startsWith('/')) {
      if (p === cwd) p = '.';
      else if (p.startsWith(cwd.replace(/\/$/, '') + '/')) p = p.slice(cwd.replace(/\/$/, '').length + 1);
      else continue;
    }
    if (p.startsWith('./')) p = p.slice(2);
    if (!p || p === '.' || p.startsWith('../')) continue;
    result.push(p);
  }
  return [...new Set(result)].slice(0, 32);
}
try {
  if (event === "SessionStart" || event === "UserPromptSubmit") {
    const q = new URLSearchParams({ harness, sessionId, cwd, touch: "1" });
    const data = await fetchJson(`${endpoint}/api/coordination/context?${q}`);
    output(event, data.context || undefined);
  } else if (event === "PreToolUse" || event === "PostToolUse") {
    const paths = isWriteActivity(input.tool_name, input.tool_input) ? normalizePaths(collectPaths(input.tool_input)) : [];
    const data = await fetchJson(`${endpoint}/api/coordination/activity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness, sessionId, cwd, paths }) });
    output(event, data.context || undefined);
  }
} catch { process.exit(0); }
