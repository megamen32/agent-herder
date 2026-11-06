#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
venv=/home/roomhacker/.local/share/uv/tools-fast-agent-0.10.43/fast-agent-mcp
python=/home/roomhacker/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu
export repo venv python
exec unshare -Urn sh -c '
 set -eu
 ip link set lo up
 exec bwrap --clearenv --die-with-parent --unshare-pid --unshare-ipc --unshare-uts \
  --ro-bind /usr /usr --ro-bind /usr/local /usr/local --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind "$venv" "$venv" --ro-bind "$python" "$python" \
  --ro-bind "$repo/dist" /app/dist --ro-bind "$repo/node_modules" /app/node_modules \
  --ro-bind "$repo/package.json" /app/package.json --ro-bind "$repo/scripts/native-fast-agent-adapter.mjs" /adapter.mjs \
  --tmpfs /work --tmpfs /tmp --proc /proc --dev /dev --chdir /work \
  --setenv HOME /work --setenv PATH /usr/bin:/bin --setenv OPENAI_API_KEY test-only \
  --setenv AGENT_HERDER_WORKLOAD_ISOLATION off --setenv TEST_FAST_AGENT_BIN "$venv/bin/fast-agent" \
  --setenv TEST_FAST_AGENT_VERSION "$("$venv/bin/fast-agent" --version)" /usr/local/bin/node /adapter.mjs
'
