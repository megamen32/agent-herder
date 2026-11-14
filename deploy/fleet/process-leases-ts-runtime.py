#!/usr/bin/env python3
"""Publish and install an immutable canonical TS runtime after legacy writer drain."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from release_gate import ReleaseGate

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

readiness = module("canonical_ts_readiness", "process-leases-scheduler-readiness.py")

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()

def publish(path, data, mode=0o400):
    path = Path(path)
    if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
        raise ValueError("publication_parent_not_canonical")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    return {"path": str(path), "sha256": digest(data)}

def pinned(path, expected):
    data, _ = readiness.read_file(str(path), policy="private")
    if digest(data) != expected:
        raise ValueError("pinned_file_changed")
    return json.loads(data)

def runtime_identity(path, manifest):
    return {"manifest": str(path), "manifest_sha256": digest(Path(path).read_bytes()),
            "source_commit": manifest["source_commit"], "capability": readiness.CAPABILITY,
            "resume_after_authority": "canonical", "legacy_fallback": False}

def freeze(release, source, node, output):
    release, node, output = Path(release), Path(node), Path(output)
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("source_commit_invalid")
    if release.resolve(strict=True) != release or release.name != source:
        raise ValueError("release_source_path_mismatch")
    root = release / "dist"
    deployment = json.loads((root / "fleet-deployment-manifest.json").read_text())
    if deployment.get("source_sha") != source:
        raise ValueError("compiled_source_mismatch")
    node_bytes, _ = readiness.read_file(str(node), maximum=256 * 1024 * 1024, policy="node")
    files, directories, total = {}, [], 0
    for directory, children, names in os.walk(root, followlinks=False):
        directory = Path(directory)
        meta = directory.lstat()
        if (directory.resolve(strict=True) != directory or not stat.S_ISDIR(meta.st_mode)
                or meta.st_uid != os.getuid() or len(directory.relative_to(root).parts) > 32):
            raise ValueError("runtime_directory_invalid")
        directories.append(directory)
        for name in children:
            if (directory / name).is_symlink():
                raise ValueError("runtime_directory_symlink")
        for name in names:
            path = directory / name
            before = path.lstat()
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                    or before.st_nlink != 1 or before.st_size > 64 * 1024 * 1024):
                raise ValueError("runtime_file_invalid")
            data = path.read_bytes()
            after = path.lstat()
            if not readiness.same_file(before, after):
                raise ValueError("runtime_file_changed")
            files[path.relative_to(root).as_posix()] = digest(data)
            total += len(data)
            if len(files) > 10000 or total > 512 * 1024 * 1024:
                raise ValueError("runtime_inventory_too_large")
    if not readiness.REQUIRED_FILES <= files.keys():
        raise ValueError("runtime_capability_incomplete")
    manifest = {"version": 1, "kind": "herder-canonical-ts-runtime",
                "capability": readiness.CAPABILITY, "source_commit": source,
                "root": str(root), "entry": "index.js", "files": files,
                "node_binary": str(node), "node_sha256": digest(node_bytes)}
    if output == root or root in output.parents or output.exists():
        raise ValueError("runtime_manifest_destination_invalid")
    for name in files:
        os.chmod(root / name, 0o400)
    for directory in reversed(directories):
        os.chmod(directory, 0o500)
    publish(output, encoded(manifest))
    identity = runtime_identity(output, manifest)
    readiness.runtime_tree(identity)
    return identity

def systemctl(*arguments):
    env = dict(os.environ)
    env.update(XDG_RUNTIME_DIR="/run/user/" + str(os.getuid()),
               DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/" + str(os.getuid()) + "/bus")
    return subprocess.run(["/usr/bin/systemctl", "--user", *arguments], env=env,
                          capture_output=True, text=True, timeout=45)

def owner_identity(unit):
    result = systemctl("show", unit, "-p", "MainPID", "--value")
    if result.returncode:
        return None
    try:
        pid = int(result.stdout.strip())
        if pid <= 1:
            return None
        process = Path("/proc") / str(pid)
        birth = process.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19]
        argv = tuple(part.decode() for part in process.joinpath("cmdline").read_bytes().split(b"\0") if part)
        return pid, birth, argv
    except (OSError, ValueError, UnicodeError, IndexError):
        return None

def stopped_service():
    result = systemctl("show", readiness.UNIT, "--property=MainPID,ActiveState,SubState")
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if result.returncode or values.get("MainPID") != "0" or values.get("ActiveState") not in ("inactive", "failed"):
        raise ValueError("legacy_service_not_stopped")
    return values

def check_file(path, expected):
    path = Path(path)
    if expected is None:
        if path.exists() or path.is_symlink():
            raise ValueError("unexpected_existing_install_file")
        if path.parent.resolve(strict=True) != path.parent:
            raise ValueError("install_parent_not_canonical")
        return None
    data, _ = readiness.read_file(str(path), policy="unit")
    if digest(data) != expected:
        raise ValueError("install_file_changed")
    return data

def replace(path, data, expected, mode=0o600):
    path = Path(path)
    check_file(path, expected)
    temporary = path.with_name(path.name + ".canonical-" + str(os.getpid()))
    publish(temporary, data, mode)
    try:
        check_file(path, expected)
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temporary.exists():
            temporary.unlink()

def install(plan_path, expected_sha256, proof, journal):
    plan = pinned(plan_path, expected_sha256)
    if plan.get("version") != 1 or plan.get("kind") != "herder-canonical-ts-install":
        raise ValueError("install_plan_invalid")
    runtime, _, _ = readiness.runtime_tree(plan["runtime"])
    readiness.writer_drain(plan["canonical"])
    if runtime["source_commit"] != plan["source_commit"]:
        raise ValueError("install_source_mismatch")
    catalog = Path(plan["catalog"])
    release = Path(runtime["root"]).parent
    if release != catalog / "releases" / plan["source_commit"]:
        raise ValueError("install_catalog_mismatch")
    current = catalog / "current"
    if not current.is_symlink() or os.readlink(current) != plan["current_target"]:
        raise ValueError("installed_current_changed")
    config_path = catalog / "node-config.json"
    config_bytes = check_file(config_path, plan["node_config_sha256"])
    config = json.loads(config_bytes)
    if config.get("sourceSha") != plan["previous_source"]:
        raise ValueError("installed_source_changed")
    for key in ("drop_in", "canonical_drop_in"):
        check_file(plan[key]["path"], plan[key]["sha256"])
    stopped_service()
    journal = Path(journal)
    if journal.exists() or journal.parent.resolve(strict=True) != journal.parent:
        raise ValueError("fresh_install_journal_required")
    rollout = module("canonical_ts_owner_rollout", "rollout-candidate.py")
    target = {"fleetDir": str(catalog), "unit": readiness.UNIT}
    with ReleaseGate(proof, target=target) as gate:
        gate.candidate_descends_from(plan["previous_source"], plan["source_commit"])
        rollout.run_native_candidate_preflight(release, plan["source_commit"], catalog, gate)
        readiness.runtime_tree(plan["runtime"])
        readiness.writer_drain(plan["canonical"])
        stopped_service()
        if not current.is_symlink() or os.readlink(current) != plan["current_target"]:
            raise ValueError("installed_current_changed")
        gate.compare_revision(config_path, plan["previous_source"])
        journal.mkdir(mode=0o700)
        publish(journal / "intent.json", encoded({"version": 1, "kind": "canonical-ts-install-intent",
                "plan": str(plan_path), "plan_sha256": expected_sha256, "target": target,
                "source_commit": plan["source_commit"], "created_at_unix_ms": int(time.time() * 1000)}))
        publish(journal / "node-config.before.json", config_bytes)
        for key in ("drop_in", "canonical_drop_in"):
            prior = check_file(plan[key]["path"], plan[key]["sha256"])
            if prior is not None:
                publish(journal / (key + ".before"), prior)
        # The sealed legacy ledger must never be reactivated by an automatic rollback.
        gate.check()
        rollout.prepare_owner_area(catalog, release, plan["working_directory"])
        env = dict(zip(readiness.ENV_KEYS, ("canonical", plan["canonical"]["config"],
            plan["canonical"]["config_sha256"], plan["runtime"]["manifest"], plan["runtime"]["manifest_sha256"])))
        if any(re.search(r'[\s"\\%]', value) for value in env.values()):
            raise ValueError("unsupported_systemd_pin")
        canonical_dropin = "[Service]\n" + "".join("Environment=" + k + "=" + v + "\n" for k, v in env.items())
        canonical_dropin += "".join("Environment=" + key + "=\n" for key in readiness.INJECTION_ENV)
        canonical_dropin += "UnsetEnvironment=AGENT_RESUME_PYTHON AGENT_RESUME_SCRIPT " + " ".join(readiness.INJECTION_ENV) + "\n"
        entry = str(Path(runtime["root"]) / "index.js")
        if any(re.search(r'[\s"\\%]', value) for value in (runtime["node_binary"], entry)):
            raise ValueError("unsupported_systemd_runtime")
        executable_dropin = "[Service]\nExecStart=\nExecStart=" + runtime["node_binary"] + " " + entry + "\n"
        gate.check()
        replace(plan["canonical_drop_in"]["path"], canonical_dropin.encode(), plan["canonical_drop_in"]["sha256"])
        gate.check()
        replace(plan["drop_in"]["path"], executable_dropin.encode(), plan["drop_in"]["sha256"])
        config.update(sourceSha=plan["source_commit"], nodeBin=runtime["node_binary"], candidate=False)
        config.pop("note", None)
        gate.check()
        replace(config_path, encoded(config), plan["node_config_sha256"])
        gate.check()
        if os.readlink(current) != plan["current_target"]:
            raise ValueError("installed_current_changed")
        rollout.switch_current(catalog, plan["source_commit"])
        gate.check()
        reload_result = systemctl("daemon-reload")
        if reload_result.returncode:
            raise RuntimeError("canonical_service_reload_failed")
        stopped_service()
        gate.check()
        publish(journal / "start-intent.json", encoded({"version": 1, "unit": readiness.UNIT,
                "source_commit": plan["source_commit"], "at_unix_ms": int(time.time() * 1000)}))
        started = systemctl("start", readiness.UNIT)
        if started.returncode:
            raise RuntimeError("canonical_service_start_uncertain_inspect_original_operation")
        gate.check()
        observed = owner_identity(readiness.UNIT)
        if not observed or observed[2] != (runtime["node_binary"], entry):
            raise RuntimeError("canonical_service_identity_unverified")
        result = {"version": 1, "kind": "canonical-ts-installed", "source_commit": plan["source_commit"],
                  "plan_sha256": expected_sha256, "pid": observed[0], "start_ticks": observed[1],
                  "node_binary": runtime["node_binary"], "entry": entry,
                  "state": "started_pending_paired_readiness", "at_unix_ms": int(time.time() * 1000)}
        publish(journal / "result.json", encoded(result))
        return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    frozen = sub.add_parser("freeze")
    for key in ("release", "source", "node", "output"):
        frozen.add_argument("--" + key, required=True)
    installed = sub.add_parser("install")
    for key in ("plan", "plan-sha256", "proof", "journal"):
        installed.add_argument("--" + key, required=True)
    args = parser.parse_args()
    try:
        result = (freeze(args.release, args.source, args.node, args.output) if args.command == "freeze"
                  else install(args.plan, args.plan_sha256, args.proof, args.journal))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__, "error": str(error)}), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
