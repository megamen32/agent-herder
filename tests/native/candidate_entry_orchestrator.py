"""Rebuild and verify a staged native candidate against a live Chrome fixture.

The fixture is a test stand: it serves the provider document and its API
responses from a local HTTPS origin. The candidate is rebuilt with the exact
CDP binding this fixture publishes, staged into the isolated QA namespace and
exercised as an ordinary MCP client. Nothing here touches a real account.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NODE = Path("/home/roomhacker/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs")
FIXTURE = REPO / "tests/native/browser_adapter_fixture.mjs"
RUN = Path("/srv/storage/builds/herder/ci-runs/rust-browser-mesh-rollout-bRJcQC")
QA = RUN / "candidate-qa"
ENTRY = QA / "entry"
CANDIDATE = RUN / "candidate-entry-95efa8bd"
WORK = Path(f"/tmp/opencode/candidate-entry-{os.getpid()}")
ORIGIN_PORT = "9222"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def start_fixture(kind: str, evidence: Path):
    evidence.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PLAYWRIGHT_MODULE"] = str(NODE)
    env.pop("NODE_OPTIONS", None)
    process = subprocess.Popen(
        ["node", str(FIXTURE), kind, ORIGIN_PORT, str(evidence)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env, cwd=str(evidence),
    )
    assert process.stdin and process.stdout
    process.stdin.write(json.dumps({"id": 1, "method": "setup"}) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    assert line, process.stderr.read()
    payload = json.loads(line)
    result = payload.get("result") or {}
    assert result.get("env"), payload
    return result, process


def write_binding(kind: str, env: dict, previous: Path, target: Path) -> str:
    binding = {
        "kind": kind,
        "profile_sha256": sha256(previous),
        "ahap_env": env,
    }
    target.write_text(json.dumps(binding, indent=2, sort_keys=True) + "\n")
    os.chmod(target, 0o600)
    return sha256(target)


def main() -> int:
    os.umask(0o077)
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    processes = []
    bindings = {}
    try:
        for kind in ("chatgpt", "zai"):
            result, process = start_fixture(kind, WORK / "evidence" / kind)
            processes.append((kind, process))
            previous = QA / "profiles" / kind / "herder-owner-home" / "authority" / "previous-profile.json"
            pin = WORK / f"{kind}-reviewed-binding.json"
            digest = write_binding(kind, result["env"], previous, pin)
            bindings[kind] = {"path": str(pin), "sha256": digest}
            print(kind, "fixture binding", digest, flush=True)

        if CANDIDATE.exists():
            shutil.rmtree(CANDIDATE)
        (QA / "runtime" / "executions").mkdir(parents=True, exist_ok=True)
        (QA / "runtime" / "resources").mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable, str(REPO / "deploy/fleet/process-leases-candidate.py"), "build",
            "--repo", str(REPO),
            "--selector", str(QA / "baseline" / "selector.json"),
            "--output", str(CANDIDATE),
            "--build-dir", str(REPO / "crates/herder/target"),
            "--cargo", "/home/roomhacker/.cargo/bin/cargo",
            "--execution-root", str(QA / "runtime" / "executions"),
            "--resource-root", str(QA / "runtime" / "resources"),
            "--storage-id", "rust-browser-qa-storage",
            "--node-ref", "candidate-qa-node",
        ]
        for kind in ("chatgpt", "zai"):
            command += ["--native-update", kind, "--browser-binding", kind,
                        bindings[kind]["path"], bindings[kind]["sha256"]]
        built = subprocess.run(command, capture_output=True, text=True, timeout=3600)
        sys.stderr.write(built.stdout[-2000:])
        assert built.returncode == 0, built.stderr[-3000:]
        print("candidate built", flush=True)

        checked = subprocess.run([
            sys.executable, str(REPO / "deploy/fleet/process-leases-candidate.py"), "check",
            "--staged-profiles",
            "--selector", str(CANDIDATE / "selector.json"),
            "--launcher", str(CANDIDATE / "fixture" / "launch-v1-core.py"),
        ], capture_output=True, text=True, timeout=1200)
        assert checked.returncode == 0, checked.stderr[-3000:]
        print("staged check PASS", flush=True)

        migration = json.loads((CANDIDATE / "native-profile-migration.json").read_bytes())
        for row in migration["profiles"]:
            kind = row["kind"]
            mount = ENTRY / "mounts" / kind / "herder-owner-home" / "authority"
            for stale in mount.glob("profile-process-leases-native-*.json"):
                stale.unlink()
            payload = Path(row["payload"])
            staged = mount / row["path"].rsplit("/", 1)[1]
            shutil.copyfile(payload, staged)
            os.chmod(staged, 0o400)
            print(kind, "staged profile", staged.name, flush=True)

        accepted = subprocess.run(
            [sys.executable, str(REPO / "tests/native/candidate_entry_acceptance.py")],
            capture_output=True, text=True, timeout=1800,
        )
        sys.stderr.write(accepted.stdout[-4000:])
        sys.stderr.write(accepted.stderr[-4000:])
        assert accepted.returncode == 0, "entry acceptance failed"
        print("entry acceptance PASS", flush=True)
    finally:
        for kind, process in processes:
            if process.poll() is None:
                try:
                    process.stdin.close()
                except Exception:
                    pass
        for kind, process in processes:
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
