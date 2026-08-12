#!/usr/bin/env bash
set -eu

action=${1:-on}
case "$action" in
  on|status|off) ;;
  *) echo "Использование: /autopilot [on|status|off]"; exit 2 ;;
esac

if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  harness=claude
  session_id=$CLAUDE_CODE_SESSION_ID
  harness_label="Claude Code"
else
  harness=codex
  session_id=${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}
  harness_label=Codex
fi
if [ -z "$session_id" ]; then
  echo "Harness не передал ID текущей сессии." >&2
  exit 1
fi

plugin_root=${PLUGIN_ROOT:-}
if [ -z "$plugin_root" ]; then
  plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
fi

payload=$(/usr/bin/jq -nc \
  --arg command "$action" \
  --arg harness "$harness" \
  --arg sessionId "$session_id" \
  --arg cwd "$PWD" \
  '{command:$command,harness:$harness,sessionId:$sessionId,cwd:$cwd}')
result=$(PLUGIN_ROOT="$plugin_root" bash "$plugin_root/scripts/autopilot-command-launcher.sh" "$payload")
enabled=$(printf '%s' "$result" | /usr/bin/jq -r '.enabled')
case "$action" in
  on) echo "Autopilot включён для текущей ${harness_label}-сессии ($session_id)." ;;
  off) echo "Autopilot выключен для текущей ${harness_label}-сессии ($session_id)." ;;
  status)
    if [ "$enabled" = true ]; then
      echo "Autopilot включён для текущей ${harness_label}-сессии ($session_id)."
    else
      echo "Autopilot выключен для текущей ${harness_label}-сессии ($session_id)."
    fi
    ;;
esac
