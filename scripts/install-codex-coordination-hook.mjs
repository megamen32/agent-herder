#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return "Usage: node scripts/install-codex-coordination-hook.mjs [--hooks-file PATH]";
}

function parseHooksPath(args) {
  if (args.length === 0) return join(homedir(), ".codex", "hooks.json");
  if (args.length !== 2 || args[0] !== "--hooks-file" || !args[1]) throw new Error(usage());
  return resolve(args[1]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config) {
  if (!isRecord(config)) throw new Error("Codex hooks config must be a JSON object");
  if (config.hooks === undefined) config.hooks = {};
  if (!isRecord(config.hooks)) throw new Error("Codex hooks config field 'hooks' must be an object");
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (event === "enabled") continue;
    if (!Array.isArray(entries)) throw new Error(`Codex hooks event '${event}' must be an array`);
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)
        || entry.hooks.some((hook) => !isRecord(hook) || typeof hook.type !== "string"
          || (hook.type === "command" && typeof hook.command !== "string"))) {
        throw new Error(`Codex hooks event '${event}' contains a malformed entry`);
      }
    }
  }
  if (config.hooks.UserPromptSubmit === undefined) config.hooks.UserPromptSubmit = [];
  return config;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function coordinationHookCommand(scriptPath) {
  return [
    "AGENT_HERDER_HARNESS=codex systemd-run --user --quiet --scope",
    "-p MemoryHigh=128M",
    "-p MemoryMax=256M",
    "-p MemorySwapMax=0",
    "-p CPUQuota=100%",
    "-p TasksMax=32",
    "-p IOWeight=10",
    "-p RuntimeMaxSec=5s",
    shellQuote(process.execPath),
    shellQuote(scriptPath),
  ].join(" ");
}

async function readConfig(path) {
  let bytes;
  let mode = 0o600;
  try {
    bytes = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { config: validateConfig({}), mode, exists: false };
  }
  let config;
  try { config = JSON.parse(bytes); }
  catch (error) { throw new Error(`Cannot parse ${path}: ${error.message}`); }
  return { config: validateConfig(config), mode, exists: true };
}

async function writeAtomic(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (process.platform !== "linux") throw new Error("This bounded installer requires Linux user systemd");
  const hooksPath = parseHooksPath(process.argv.slice(2));
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "coordination-hook.mjs");
  const { config, mode, exists } = await readConfig(hooksPath);
  const command = coordinationHookCommand(scriptPath);
  const registrations = config.hooks.UserPromptSubmit;
  const alreadyInstalled = registrations.some((entry) => entry.hooks.some((hook) => hook.command === command));
  if (!alreadyInstalled) {
    registrations.push({ hooks: [{ type: "command", command, timeout: 3 }] });
    await writeAtomic(hooksPath, `${JSON.stringify(config, null, 2)}\n`, mode);
  } else if (!exists) {
    throw new Error("Internal error: absent config cannot already contain the coordination hook");
  }
  process.stdout.write(`Installed Agent Herder UserPromptSubmit callback in ${hooksPath}.\n/hooks review only this callback\n`);
}

main().catch((error) => {
  process.stderr.write(`Codex coordination hook install failed: ${error.message}\n`);
  process.exitCode = 1;
});
