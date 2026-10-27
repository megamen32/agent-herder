"""Install the one reviewed direct-MCP OAuth release exactly once."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
TASK = Path(__file__).resolve().parent
SHA = "f35713f249bddbfceee4ad1ea30604e47586de08"
CATALOG = ROOT.parent / ".notice-herder-release-20261027"
RELEASE = CATALOG / "releases" / SHA
UNIT = Path.home() / ".config/systemd/user/agent-herder.service.d/10-release-exec.conf"
ATTEMPT = TASK / "activation-attempt.json"
RECEIPT = TASK / "activation.json"


def call(args: list[str]) -> str:
    return subprocess.check_output(args, text=True).strip()


def read_json(path: str) -> tuple[dict, str | None]:
    request = urllib.request.Request("http://127.0.0.1:18787" + path, headers={"Host": "agent.bezrabotnyi.com"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response), response.headers.get("ETag")


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


if ATTEMPT.exists() or RECEIPT.exists():
    raise SystemExit("activation already attempted; inspect its receipt and do not replay")
manifest = json.loads((RELEASE / "dist/fleet-deployment-manifest.json").read_text())
bundle = json.loads((RELEASE / "build-manifest.json").read_text())
if manifest.get("source_sha") != SHA or manifest.get("source_dirty") is not False:
    raise SystemExit("release source identity is not exact and clean")
if bundle.get("sourceSha") != SHA:
    raise SystemExit("bundle source identity mismatch")
if os.readlink(CATALOG / "current") != f"releases/{SHA}":
    raise SystemExit("candidate catalog does not point at the reviewed release")
if call(["systemctl", "--user", "show", "agent-herder.service", "-p", "ActiveState", "--value"]) != "active":
    raise SystemExit("service is not active; no install attempted")
old_pid = int(call(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"]))
old_start = call(["systemctl", "--user", "show", "agent-herder.service", "-p", "ExecStart", "--value"])
old_entrypoint = f"{CATALOG}/releases/"
if old_entrypoint not in old_start or SHA in old_start:
    raise SystemExit("live ExecStart is not the expected immutable prior release")
if not UNIT.is_file() or old_entrypoint not in UNIT.read_text():
    raise SystemExit("release drop-in does not identify the current immutable release")

policy, policy_etag = read_json("/api/automation/launch-policy")
settings, _ = read_json("/api/session-autostart")
events, _ = read_json("/api/events?limit=1")
event_file = Path.home() / ".local/state/agent-herder/events.json"
persisted_sequence = int(json.loads(event_file.read_text())["latestSequence"])
journal = event_file.with_name(event_file.name + ".journal")
if journal.exists():
    for line in journal.read_text().splitlines():
        try:
            persisted_sequence = max(persisted_sequence, int(json.loads(line)["sequence"]))
        except (ValueError, KeyError, TypeError):
            continue

snapshot = {
    "source_sha": SHA,
    "pre_pid": old_pid,
    "pre_execstart_sha256": hashlib.sha256(old_start.encode()).hexdigest(),
    "policy_etag": policy_etag,
    "policy_sha256": digest(policy),
    "settings_sha256": digest(settings),
    "persisted_event_sequence": persisted_sequence,
    "live_event_sequence": events["latestSequence"],
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
}
# This exclusive marker is written before the one allowed service restart.
with ATTEMPT.open("x") as stream:
    stream.write(json.dumps(snapshot, indent=2) + "\n")
os.chmod(ATTEMPT, 0o600)
backup = TASK / "release-exec.before.conf"
shutil.copy2(UNIT, backup)
temporary = UNIT.with_suffix(f".switch-{os.getpid()}")
temporary.write_text(
    "# Direct ChatGPT MCP OAuth release.\n[Service]\nExecStart=\n"
    f"ExecStart=/usr/local/bin/node {RELEASE}/dist/index.js\n"
)
os.chmod(temporary, UNIT.stat().st_mode & 0o777)
os.replace(temporary, UNIT)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "restart", "agent-herder.service"], check=True)

for _ in range(40):
    try:
        policy_after, etag_after = read_json("/api/automation/launch-policy")
        break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit("readiness failed; inspect state and do not replay activation")
settings_after, _ = read_json("/api/session-autostart")
events_after, _ = read_json("/api/events?limit=1")
if digest(policy_after) != snapshot["policy_sha256"] or etag_after != policy_etag:
    raise SystemExit("launch policy changed across install")
if digest(settings_after) != snapshot["settings_sha256"]:
    raise SystemExit("session autostart settings changed across install")
if int(events_after["latestSequence"]) < persisted_sequence:
    raise SystemExit("durable event sequence regressed")
pid = int(call(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"]))
entrypoint = str(RELEASE / "dist/index.js")
if entrypoint not in Path("/proc", str(pid), "cmdline").read_bytes().decode().split("\0"):
    raise SystemExit("running process entrypoint does not match reviewed release")
prm, _ = read_json("/.well-known/oauth-protected-resource/mcp")
as_metadata, _ = read_json("/.well-known/oauth-authorization-server")
if prm.get("resource") != "https://agent.bezrabotnyi.com/mcp" or as_metadata.get("issuer") != "https://agent.bezrabotnyi.com":
    raise SystemExit("installed OAuth metadata identity mismatch")

atomic_json(RECEIPT, {
    **snapshot,
    "pid": pid,
    "entrypoint": entrypoint,
    "policy_preserved": True,
    "settings_preserved": True,
    "event_sequence_after": events_after["latestSequence"],
    "oauth_metadata_readback": "passed through direct app endpoint",
    "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
})
print(json.dumps({"source_sha": SHA, "pid": pid, "entrypoint": entrypoint,
                  "policy_preserved": True, "settings_preserved": True,
                  "event_sequence_after": events_after["latestSequence"],
                  "receipt": str(RECEIPT)}))
