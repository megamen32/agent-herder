#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
plugin="$root/integrations/zcode/agent-herder-autopilot"
config="${HOME}/.zcode/cli/config.json"
command_dir="${HOME}/.zcode/commands"

if [ ! -f "$plugin/.zcode-plugin/plugin.json" ]; then
  echo "Agent Herder ZCode plugin is missing: $plugin" >&2
  exit 1
fi

node - "$config" "$plugin" <<'NODE'
const fs = require("fs");
const path = require("path");
const [configPath, plugin] = process.argv.slice(2);
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
config.hooks ||= {};
config.hooks.enabled = true;
config.hooks.events ||= {};
const add = (event, hook) => {
  const entries = config.hooks.events[event] ||= [];
  if (!entries.some((entry) => JSON.stringify(entry).includes(hook.args[0]))) {
    entries.push({ matcher: ".*", hooks: [hook] });
  }
};
add("UserPromptSubmit", { type: "process", command: "node", args: [path.join(plugin, "hooks/user-prompt.mjs")], enabled: true, timeoutMs: 5000 });
add("Stop", { type: "process", command: "node", args: [path.join(plugin, "hooks/stop.mjs")], enabled: true, timeoutMs: 604800000, statusMessage: "Agent Herder: evaluating the next step…" });
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const temporary = `${configPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, configPath);
NODE

mkdir -p "$command_dir"
ln -sfn "$plugin/commands/autopilot.md" "$command_dir/autopilot.md"
echo "Installed Agent Herder ZCode hooks and /autopilot. Open a new ZCode session to load them."
