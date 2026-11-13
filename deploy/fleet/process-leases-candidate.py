#!/usr/bin/env python3
"""Build and switch a process-lease native Herder candidate.

The selector is changed only by install/rollback. These commands never restart
the MCP child, modify authority databases, send prompts, or reconcile old jobs.
Use the existing release ownership workflow before an installed selector change.
"""
import argparse
import contextlib
import copy
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical(path):
    p = Path(path)
    if not p.is_absolute() or p.resolve(strict=True) != p:
        raise ValueError("path must be absolute and canonical: " + str(p))
    return p


def private_file(path):
    p = canonical(path)
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or s.st_nlink != 1:
        raise ValueError("expected a private owner-controlled regular file: " + str(p))
    return p


def read_json(path):
    return json.loads(private_file(path).read_text())



def planned_path(path):
    p = Path(path)
    if not p.is_absolute() or p.resolve() != p:
        raise ValueError("path must be absolute and canonical: " + str(p))
    if not p.exists() and p.parent.resolve(strict=True) != p.parent:
        raise ValueError("state root parent must already exist: " + str(p.parent))
    return p


def private_directory(path):
    p = canonical(path)
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError("expected a private owner-controlled directory: " + str(p))
    return p


def configured_principals(selection):
    profiles = selection["profiles"]
    if not isinstance(profiles, list) or not profiles or len(set(profiles)) != len(profiles):
        raise ValueError("select a nonempty unique profile set")
    principals = []
    for path in profiles:
        principal = read_json(path)["owner"]["principal"]
        if not isinstance(principal, str) or not principal.strip():
            raise ValueError("profile principal must be a nonempty string")
        principals.append(principal)
    return sorted(set(principals))


def process_config(selection, worker, node_ref, execution_root, resource_root, storage_id):
    for name, value in (("node_ref", node_ref), ("storage_id", storage_id)):
        if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError(name + " must be a nonempty printable identity")
    execution_root, resource_root = planned_path(execution_root), planned_path(resource_root)
    if (execution_root == resource_root or execution_root in resource_root.parents
            or resource_root in execution_root.parents):
        raise ValueError("execution and resource stores must be distinct non-nested roots")
    return {"version": 1, "node_ref": node_ref, "worker": str(worker),
            "execution_root": str(execution_root),
            "resources": {"storage_id": storage_id, "authority_node": node_ref,
                          "root": str(resource_root), "schema": "v1", "route": {"type": "local"}},
            "administrators": configured_principals(selection)}


def validate_process_config(config, selection, worker):
    if set(config) != {"version", "node_ref", "worker", "execution_root", "resources", "administrators"}:
        raise ValueError("unexpected process runtime configuration fields")
    resources = config["resources"]
    expected = process_config(selection, worker, config["node_ref"], config["execution_root"],
                              resources["root"], resources["storage_id"])
    if config != expected:
        raise ValueError("process configuration must match trusted profiles and local storage")
    return config


