#!/usr/bin/env bash
set -eu

action=${1:-on}
case "$action" in
  on|status|off) ;;
  *) echo "Использование: /autopilot [on|status|off]"; exit 2 ;;
esac

session_id=${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}
if [ -z "$session_id" ]; then
  echo "Codex не передал ID текущей сессии." >&2
  exit 1
fi

plugin_root=${PLUGIN_ROOT:-}
if [ -z "$plugin_root" ]; then
  plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
fi

payload=$(printf '{"command":"%s","harness":"codex","sessionId":"%s","cwd":"%s"}' \
  "$action" "$session_id" "${PWD//\"/\\\"}")
result=$(PLUGIN_ROOT="$plugin_root" bash "$plugin_root/scripts/autopilot-command-launcher.sh" "$payload")
enabled=$(printf '%s' "$result" | /usr/bin/jq -r '.enabled')
case "$action" in
  on) echo "Autopilot включён для текущей Codex-сессии ($session_id)." ;;
  off) echo "Autopilot выключен для текущей Codex-сессии ($session_id)." ;;
  status)
    if [ "$enabled" = true ]; then
      echo "Autopilot включён для текущей Codex-сессии ($session_id)."
    else
      echo "Autopilot выключен для текущей Codex-сессии ($session_id)."
    fi
    ;;
esac
