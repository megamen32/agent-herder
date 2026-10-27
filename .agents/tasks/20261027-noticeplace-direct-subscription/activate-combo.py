"""Activate the exact built combo release and update only incident routes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[3]
task = root / ".tmp/notice-direct-20261027"
sha = json.loads((task / "combo-source-receipt.json").read_text())["source_sha"]
release = root.parent / ".notice-herder-release-20261027/releases" / sha
manifest = json.loads((release / "dist/fleet-deployment-manifest.json").read_text())
if manifest["source_sha"] != sha or manifest["source_dirty"]:
    raise SystemExit("Exact clean compiler inputs not confirmed")
url = "http://127.0.0.1:18787/api/automation/launch-policy"
policy_only = "--policy-only" in sys.argv
try:
    with urllib.request.urlopen(url, timeout=10) as response:
        before = json.load(response)
        etag = response.headers["ETag"]
except urllib.error.HTTPError as error:
    if not policy_only or error.code != 503 or not error.headers.get("ETag"):
        raise
    etag = error.headers["ETag"]
    pid = subprocess.check_output(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"], text=True).strip()
    env = dict(x.split("=", 1) for x in Path("/proc", pid, "environ").read_bytes().decode().split("\0") if "=" in x)
    before = json.loads((Path(env["AGENT_HERDER_AUTOPILOT_STATE_DIR"]) / "automation-launch-policy.json").read_text())
policy = before.get("policy", before)
model = "omniroute/glm-5.3-flash-minimax-m3.1"
policy["incidentExecution"] = {"runtime": "opencode", "provider": "omniroute", "model": model, "reasoning": "default", "topic": "health"}
for path in (str(root.parent / "noticeplace"), str(task / "fixture")):
    if path not in policy.get("projectRoutes", {}):
        raise SystemExit("Expected existing incident route is absent")
    route = policy["projectRoutes"][path]
    route.update(harnesses=["opencode"], models={"opencode": model}, allowedModels=[model])
unit = Path.home() / ".config/systemd/user/agent-herder.service.d/10-release-exec.conf"
backup = task / "release-exec.before-combo"
if backup.exists() and not policy_only:
    raise SystemExit("Activation already attempted; read receipt instead of repeating")
if not policy_only:
    shutil.copy2(unit, backup)
    temporary = unit.with_suffix(".combo-tmp")
    temporary.write_text(f"# Owner-selected GLM + MiniMax combo release.\n[Service]\nExecStart=\nExecStart=/usr/local/bin/node {release}/dist/index.js\n")
    os.replace(temporary, unit)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "restart", "agent-herder.service"], check=True)
    for attempt in range(30):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                break
        except urllib.error.HTTPError as error:
            if error.code == 503 and error.headers.get("ETag"):
                break
            raise
        except OSError:
            time.sleep(1)
    else:
        raise SystemExit("Herder readiness failed; preserve activation state")
request = urllib.request.Request(url, data=json.dumps(policy).encode(), method="PUT", headers={"Content-Type": "application/json", "If-Match": etag})
with urllib.request.urlopen(request, timeout=10) as response:
    saved = json.load(response)
with urllib.request.urlopen(url, timeout=10) as response:
    readback = json.load(response)
    final_etag = response.headers["ETag"]
observed = readback.get("policy", readback)
if observed["incidentExecution"] != policy["incidentExecution"]:
    raise SystemExit("Independent policy readback mismatch")
pid = subprocess.check_output(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"], text=True).strip()
argv = Path("/proc", pid, "cmdline").read_bytes().decode().split("\0")
if str(release / "dist/index.js") not in argv:
    raise SystemExit("Independent process entrypoint mismatch")
receipt = {"source_sha": sha, "pid": int(pid), "entrypoint": str(release / "dist/index.js"), "etag": final_etag, "incidentExecution": observed["incidentExecution"]}
(task / "combo-activation.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
