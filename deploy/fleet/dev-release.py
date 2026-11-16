#!/usr/bin/env python3
"""Short guarded development release loop for Agent Herder.

Blue is the installed release. Green is a staged release after the candidate
gate passes. This wrapper composes the existing guarded scripts and never
writes current or a systemd drop-in directly.
"""

from __future__ import annotations

import argparse
import fcntl
import importlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "deploy/fleet/build-release-candidate.py"
ROLLOUT = ROOT / "deploy/fleet/rollout-node.py"
CANDIDATE_GATE = ROOT / "tests/native/candidate_release_gate.py"
DEFAULT_CATALOG = Path(os.environ.get("AGENT_HERDER_DEV_FLEET_DIR", str(Path.home() / "agents-projects/.fleet-candidate"))).expanduser()
DEFAULT_STATE = Path(os.environ.get("AGENT_HERDER_DEV_RELEASE_STATE", str(Path.home() / ".local/state/agent-herder/dev-releases"))).expanduser()


def full_sha(repo: Path, value: str | None) -> str:
    requested = value or "origin/main"
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", requested], check=False, capture_output=True, text=True)
    if result.returncode or len(result.stdout.strip()) != 40:
        raise RuntimeError(f"cannot resolve release SHA: {requested}")
    return result.stdout.strip()


def current_sha(catalog: Path) -> str | None:
    link = catalog / "current"
    return Path(os.readlink(link)).name if link.is_symlink() else None


def config_sha(catalog: Path) -> str | None:
    path = catalog / "node-config.json"
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    result = value.get("sourceSha") if isinstance(value, dict) else None
    return result if isinstance(result, str) else None


def candidate_path(catalog: Path, sha: str) -> Path:
    return catalog / "releases" / sha


def receipt_path(catalog: Path, sha: str) -> Path:
    return catalog / "ci-receipts" / f"{sha}.json"


def release_dropin(unit: str) -> Path:
    if not unit.endswith(".service") or "/" in unit or ".." in unit:
        raise ValueError("unit must be a plain systemd .service name")
    return Path.home() / ".config/systemd/user" / f"{unit}.d/10-release-exec.conf"


