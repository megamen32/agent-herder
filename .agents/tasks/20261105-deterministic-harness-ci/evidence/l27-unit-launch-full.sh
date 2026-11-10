#!/bin/sh
set -eu
root=/dev/shm/herder-l27-codex-8OyaY6sZ
ip link set lo up
exec bwrap --unshare-pid --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --dir /etc --ro-bind "$root/stage/passwd" /etc/passwd --tmpfs /tmp --proc /proc --dev /dev --dir /dev/shm --dir "$root" --ro-bind "$root/stage" "$root/stage" --bind "$root/stage/full/shared" "$root/stage/full/shared" --ro-bind "$root/full-release" "$root/full-release" --ro-bind "$root" /opt /usr/bin/python3 "$root/stage/unit-wrapper-full.py"
