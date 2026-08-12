#!/usr/bin/env bash
set -eu

set -a
if [ -f "${HOME}/.omniroute/.env" ]; then
  . "${HOME}/.omniroute/.env"
fi
if [ -f "${HOME}/.config/notify/opencode.env" ]; then
  . "${HOME}/.config/notify/opencode.env"
fi
set +a

plugin_root=${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}
if [ -z "$plugin_root" ]; then
  plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fi

export AGENT_HERDER_AUTOPILOT_STATE_DIR=${AGENT_HERDER_AUTOPILOT_STATE_DIR:-"${HOME}/.local/state/agent-herder/autopilot-live"}
export AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL=${AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL:-http://127.0.0.1:20128/v1}
export AGENT_HERDER_AUTOPILOT_JUDGE_MODEL=${AGENT_HERDER_AUTOPILOT_JUDGE_MODEL:-MiniMax-M3}
export AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN=${AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN:-${OMNIROUTE_API_KEY:-}}
export AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT=${AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT:-${NOTIFY_CENTER_PROJECT:-agent-herder}}
export AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT=${AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT:-${NOTIFY_CENTER_RECIPIENT:-}}

node_bin=${AGENT_HERDER_NODE_BIN:-/usr/local/bin/node}
if [ ! -x "$node_bin" ]; then
  node_bin=$(command -v node)
fi

exec "$node_bin" "${plugin_root}/dist/claude-autopilot-hook.js"