def state_roots(config, provision=False):
    """Validate without modifying state; provision only after an install receipt exists."""
    resource = planned_path(config["resources"]["root"])
    execution = planned_path(config["execution_root"])
    marker = {"schema": "v1", "storage_id": config["resources"]["storage_id"]}
    # Complete all checks before creating any root. Never claim an existing unknown store.
    for root, name, expected in ((resource, "storage.json", marker),
            (execution, "store.json", {"schema_version": 1, "node_ref": config["node_ref"]})):
        if root.exists():
            private_directory(root)
            path = root / name
            if path.exists() or path.is_symlink():
                if read_json(path) != expected:
                    raise ValueError("state marker identity mismatch: " + str(path))
            elif any(root.iterdir()):
                raise ValueError("nonempty state root has no expected marker: " + str(root))
    resources_dir = resource / "resources"
    if resources_dir.exists() or resources_dir.is_symlink():
        private_directory(resources_dir)
    if not provision:
        return {"resource_root": str(resource), "execution_root": str(execution), "provisioned": False}
    for root in (resource, execution):
        if not root.exists():
            root.mkdir(mode=0o700)
            sync_dir(root.parent)
        private_directory(root)
    marker_path = resource / "storage.json"
    if not marker_path.exists():
        create(marker_path, encoded(marker))
        sync_dir(resource)
    if read_json(marker_path) != marker:
        raise ValueError("resource store marker changed during provisioning")
    if not resources_dir.exists():
        resources_dir.mkdir(mode=0o700)
        sync_dir(resource)
    private_directory(resources_dir)
    return {"resource_root": str(resource), "execution_root": str(execution), "provisioned": True}


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def create(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def replace(path, data, expected, mode):
    """Digest CAS under the selector's cooperative release lock."""
    p = private_file(path)
    if digest(p) != expected:
        raise ValueError("concurrent change: " + str(p))
    fd, name = tempfile.mkstemp(prefix="." + p.name + ".process-leases-", dir=p.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if digest(p) != expected:
            raise ValueError("concurrent change: " + str(p))
        os.replace(name, p)
        sync_dir(p.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def selector_lock(selector):
    path = Path(selector).parent / ".process-leases-selector.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        if s.st_uid != os.getuid() or s.st_mode & 0o077 or s.st_nlink != 1:
            raise ValueError("invalid selector lock")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def check_selector(selector, launcher, require_worker=True):
    selector = private_file(selector)
    selection = read_json(selector)
    manifest_path = private_file(selection["manifest"])
    if digest(manifest_path) != selection["manifest_sha256"]:
        raise ValueError("manifest digest mismatch")
    manifest = read_json(manifest_path)
    keys = ["core", "compat", "node", "bootstrap"]
    if require_worker or "process_worker" in manifest:
        keys.append("process_worker")
    for key in keys:
        path = canonical(manifest[key])
        if not path.is_file() or not os.access(path, os.X_OK) or digest(path) != manifest["sha256"][key]:
            raise ValueError("artifact mismatch: " + key)
    for kind, path in manifest["adapters"].items():
        if digest(canonical(path)) != manifest["sha256"]["adapters"][kind]:
            raise ValueError("adapter mismatch: " + kind)
    config = None
    if require_worker or "process_config" in manifest:
        config_path = private_file(manifest["process_config"])
        if digest(config_path) != manifest["sha256"]["process_config"]:
            raise ValueError("process configuration digest mismatch")
        config = validate_process_config(read_json(config_path), selection, manifest["process_worker"])
        state_roots(config)
    loader = importlib.machinery.SourceFileLoader("process_leases_launcher", str(private_file(launcher)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    argv, env, receipt = module.prepare(str(selector))
    if env.get("HERDER_NATIVE_COMMAND") != manifest["core"]:
        raise ValueError("launcher does not select the pinned native core")
    if "process_worker" in manifest and env.get("HERDER_PROCESS_WORKER") != manifest["process_worker"]:
        raise ValueError("launcher does not pass the pinned process worker")
    if config is not None and env.get("HERDER_PROCESS_CONFIG") != manifest["process_config"]:
        raise ValueError("launcher does not pass the pinned process configuration")
    return {"selector": str(selector), "selector_sha256": digest(selector),
            "manifest": str(manifest_path), "manifest_sha256": digest(manifest_path),
            "core_sha256": manifest["sha256"]["core"],
            "process_worker_sha256": manifest["sha256"].get("process_worker"),
            "process_config_sha256": manifest["sha256"].get("process_config"),
            "source_commit": manifest.get("source_commit"),
            "profiles_count": len(selection["profiles"])}


def compose_manifest(base, output, source_sha, base_path, base_hash, hashes, build_argv):
    m = copy.deepcopy(base)
    old_core = m["core"]
    m.update(artifact_root=str(output), source_commit=source_sha, source_sha=source_sha,
             core=str(output / "fixture/herder_native_stdio"),
             process_worker=str(output / "fixture/herder_process_worker"),
             process_config=str(output / "fixture/process-runtime.json"))
    m["sha256"].update(core=hashes["core"], process_worker=hashes["process_worker"],
                       process_config=hashes["process_config"])
    m["launch"] = [m["core"] if part == old_core else part for part in m.get("launch", [old_core])]
    if "launch_compat" in m:
        m["launch_compat"].setdefault("env", {}).update(
            HERDER_NATIVE_COMMAND=m["core"], HERDER_PROCESS_WORKER=m["process_worker"],
            HERDER_PROCESS_CONFIG=m["process_config"])
    m.setdefault("build_inputs", {}).setdefault("binary_sha256", {}).update(
        core=hashes["core"], process_worker=hashes["process_worker"])
    m["build_inputs"].update(process_config_sha256=hashes["process_config"],
        source_commit_role="native core, process worker and trusted config; other components retain their prior pins")
    m.setdefault("component_provenance", {}).update(
        core_source_commit=source_sha, process_worker_source_commit=source_sha,
        process_config_source_commit=source_sha,
        process_leases_base_manifest=str(base_path), process_leases_base_manifest_sha256=base_hash)
    m.setdefault("composition", {})["process_leases"] = {
        "scope": "native core, worker and trusted process config updated; existing adapters, profiles and stores retained",
        "base_manifest": str(base_path), "base_manifest_sha256": base_hash}
    m["process_leases_build"] = {"source_commit": source_sha, "argv": build_argv,
        "source_state": "clean before and after build",
        "unchanged_components": ["compat", "node", "bootstrap", "adapters", "remote_ahap_wrappers"]}
    return m


def build(args):
    repo = canonical(args.repo)
    selector = private_file(args.selector)
    before = digest(selector)
    selection = read_json(selector)
    base_path = private_file(selection["manifest"])
    base = read_json(base_path)
    if digest(base_path) != selection["manifest_sha256"]:
        raise ValueError("base manifest changed")
    for key in ("core", "compat", "node", "bootstrap"):
        if digest(base[key]) != base["sha256"][key]:
            raise ValueError("base artifact changed: " + key)
    output = Path(args.output)
    if not output.is_absolute() or output.parent.resolve(strict=True) != output.parent:
        raise ValueError("output parent must exist and be canonical")
    if os.path.lexists(output):
        raise FileExistsError("candidate output already exists")
    def git(*argv):
        return subprocess.check_output(["git", *argv], cwd=repo, text=True).strip()
    sha = git("rev-parse", "HEAD")
    if git("status", "--porcelain"):
        raise ValueError("commit the isolated worktree before a release build")
    profile_hashes = {path: digest(private_file(path)) for path in selection["profiles"]}
    config = process_config(selection, output / "fixture/herder_process_worker", args.node_ref,
                            args.execution_root, args.resource_root, args.storage_id)
    state_roots(config)
    target = Path(args.build_dir)
    if not target.is_absolute() or target.resolve() != target:
        raise ValueError("build-dir must be an absolute canonical path")
    output.mkdir(mode=0o700)
    fixture = output / "fixture"
    fixture.mkdir(mode=0o700)
    cargo = Path(args.cargo or shutil.which("cargo") or (Path.home() / ".cargo/bin/cargo"))
    if not cargo.is_absolute() or not cargo.is_file() or not os.access(cargo, os.X_OK):
        raise ValueError("cargo must select an executable absolute toolchain path")
    argv = [str(cargo), "build", "--locked", "--release", "--manifest-path",
            str(repo / "crates/herder/Cargo.toml"), "--target-dir", str(target),
            "--bin", "herder_native_stdio", "--bin", "herder_process_worker"]
    with (output / "build.log").open("xb") as log:
        os.chmod(output / "build.log", 0o600)
        subprocess.run(argv, cwd=repo, stdout=log, stderr=subprocess.STDOUT, check=True)
    if git("rev-parse", "HEAD") != sha or git("status", "--porcelain"):
        raise ValueError("source changed during build")
    if digest(selector) != before or digest(base_path) != selection["manifest_sha256"]:
        raise ValueError("installed selection changed during build")
    if any(digest(path) != value for path, value in profile_hashes.items()):
        raise ValueError("trusted profile changed during build")
    hashes = {}
    for key, name in (("core", "herder_native_stdio"), ("process_worker", "herder_process_worker")):
        original = canonical(target / "release" / name)
        original_hash = digest(original)
        dest = fixture / name
        shutil.copyfile(original, dest)
        dest.chmod(0o500)
        hashes[key] = digest(dest)
        if hashes[key] != original_hash or digest(original) != original_hash:
            raise ValueError("build input changed while copying")
    launcher = repo / "deploy/fleet/launch-v1-core.py"
    create(fixture / "launch-v1-core.py", launcher.read_bytes(), 0o500)
    create(fixture / "process-runtime.json", encoded(config), 0o400)
    hashes["process_config"] = digest(fixture / "process-runtime.json")
    manifest = compose_manifest(base, output, sha, base_path, selection["manifest_sha256"], hashes, argv)
    create(output / "manifest.json", encoded(manifest), 0o400)
    candidate_selection = copy.deepcopy(selection)
    candidate_selection.update(manifest=str(output / "manifest.json"), manifest_sha256=digest(output / "manifest.json"))
    create(output / "selector.json", encoded(candidate_selection), 0o400)
    build_receipt = {"source_commit": sha, "base_selector": str(selector),
                     "base_selector_sha256": before, "base_manifest_sha256": selection["manifest_sha256"],
                     "launcher_sha256": digest(fixture / "launch-v1-core.py"), "build_argv": argv,
                     "profile_sha256": profile_hashes, "process_config_sha256": hashes["process_config"],
                     "candidate_selector_sha256": digest(output / "selector.json"),
                     "candidate_manifest_sha256": digest(output / "manifest.json")}
    create(output / "process-leases-build.json", encoded(build_receipt), 0o400)
    result = check_selector(output / "selector.json", fixture / "launch-v1-core.py")
    fixture.chmod(0o500)
    output.chmod(0o500)
    return {**result, "status": "candidate_verified_not_installed", "build_log": str(output / "build.log")}


def install(args):
    candidate = private_file(args.candidate)
    bundle = candidate.parent
    candidate_launcher = bundle / "fixture/launch-v1-core.py"
    checked = check_selector(candidate, candidate_launcher)
    build_receipt = read_json(bundle / "process-leases-build.json")
    if digest(candidate) != build_receipt["candidate_selector_sha256"] or checked["manifest_sha256"] != build_receipt["candidate_manifest_sha256"]:
        raise ValueError("candidate selection changed since build")
    if digest(candidate_launcher) != build_receipt["launcher_sha256"]:
        raise ValueError("candidate launcher changed since build")
    if checked["process_config_sha256"] != build_receipt["process_config_sha256"]:
        raise ValueError("candidate process configuration changed since build")
    if any(digest(private_file(path)) != value for path, value in build_receipt["profile_sha256"].items()):
        raise ValueError("trusted profile changed since build")
    selector = private_file(args.selector)
    launcher = private_file(args.launcher)
    if str(selector) != build_receipt["base_selector"]:
        raise ValueError("candidate was built for a different installed selector")
    if candidate == selector or candidate_launcher == launcher:
        raise ValueError("candidate must be separate from the installed paths")
    with selector_lock(selector):
        old_hash, old_launcher_hash = digest(selector), digest(launcher)
        if old_hash != args.expected_selector_sha256 or old_hash != build_receipt["base_selector_sha256"]:
            raise ValueError("installed selector changed since candidate build")
        old, new = read_json(selector), read_json(candidate)
        if old["profiles"] != new["profiles"]:
            raise ValueError("this rollout must preserve the exact owner profile set")
        if set(build_receipt["profile_sha256"]) != set(old["profiles"]):
            raise ValueError("candidate profile snapshot is incomplete")
        candidate_manifest = read_json(new["manifest"])
        config = read_json(candidate_manifest["process_config"])
        state_roots(config)
        # New launcher must also understand the current manifest during the two-file switch.
        check_selector(selector, candidate_launcher, require_worker=False)
        backup = Path(args.backup)
        if not backup.is_absolute() or backup.parent.resolve(strict=True) != backup.parent:
            raise ValueError("backup parent must exist and be canonical")
        backup.mkdir(mode=0o700)
        create(backup / "selector.before.json", selector.read_bytes())
        create(backup / "launcher.before.py", launcher.read_bytes())
        receipt = {"schema": 1, "status": "prepared", "created_at": int(time.time()),
            "selector": str(selector), "launcher": str(launcher), "candidate": str(candidate),
            "selector_before_sha256": old_hash, "launcher_before_sha256": old_launcher_hash,
            "selector_after_sha256": digest(candidate), "launcher_after_sha256": digest(candidate_launcher),
            "selector_mode": stat.S_IMODE(selector.stat().st_mode), "launcher_mode": stat.S_IMODE(launcher.stat().st_mode),
            "profiles_preserved": True, "databases_modified": False}
        receipt_path = backup / "receipt.json"
        create(receipt_path, encoded(receipt))
        receipt["state_roots"] = state_roots(config, provision=True)
        receipt["status"] = "state_prepared"
        replace(receipt_path, encoded(receipt), digest(receipt_path), 0o600)
        replace(launcher, candidate_launcher.read_bytes(), old_launcher_hash, receipt["launcher_mode"])
        replace(selector, candidate.read_bytes(), old_hash, receipt["selector_mode"])
        checked = check_selector(selector, launcher)
        receipt["status"] = "configured_pending_restart"
        replace(receipt_path, encoded(receipt), digest(receipt_path), 0o600)
        return {**checked, "status": receipt["status"], "rollback_receipt": str(receipt_path),
                "restart_required": True, "child_ref": "AgentHerder", "databases_modified": False}


def rollback(args):
    receipt_path = private_file(args.receipt)
    r = read_json(receipt_path)
    selector, launcher = private_file(r["selector"]), private_file(r["launcher"])
    old_selector, old_launcher = receipt_path.parent / "selector.before.json", receipt_path.parent / "launcher.before.py"
    if digest(old_selector) != r["selector_before_sha256"] or digest(old_launcher) != r["launcher_before_sha256"]:
        raise ValueError("rollback backup changed")
    check_selector(old_selector, old_launcher, require_worker=False)
    with selector_lock(selector):
        current_s, current_l = digest(selector), digest(launcher)
        allowed_s = {r["selector_before_sha256"], r["selector_after_sha256"]}
        allowed_l = {r["launcher_before_sha256"], r["launcher_after_sha256"]}
        if current_s not in allowed_s or current_l not in allowed_l:
            raise ValueError("another release changed the installed files")
        if current_s != r["selector_before_sha256"]:
            replace(selector, old_selector.read_bytes(), current_s, r["selector_mode"])
        if current_l != r["launcher_before_sha256"]:
            replace(launcher, old_launcher.read_bytes(), current_l, r["launcher_mode"])
        r["status"] = "configuration_rolled_back_pending_restart"
        replace(receipt_path, encoded(r), digest(receipt_path), 0o600)
    return {"status": r["status"], "selector": str(selector), "restart_required": True,
            "databases_modified": False, "workers_stopped": False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    for name in ("repo", "selector", "output", "build-dir"):
        b.add_argument("--" + name, required=True, type=Path)
    for name in ("execution-root", "resource-root"):
        b.add_argument("--" + name, required=True, type=Path)
    b.add_argument("--cargo", type=Path, help="explicit Cargo executable, including a rustup proxy")
    b.add_argument("--node-ref", required=True)
    b.add_argument("--storage-id", required=True)
    c = sub.add_parser("check")
    c.add_argument("--selector", required=True, type=Path)
    c.add_argument("--launcher", required=True, type=Path)
    i = sub.add_parser("install")
    for name in ("candidate", "selector", "launcher", "backup"):
        i.add_argument("--" + name, required=True, type=Path)
    i.add_argument("--expected-selector-sha256", required=True)
    r = sub.add_parser("rollback")
    r.add_argument("--receipt", required=True, type=Path)
    args = p.parse_args()
    try:
        result = {"build": build, "install": install, "rollback": rollback,
                  "check": lambda a: check_selector(a.selector, a.launcher)}[args.command](args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as e:
        print(json.dumps({"status": "failed", "error_type": type(e).__name__, "error": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
