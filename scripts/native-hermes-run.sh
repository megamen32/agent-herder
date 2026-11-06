#!/bin/sh
# Run on server-44 with the dedicated runtime and fixture staged at $1.
set -eu
case "${1:-}" in /*) stage=$1 ;; *) echo 'absolute stage path required' >&2; exit 2;; esac
export stage
exec unshare -Urn sh -c '
  set -eu
  ip link set lo up
  exec bwrap --clearenv --setenv PATH /usr/bin:/bin --die-with-parent \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --ro-bind "$stage/runtime" /home/roomhacker/.hermes/hermes-agent \
    --ro-bind "$stage/python" /home/roomhacker/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu \
    --symlink cpython-3.11.15-linux-x86_64-gnu /home/roomhacker/.local/share/uv/python/cpython-3.11-linux-x86_64-gnu \
    --ro-bind "$stage" /fixture --tmpfs /work --proc /proc --dev /dev --chdir /work \
    /usr/bin/python3 /fixture/native-hermes-canary.py
'
