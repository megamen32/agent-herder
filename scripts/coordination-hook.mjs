#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve, isAbsolute } from "node:path";

import { readProhibitions, reportActivity } from "./hooks-prohibitions.mjs";

const endpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }
const event = input.hook_event_name || input.hookEventName || "";
const sessionId = String(input.session_id || input.sessionId || "");
const cwd = String(input.cwd || process.cwd());
const harness = process.env.AGENT_HERDER_HARNESS || "codex";
// The lever of the owner. While the prohibitions of this hook are on, the
// hook may put a conflict into the context of the tool call. When they are
// off — or when the state of the lever cannot be read at all — the hook
// passes no prohibition on: a hook that cannot work never gets in the way.
const HOOK_EVENTS = ["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"];
const prohibition = HOOK_EVENTS.includes(event) ? await readProhibitions(event) : { known: false, enabled: false };
// The prohibition content of the coordination context: the soft lock that
// asks the agent to agree before it edits an overlapping path.
function withoutProhibitions(context) {
  return String(context ?? "")
    .replace(/<agent-herder-path-conflict>[\s\S]*?<\/agent-herder-path-conflict>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const output = (name, context) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, ...(context ? { additionalContext: context } : {}) } }));
const fetchJson = async (url, options) => { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(1200) }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
function stringCommand(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["command", "cmd", "script", "code"]) if (typeof value[key] === "string") return value[key];
  }
  return "";
}
function isWriteActivity(toolName, toolInput) {
  const name = String(toolName || "").toLowerCase();
  if (/(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)/.test(name)) return true;
  if (!/(?:bash|shell|terminal|exec|command)/.test(name)) return false;
  const command = stringCommand(toolInput);
  const codeInput = toolInput && typeof toolInput === "object" && typeof toolInput.code === "string";
  const rawExecInput = typeof toolInput === "string" && /(?:^|\.)exec$/.test(name);
  const nested = codeInput ? embeddedCommands(toolInput.code) : embeddedCommands(command);
  const commands = codeInput || rawExecInput ? nested : [command, ...nested];
  if ((codeInput || rawExecInput) && commands.length === 0) return false;
  return commands.some((candidate) => [
    /(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)/,
    /(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)/,
    /(?:^|[^<])>{1,2}\s*[^&]/,
  ].some((pattern) => pattern.test(candidate)));
}
function addPatchTargets(text, out) {
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/gm)) out.add(match[1].trim());
  for (const match of text.matchAll(/^\*\*\* Move to:\s*([^\n]+)/gm)) out.add(match[1].trim());
}
function shellWords(text) {
  return [...text.matchAll(/"((?:\\.|[^"])*)"|'([^']*)'|([^\s;&|]+)/g)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
}
function splitShellSegments(command) {
  const segments = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "|" || (char === "&" && command[index - 1] !== ">" && command[index - 1] !== "<") || char === "\n") {
      segments.push(command.slice(start, index));
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      start = index + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}
function withoutRedirections(words) {
  const result = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (/^(?:\d+)?(?:>{1,2}|<{1,2})$/.test(word)) { index += 1; continue; }
    if (/^(?:\d+)?(?:>{1,2}|<{1,2})(?:&(?:\d+|-)|.+)$/.test(word)) continue;
    result.push(word);
  }
  return result;
}
// This is intentionally a bounded operand reader, not a shell interpreter:
// recognize a command only at the start of an unquoted segment, with simple
// sudo/env wrappers and leading NAME=value assignments.
function commandAtStart(words) {
  const clean = withoutRedirections(words);
  let index = 0;
  while (index < clean.length) {
    const word = clean[index];
    if (/^[A-Za-z_][\w]*=.*/.test(word)) { index += 1; continue; }
    if (word === "sudo") {
      index += 1;
      while (index < clean.length && /^-/.test(clean[index])) {
        const option = clean[index++];
        if (["-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--close-from"].includes(option) && index < clean.length) index += 1;
      }
      continue;
    }
    if (word === "env") {
      index += 1;
      while (index < clean.length) {
        if (/^[A-Za-z_][\w]*=.*/.test(clean[index])) { index += 1; continue; }
        if (/^-[iu0]$/.test(clean[index])) { index += 1; continue; }
        if (["-u", "--unset", "-C", "--chdir"].includes(clean[index]) && index + 1 < clean.length) { index += 2; continue; }
        break;
      }
      continue;
    }
    return { verb: word, args: clean.slice(index + 1) };
  }
  return undefined;
}
function addShellTargets(command, out) {
  // Here-doc bodies are content, not file operands, even when they mention paths.
  const source = command.replace(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n\2(?=\s|$)/g, "");
  for (const segment of splitShellSegments(source)) {
    const words = shellWords(segment);
    if (!words.length) continue;
    const invocation = commandAtStart(words);
    if (invocation) {
      const { verb } = invocation;
      const args = invocation.args.filter((word) => word && !word.startsWith("-"));
      let targets = [];
      if (["mv", "rm", "touch", "mkdir", "truncate", "tee"].includes(verb)) targets = args;
      else if (["cp", "install"].includes(verb)) targets = args.slice(-1);
      else if (["sed", "perl"].includes(verb) && /(?:^|\s)-[^\s]*i/.test(segment)) targets = args.slice(-1);
      for (const target of targets) if (target !== "--" && !target.includes("://")) out.add(target);
    }
    if (invocation?.verb === "git" && ["mv", "rm", "checkout", "restore"].includes(invocation.args[0])) {
      const subcommand = invocation.args[0];
      const args = invocation.args.slice(1).filter((word) => word && !word.startsWith("-"));
      const targets = ["mv", "rm"].includes(subcommand) ? args
        : invocation.args.includes("--") ? invocation.args.slice(invocation.args.lastIndexOf("--") + 1).filter((word) => word && !word.startsWith("-")) : [];
      for (const target of targets) if (target !== "--" && !target.includes("://")) out.add(target);
    }
    // Output redirection is an explicit write target; do not scan other command text.
    for (const target of redirectionTargets(segment)) if (!target.includes("://")) out.add(target);
  }
}
function redirectionTargets(segment) {
  const targets = [];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ">" || segment[index - 1] === "<") continue;
    if (segment[index + 1] === "&") {
      let fd = index + 2;
      if (segment[fd] === "-") fd += 1;
      else while (/\d/.test(segment[fd] || "")) fd += 1;
      index = fd - 1;
      continue;
    }
    let cursor = index + 1;
    if (segment[cursor] === ">") cursor += 1;
    while (/\s/.test(segment[cursor] || "")) cursor += 1;
    const opener = segment[cursor];
    if (opener === "'" || opener === '"') {
      const closer = segment.indexOf(opener, cursor + 1);
      if (closer > cursor + 1) targets.push(segment.slice(cursor + 1, closer));
      index = closer > cursor ? closer : cursor;
      continue;
    }
    let end = cursor;
    while (end < segment.length && !/[\s;&|]/.test(segment[end])) end += 1;
    if (end > cursor) targets.push(segment.slice(cursor, end));
    index = end - 1;
  }
  return targets;
}
function addEmbeddedCommands(code, out) {
  for (const command of embeddedCommands(code)) addShellTargets(command, out);
}
function embeddedCommands(code) {
  const commands = [];
  for (const match of code.matchAll(/(?:cmd|command)\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g)) {
    commands.push((match[1] ?? match[2] ?? "").replace(/\\(["'\\])/g, "$1"));
  }
  return commands;
}
function collectPaths(value, out = new Set(), field = "") {
  if (typeof value === "string") {
    if (/^(?:patch|diff|unified_diff)$/i.test(field) || (!field && /^\s*\*\*\* Begin Patch\b/m.test(value))) addPatchTargets(value, out);
    else if (/^(?:command|cmd|script)$/i.test(field)) addShellTargets(value, out);
    else if (/^code$/i.test(field)) addEmbeddedCommands(value, out);
    else if (!field) {
      const embedded = embeddedCommands(value);
      if (embedded.length) for (const command of embedded) addShellTargets(command, out);
      else addShellTargets(value, out);
    }
    return out;
  }
  if (Array.isArray(value)) { for (const item of value) collectPaths(item, out, field); return out; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(path|file|file_path|filepath|filename)$/i.test(key) && typeof item === "string") {
        out.add(item);
      } else if (/^(paths|files)$/i.test(key) && Array.isArray(item)) {
        for (const p of item) if (typeof p === "string") out.add(p);
      } else if (!/^(cwd|workdir|directory)$/i.test(key)) {
        collectPaths(item, out, key);
      }
    }
  }
  return out;
}
function normalizePaths(paths, workdir = cwd) {
  const result = [];
  for (let p of paths) {
    p = p.trim(); if (!p) continue;
    p = resolve(workdir, p);
    if (/^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr)$/.test(p) || /^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/.test(p)) continue;
    result.push(p);
  }
  return [...new Set(result)].slice(0, 32);
}
try {
  if (event === "SessionStart" || event === "UserPromptSubmit") await reportActivity(event, { outcome: "fired", sessionId, harness });
  if (event === "SessionStart") {
    const q = new URLSearchParams({ harness, sessionId, cwd, touch: "1", consume: "1" });
    const data = await fetchJson(`${endpoint}/api/coordination/context?${q}`);
    output(event, data.context || undefined);
    if (data.inboxIds?.length) await fetchJson(`${endpoint}/api/coordination/inbox-ack`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,ids:data.inboxIds})});
  } else if (event === "UserPromptSubmit") {
    const inputId = typeof input.input_id === "string" ? input.input_id
      : typeof input.inputId === "string" ? input.inputId
        : typeof input.metadata?.inputId === "string" ? input.metadata.inputId : undefined;
    const nativeTurnId = typeof input.turn_id === "string" ? input.turn_id
      : typeof input.turnId === "string" ? input.turnId : undefined;
    const promptId = typeof input.prompt_id === "string" ? input.prompt_id
      : typeof input.promptId === "string" ? input.promptId
        : inputId || nativeTurnId || `user-prompt-${randomUUID()}`;
    await fetchJson(`${endpoint}/api/coordination/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness, sessionId, cwd, event: "user-prompt", promptId, ...(nativeTurnId ? { turnId: nativeTurnId } : {}), ...(typeof input.prompt === "string" ? { text: input.prompt } : {}), at: new Date().toISOString(), ...(inputId ? { inputId } : {}) }),
    });
    const q = new URLSearchParams({ harness, sessionId, cwd, touch: "1", consume: "1" });
    const data = await fetchJson(`${endpoint}/api/coordination/context?${q}`);
    output(event, data.context || undefined);
    if (data.inboxIds?.length) await fetchJson(`${endpoint}/api/coordination/inbox-ack`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,ids:data.inboxIds})});
  } else if (event === "PreToolUse" || event === "PostToolUse") {
    if(harness==='zcode'){
      const turnId=typeof input.turn_id==='string'?input.turn_id:typeof input.turnId==='string'?input.turnId:undefined;
      if(turnId)await fetchJson(`${endpoint}/api/coordination/lifecycle`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({harness,sessionId,cwd,event:'tool-progress',turnId,phase:event})}).catch(()=>undefined);
    }
    input.tool_input ??= input.toolInput;
    input.tool_name ??= input.toolName;
    const declaredWorkdir = input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input.workdir || input.tool_input.cwd || input.tool_input.directory : undefined;
    const literalWorkdir = stringCommand(input.tool_input).match(/(?:workdir|cwd|directory)["']?\s*:\s*(["'])(\/[^"'\n]+)\1/)?.[2];
    const observedWorkdir = declaredWorkdir || literalWorkdir;
    const workdir = typeof observedWorkdir === "string" && isAbsolute(observedWorkdir) ? resolve(observedWorkdir) : cwd;
    const paths = isWriteActivity(input.tool_name, input.tool_input) ? normalizePaths(collectPaths(input.tool_input), workdir) : [];
    const data = await fetchJson(`${endpoint}/api/coordination/activity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness, sessionId, cwd: workdir, launchCwd: cwd, paths, hook: event }) });
    const activeTurnId=typeof input.turn_id==='string'?input.turn_id:typeof input.turnId==='string'?input.turnId:undefined;
    const current=harness==='zcode'&&activeTurnId?await fetchJson(`${endpoint}/api/coordination/context?${new URLSearchParams({harness,sessionId,cwd,activeTurnId,consumeActive:'1'})}`):null;
    const combined = [data.context,current?.activeInboxContext].filter(Boolean).join('\n\n');
    // The prohibition content travels only while the prohibitions of this
    // hook are on; the rest of the context is still useful.
    const context = prohibition.enabled ? (combined || undefined) : (withoutProhibitions(combined) || undefined);
    output(event,context);
    if (prohibition.enabled && combined.includes("<agent-herder-path-conflict>")) {
      // The hook refused the tool call: the panel shows the refusal.
      await reportActivity(event, { outcome: "refused", reason: "вызов инструмента получил конфликт по путям: другой агент недавно работал с тем же файлом", sessionId, harness });
    }
    if(current?.activeInboxIds?.length)await fetchJson(`${endpoint}/api/coordination/inbox-ack`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,ids:current.activeInboxIds})});
    if (data.inboxIds?.length) await fetchJson(`${endpoint}/api/coordination/inbox-ack`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,ids:data.inboxIds})});
  }
} catch { process.exit(0); }
