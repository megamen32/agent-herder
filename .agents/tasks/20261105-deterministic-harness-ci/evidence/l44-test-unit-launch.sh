#!/bin/sh
set -eu
ip link set lo up
candidate=/tmp/herder-l42-search-U2ePQ0/candidate
stage=/tmp/herder-l42-search-U2ePQ0
exec bwrap --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --dir /etc --ro-bind "$stage/passwd" /etc/passwd --tmpfs /tmp --dir /tmp/herder-l42-search-U2ePQ0 --ro-bind "$candidate" "$candidate" --tmpfs /work --proc /proc --dev /dev --chdir /work --clearenv --setenv HOME /work --setenv PATH /usr/bin:/bin --setenv AGENT_HERDER_WEB_HOST 127.0.0.1 --setenv AGENT_HERDER_WEB_PORT 23917 --setenv AGENT_HERDER_WORKLOAD_ISOLATION off --setenv AGENT_HERDER_SINGLETON_LOCK /work/unit.lock --setenv AGENT_HERDER_FLEET_PEERS "[{\"hostId\":\"$(hostname)\",\"sshHost\":\"127.0.0.1\",\"nativeUser\":\"root\",\"port\":1,\"python\":\"/usr/bin/python3\"}]" --setenv ENABLE_CODEX false --setenv ENABLE_OPENCODE false --setenv ENABLE_CLAUDE false --setenv ENABLE_QODER false --setenv ENABLE_HERMES false --setenv ENABLE_ZCODE false --setenv ENABLE_MINIMAX_CODE false --setenv ENABLE_FAST_AGENT false /usr/bin/node "$candidate/dist/index.js"