def load_rollout_node():
    sys.path.insert(0, str(ROLLOUT.parent))
    spec = importlib.util.spec_from_file_location("agent_herder_rollout_node", ROLLOUT)
    if spec is None or spec.loader is None:
        raise RuntimeError("rollout_node_import_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_command(command: list[str], label: str, state_dir: Path, apply: bool) -> int:
    state_dir.mkdir(parents=True, exist_ok=True)
    log = state_dir / f"{int(time.time())}-{label}.log"
    if not apply:
        print(json.dumps({"state": "planned", "label": label, "command": command}, ensure_ascii=False))
        return 0
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    log.write_text((result.stdout or "") + ("\n" + result.stderr if result.stderr else ""))
    lines = [line.strip() for line in (result.stdout + "\n" + result.stderr).splitlines() if line.strip()]
    print(json.dumps({"state": "green" if result.returncode == 0 else "failed", "label": label, "returncode": result.returncode, "log": str(log), "tail": lines[-4:]}, ensure_ascii=False))
    return result.returncode


def build_command(args: argparse.Namespace, sha: str) -> list[str]:
    command = [sys.executable, str(BUILD), "--sha", sha, "--catalog", str(args.catalog)]
    if args.skip_build:
        command.append("--skip-build")
    return command


def green_command(args: argparse.Namespace, sha: str) -> list[str]:
    codex = args.codex_bin or shutil.which("codex") or "codex"
    opencode = args.opencode_bin or str(Path.home() / ".npm-global/lib/node_modules/@opencode/cli/bin/opencode.exe")
    return [sys.executable, str(CANDIDATE_GATE), str(candidate_path(args.catalog, sha)), sha,
            str(Path(codex).resolve()) if Path(codex).exists() else codex,
            str(Path(opencode).resolve()) if Path(opencode).exists() else opencode,
            str(receipt_path(args.catalog, sha))]


def promote_command(args: argparse.Namespace, sha: str, previous: str) -> list[str]:
    if not args.release_proof:
        raise RuntimeError("--release-proof is required for promote")
    return [sys.executable, str(ROLLOUT), "--release-proof", str(args.release_proof), "--fleet-dir", str(args.catalog),
            "--unit", args.unit, "--kind", "owner", "--sha", sha, "--previous-sha", previous,
            "--port", str(args.port), "--restart-cmd", args.restart_cmd]


def rollback_candidates(catalog: Path, current: str) -> list[Path]:
    return sorted(catalog.glob(f"node-config-before-{current[:8]}*.json"), key=lambda path: path.stat().st_mtime_ns, reverse=True)


def rollback_plan(args: argparse.Namespace) -> dict[str, Any]:
    blue = config_sha(args.catalog) or current_sha(args.catalog)
    if not blue or len(blue) != 40:
        raise RuntimeError("rollback_current_revision_unknown")
    backups = rollback_candidates(args.catalog, blue)
    if not backups:
        raise RuntimeError(f"rollback_snapshot_missing:{blue[:8]}")
    backup = backups[0]
    document = json.loads(backup.read_text())
    target = document.get("sourceSha")
    if not isinstance(target, str) or len(target) != 40 or target == blue:
        raise RuntimeError("rollback_snapshot_invalid")
    release = candidate_path(args.catalog, target)
    if not release.is_dir():
        raise RuntimeError(f"rollback_release_missing:{target[:8]}")
    snapshot = release_dropin(args.unit).with_name(f"10-release-exec.conf.rollback-{blue}.json")
    return {"blue": blue, "rollbackTo": target, "configBackup": str(backup), "dropinSnapshot": str(snapshot) if snapshot.is_file() else None, "release": str(release), "unit": args.unit}


def apply_rollback(args: argparse.Namespace, plan: dict[str, Any]) -> int:
    if not args.release_proof:
        raise RuntimeError("--release-proof is required for rollback")
    rollout = load_rollout_node()
    gate_module = importlib.import_module("release_gate")
    lock_path = args.catalog / ".dev-release.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if (config_sha(args.catalog) or current_sha(args.catalog)) != plan["blue"]:
            raise RuntimeError("rollback_live_revision_changed")
        gate = gate_module.ReleaseGate(str(args.release_proof), target={"fleetDir": str(args.catalog.resolve()), "unit": args.unit})
        with gate:
            gate.compare_cleanup_revision(args.catalog / "node-config.json", [plan["blue"], plan["rollbackTo"]])
            rollout.restore_install(args.catalog, args.catalog / "node-config.json", Path(plan["configBackup"]), plan["blue"], plan["rollbackTo"],
                                    release_dropin(args.unit), Path(plan["dropinSnapshot"]) if plan["dropinSnapshot"] else None,
                                    shlex.split(args.restart_cmd))
            gate.compare_revision(args.catalog / "node-config.json", plan["rollbackTo"])
    after = config_sha(args.catalog) or current_sha(args.catalog)
    if after != plan["rollbackTo"]:
        raise RuntimeError("rollback_readback_mismatch")
    args.state_dir.mkdir(parents=True, exist_ok=True)
    receipt = args.state_dir / f"rollback-{int(time.time())}.json"
    receipt.write_text(json.dumps({**plan, "result": "rollback_green", "after": after}, indent=2) + "\n")
    print(json.dumps({"state": "rollback_green", "from": plan["blue"], "to": after, "receipt": str(receipt)}))
    return 0


def status(args: argparse.Namespace) -> int:
    blue = config_sha(args.catalog) or current_sha(args.catalog)
    rollback_target = None
    rollback_info: dict[str, Any] | None = None
    if blue:
        try:
            rollback_info = rollback_plan(args)
            rollback_target = rollback_info["rollbackTo"]
        except (OSError, ValueError, RuntimeError):
            rollback_info = None
    requested_green = getattr(args, "sha", None)
    green = requested_green if requested_green and requested_green not in {blue, rollback_target} and candidate_path(args.catalog, requested_green).is_dir() else None
    if green is None and (args.catalog / "releases").is_dir():
        staged = [path for path in (args.catalog / "releases").glob("*") if path.is_dir() and path.name not in {blue, rollback_target}]
        if staged:
            green = sorted(staged, key=lambda path: path.stat().st_mtime_ns, reverse=True)[0].name
    result: dict[str, Any] = {"blue": {"sha": blue, "release": str(candidate_path(args.catalog, blue)) if blue else None},
                              "green": {"sha": green, "release": str(candidate_path(args.catalog, green)) if green else None},
                              "unit": args.unit, "port": args.port}
    if blue:
        if rollback_info is not None:
            result["rollback"] = rollback_info
        else:
            result["rollback"] = {"state": "unavailable", "reason": "rollback_snapshot_missing_or_invalid"}
    print(json.dumps(result, ensure_ascii=False))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    root.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    root.add_argument("--unit", default="agent-herder.service")
    root.add_argument("--port", type=int, default=18787)
    root.add_argument("--restart-cmd", default="systemctl --user restart agent-herder.service")
    root.add_argument("--release-proof", type=Path)
    root.add_argument("--codex-bin", default="")
    root.add_argument("--opencode-bin", default="")
    root.add_argument("--apply", action="store_true")
    sub = root.add_subparsers(dest="action", required=True)
    sub.add_parser("status")
    build = sub.add_parser("build"); build.add_argument("--sha"); build.add_argument("--skip-build", action="store_true")
    green = sub.add_parser("green"); green.add_argument("--sha", required=True); green.add_argument("--apply", action="store_true", default=argparse.SUPPRESS)
    promote = sub.add_parser("promote"); promote.add_argument("--sha", required=True); promote.add_argument("--apply", action="store_true", default=argparse.SUPPRESS)
    rollback = sub.add_parser("rollback"); rollback.add_argument("--apply", action="store_true", default=argparse.SUPPRESS)
    stop = sub.add_parser("stop"); stop.add_argument("--apply", action="store_true", default=argparse.SUPPRESS)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    args.catalog = args.catalog.expanduser().resolve(); args.state_dir = args.state_dir.expanduser().resolve()
    if args.action == "status": return status(args)
    if args.action == "build": return run_command(build_command(args, full_sha(ROOT, args.sha)), "build", args.state_dir, True)
    if args.action == "green":
        if not candidate_path(args.catalog, args.sha).is_dir(): raise SystemExit(f"green candidate missing: {candidate_path(args.catalog, args.sha)}")
        return run_command(green_command(args, args.sha), "green", args.state_dir, args.apply)
    if args.action == "promote":
        previous = config_sha(args.catalog) or current_sha(args.catalog)
        if not previous: raise SystemExit("blue current release is unknown")
        if not args.apply:
            print(json.dumps({"state": "planned", "blue": previous, "green": args.sha, "command": promote_command(args, args.sha, previous)})); return 0
        green_result = run_command(green_command(args, args.sha), "green", args.state_dir, True)
        return green_result or run_command(promote_command(args, args.sha, previous), "promote", args.state_dir, True)
    if args.action == "rollback":
        plan = rollback_plan(args)
        if not args.apply: print(json.dumps({"state": "planned", **plan}, ensure_ascii=False)); return 0
        return apply_rollback(args, plan)
    if args.action == "stop": return run_command(["systemctl", "--user", "stop", args.unit], "stop", args.state_dir, args.apply)
    raise SystemExit("unknown action")


if __name__ == "__main__":
    try: raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(json.dumps({"state": "failed", "error": str(error)})); raise SystemExit(1)
