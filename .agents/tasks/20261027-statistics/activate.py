"""Activate the exact canonical statistics release and preserve runtime policy."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parents[3]
task = root / ".tmp/statistics-20261027"
sha = json.loads((task / "source.json").read_text())["source_sha"]
release = root.parent / ".notice-herder-release-20261027/releases" / sha
manifest = json.loads((release / "dist/fleet-deployment-manifest.json").read_text())
if manifest["source_sha"] != sha or manifest["source_dirty"]:
    raise SystemExit("Exact clean compiler inputs not confirmed")

def read(path):
    with urllib.request.urlopen("http://127.0.0.1:18787" + path, timeout=15) as response:
        return json.load(response), response.headers.get("ETag")

policy, etag = read("/api/automation/launch-policy")
settings, _ = read("/api/session-autostart")
events, _ = read("/api/events?limit=1")
snapshot = Path.home() / ".local/state/agent-herder/events.json"
persisted_sequence = json.loads(snapshot.read_text())["latestSequence"]
journal = Path(str(snapshot) + ".journal")
if journal.exists():
    for line in journal.read_text().splitlines():
        try:
            persisted_sequence = max(persisted_sequence, int(json.loads(line)["sequence"]))
        except (ValueError, KeyError, TypeError):
            pass
unit = Path.home() / ".config/systemd/user/agent-herder.service.d/10-release-exec.conf"
backup = task / f"release-exec.before-{sha[:12]}"
if backup.exists():
    raise SystemExit("Activation already attempted: inspect receipt, do not replay")
shutil.copy2(unit, backup)
temporary = unit.with_suffix(".switch-tmp")
temporary.write_text(f"# Canonical statistics release.\n[Service]\nExecStart=\nExecStart=/usr/local/bin/node {release}/dist/index.js\n")
os.replace(temporary, unit)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "restart", "agent-herder.service"], check=True)
for _ in range(40):
    try:
        after, after_etag = read("/api/automation/launch-policy")
        break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit("Readiness failed: inspect without replay")
if after != policy or after_etag != etag:
    raise SystemExit("Policy changed during activation; do not overwrite")
after_settings, _ = read("/api/session-autostart")
if after_settings != settings:
    raise SystemExit("Settings changed during activation; inspect without overwrite")
after_events, _ = read("/api/events?limit=1")
if after_events["latestSequence"] < persisted_sequence:
    raise SystemExit("Persisted event sequence was not restored")
pid = int(subprocess.check_output(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"], text=True))
entrypoint = str(release / "dist/index.js")
if entrypoint not in Path("/proc", str(pid), "cmdline").read_bytes().decode().split("\0"):
    raise SystemExit("Process source entrypoint mismatch")
receipt = {"source_sha": sha, "pid": pid, "entrypoint": entrypoint,
           "policy_etag": etag, "policy_preserved": True, "settings_preserved": True,
           "settings_sha256": hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest(),
           "persisted_sequence_before": persisted_sequence,
           "live_sequence_before": events["latestSequence"],
           "live_sequence_after": after_events["latestSequence"]}
(task / "activation.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
