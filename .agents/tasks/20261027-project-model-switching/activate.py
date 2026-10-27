"""Activate the pinned canonical release; preserve all current live policies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parents[3]
task = root / ".tmp/project-model-switching-20261027"
source = json.loads((task / "source.json").read_text())
sha = source["source_sha"]
release = root.parent / ".notice-herder-release-20261027/releases" / sha
manifest = json.loads((release / "dist/fleet-deployment-manifest.json").read_text())
if manifest["source_sha"] != sha or manifest["source_dirty"]:
    raise SystemExit("Exact clean source not confirmed")
url = "http://127.0.0.1:18787/api/automation/launch-policy"
with urllib.request.urlopen(url, timeout=10) as response:
    before = json.load(response)
    etag = response.headers["ETag"]
unit = Path.home() / ".config/systemd/user/agent-herder.service.d/10-release-exec.conf"
backup = task / f"release-exec.before-{sha[:12]}"
if backup.exists():
    raise SystemExit("Activation already attempted: read receipt instead of repeating")
shutil.copy2(unit, backup)
temporary = unit.with_suffix(".switch-tmp")
temporary.write_text(f"# Project model switching: pinned canonical build.\n[Service]\nExecStart=\nExecStart=/usr/local/bin/node {release}/dist/index.js\n")
os.replace(temporary, unit)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "restart", "agent-herder.service"], check=True)
for attempt in range(40):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            after = json.load(response)
            after_etag = response.headers["ETag"]
        break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit("Readiness failed; inspect activation without replay")
if before != after or etag != after_etag:
    raise SystemExit("Live policy changed during activation: inspect without overwriting")
pid = subprocess.check_output(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"], text=True).strip()
if str(release / "dist/index.js") not in Path("/proc", pid, "cmdline").read_bytes().decode().split("\0"):
    raise SystemExit("Process entrypoint mismatch")
receipt = {"source_sha": sha, "pid": int(pid), "entrypoint": str(release / "dist/index.js"), "policy_etag": etag, "incident_execution": after["incidentExecution"], "policy_preserved": True}
(task / "activation.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
