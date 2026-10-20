#!/usr/bin/env bash
# Publish the MiniMax Code desktop runtime transport for the fleet node.
#
# The desktop app hosts its sessions in a runtime that lives inside its own
# process tree: the renderer talks to it over a MessagePort. With the
# diagnostic sidecar enabled, the app publishes that same runtime on loopback
# HTTP and writes a manifest, so an external controller can steer, queue and
# abort the very sessions the app is showing.
#
# The flag is read once at start-up, so the app has to be launched after the
# environment is set. The transport is unauthenticated and bound to loopback:
# every local process can use it while the app runs.
set -euo pipefail

MANIFEST="${MINIMAX_CODE_CONTROL_MANIFEST:-$HOME/.minimax/run/mcode-diagnostic.json}"
PORT="${MINIMAX_CODE_CONTROL_PORT:-18791}"

/bin/launchctl setenv MAVIS_ELECTRON_ENABLE_DIAGNOSTIC_SIDECAR 1
/bin/launchctl setenv MAVIS_ELECTRON_DIAGNOSTIC_MANIFEST "$MANIFEST"
/bin/launchctl setenv MAVIS_ELECTRON_DIAGNOSTIC_PORT "$PORT"

mkdir -p "$(dirname "$MANIFEST")"

echo "diagnostic sidecar enabled"
echo "  manifest: $MANIFEST"
echo "  port:     $PORT"
echo "restart the app to publish the transport:"
echo "  osascript -e 'quit app \"MiniMax Code\"' && open -a 'MiniMax Code'"
