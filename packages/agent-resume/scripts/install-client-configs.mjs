#!/usr/bin/env node
/**
 * Install the standalone Agent Resume into harness MCP configurations.
 *
 * The tool it registers is the same build Agent Herder runs against, so an
 * operator and Herder can never answer "which Agent Resume is this?" with two
 * different ones. The installer only edits the named entry inside `mcp` /
 * `mcpServers`; it never rewrites the rest of a configuration file.
 *
 * Usage:
 *   node scripts/install-client-configs.mjs [--agent opencode|claude|codex|all]
 *                                            [--package <spec>] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { upsertMember } from "./jsonc-upsert.mjs";

const DEFAULT_PACKAGE = "github:megamen32/agent-herder";
const SUPPORTED = new Set(["opencode", "claude", "codex"]);

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function installOpenCode(path, agent, packageSpec, dryRun) {
  const entry = `"agent-resume": {\n  "type": "local",\n  "command": ["npx", "-y", ${JSON.stringify(packageSpec)}],\n  "enabled": true,\n  "environment": { "AGENT_RESUME_AGENT": ${JSON.stringify(agent)} }\n}`;
  if (!existsSync(path)) {
    const created = `{\n  "mcp": {\n    ${entry.split("\n").join("\n    ")}\n  }\n}\n`;
    if (!dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, created); }
    return { client: "opencode", path, changed: true, action: "created" };
  }
  const before = readFileSync(path, "utf8");
  const after = upsertMember(before, "mcp", "agent-resume", entry);
  if (!after) throw new Error(`cannot locate the "mcp" object in ${path}`);
  if (after !== before && !dryRun) writeFileSync(path, after);
  return { client: "opencode", path, changed: after !== before, action: after === before ? "unchanged" : "updated" };
}

function installJsonMcp(path, key, agent, packageSpec, dryRun) {
  const entry = {
    type: "stdio",
    command: "npx",
    args: ["-y", packageSpec],
    env: { AGENT_RESUME_AGENT: agent },
  };
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  let data;
  try { data = before ? JSON.parse(before) : {}; }
  catch (error) { throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  data[key] = data[key] ?? {};
  const previous = JSON.stringify(data[key]["agent-resume"] ?? null);
  data[key]["agent-resume"] = entry;
  const after = `${JSON.stringify(data, null, 2)}\n`;
  if (after !== before && !dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, after); }
  return { client: agent, path, changed: after !== before, action: after === before ? "unchanged" : "updated", replaced: previous !== "null" };
}

const home = homedir();
const packageSpec = flag("package", DEFAULT_PACKAGE);
const dryRun = has("dry-run");
const requested = flag("agent", "all").toLowerCase();
const agents = requested === "all" ? [...SUPPORTED] : [requested];
for (const agent of agents) {
  if (!SUPPORTED.has(agent)) throw new Error(`unsupported agent: ${agent}`);
}

const results = [];
for (const agent of agents) {
  if (agent === "opencode") results.push(installOpenCode(join(home, ".config/opencode/opencode.json"), agent, packageSpec, dryRun));
  if (agent === "claude") results.push(installJsonMcp(join(home, ".claude.json"), "mcpServers", agent, packageSpec, dryRun));
  if (agent === "codex") results.push(installJsonMcp(join(home, ".codex/config.toml.json"), "mcpServers", agent, packageSpec, dryRun));
}
process.stdout.write(`${JSON.stringify({ ok: true, dryRun, package: packageSpec, results }, null, 2)}\n`);