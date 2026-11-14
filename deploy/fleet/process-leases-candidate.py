#!/usr/bin/env python3
"""Build and switch a process-lease native Herder candidate.

The selector mutation functions are library-only and require the continuously
held rollout admission from process-leases-rollout.py. Build/check never restart
the MCP child, modify authority databases, send prompts, or reconcile old jobs.
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
import re
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
    if "resource_bridge" in manifest:
        keys.append("resource_bridge")
    for key in keys:
        path = canonical(manifest[key])
        if not path.is_file() or not os.access(path, os.X_OK) or digest(path) != manifest["sha256"][key]:
            raise ValueError("artifact mismatch: " + key)
    for kind, path in manifest["adapters"].items():
        if digest(canonical(path)) != manifest["sha256"]["adapters"][kind]:
            raise ValueError("adapter mismatch: " + kind)
    if "process_wait_reader" in manifest:
        if digest(private_file(manifest["process_wait_reader"])) != manifest["sha256"]["process_wait_reader"]:
            raise ValueError("process wait reader digest mismatch")
    if "process_remote_bridge" in manifest:
        if digest(private_file(manifest["process_remote_bridge"])) != manifest["sha256"]["process_remote_bridge"]:
            raise ValueError("process remote bridge digest mismatch")
        evidence = manifest.get("build_inputs", {}).get("process_remote_bridge")
        if (not isinstance(evidence, dict) or set(evidence) != {"version", "source_commit", "source_path",
                "source_sha256", "compiled_entrypoint_sha256", "bundler_sha256", "compile_argv"}
                or evidence.get("version") != 1
                or evidence.get("source_path") != "src/herder-process-remote-bridge.ts"
                or evidence.get("source_commit") != manifest.get("component_provenance", {}).get("process_remote_bridge_source_commit")
                or not re.fullmatch(r"[a-f0-9]{40}", str(evidence.get("source_commit", "")))
                or any(not re.fullmatch(r"[a-f0-9]{64}", str(evidence.get(key, "")))
                       for key in ("source_sha256", "compiled_entrypoint_sha256", "bundler_sha256"))
                or not isinstance(evidence.get("compile_argv"), list) or len(evidence["compile_argv"]) != 2
                or any(not isinstance(argv, list) or not argv or not all(isinstance(value, str) for value in argv)
                       for argv in evidence["compile_argv"])):
            raise ValueError("process remote bridge build provenance missing")
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
    if "process_worker" in manifest and env.get("HERDER_PROCESS_WORKER") not in (None, manifest["process_worker"]):
        raise ValueError("launcher does not pass the pinned process worker")
    if config is not None and env.get("HERDER_PROCESS_CONFIG") != manifest["process_config"]:
        raise ValueError("launcher does not pass the pinned process configuration")
    return {"selector": str(selector), "selector_sha256": digest(selector),
            "manifest": str(manifest_path), "manifest_sha256": digest(manifest_path),
            "core_sha256": manifest["sha256"]["core"],
            "process_worker_sha256": manifest["sha256"].get("process_worker"),
            "resource_bridge_sha256": manifest["sha256"].get("resource_bridge"),
            "process_remote_bridge_sha256": manifest["sha256"].get("process_remote_bridge"),
            "process_config_sha256": manifest["sha256"].get("process_config"),
            "source_commit": manifest.get("source_commit"),
            "profiles_count": len(selection["profiles"])}


def reject_unmigrated_core_descriptors(base):
    if any(key in base for key in ("core_release", "products", "product_sha256")):
        raise ValueError("shared-core product descriptors require regeneration for the replacement core; stale bindings are not copied")


def compose_manifest(base, output, source_sha, base_path, base_hash, hashes, build_argv):
    reject_unmigrated_core_descriptors(base)
    m = copy.deepcopy(base)
    # A prior profile transition is historical provenance, not this release's
    # permission to modify profiles. Every new transition needs its own record.
    m.pop("adapter_migration", None)
    m["sha256"].pop("adapter_migration", None)
    old_core = m["core"]
    m.update(artifact_root=str(output), source_commit=source_sha, source_sha=source_sha,
             core=str(output / "fixture/herder_native_stdio"),
             process_worker=str(output / "fixture/herder_process_worker"),
             process_config=str(output / "fixture/process-runtime.json"))
    if "resource_bridge" in hashes:
        m["resource_bridge"] = str(output / "fixture/herder_resource_bridge")
        m["sha256"]["resource_bridge"] = hashes["resource_bridge"]
    if "process_remote_bridge" in hashes:
        m["process_remote_bridge"] = str(output / "fixture/herder-process-remote-bridge.mjs")
        m["sha256"]["process_remote_bridge"] = hashes["process_remote_bridge"]
    if "process_wait_reader" in hashes:
        m["process_wait_reader"] = str(output / "fixture/process-wait-status.py")
        m["sha256"]["process_wait_reader"] = hashes["process_wait_reader"]
    m["sha256"].update(core=hashes["core"], process_worker=hashes["process_worker"],
                       process_config=hashes["process_config"])
    m["launch"] = [m["core"] if part == old_core else part for part in m.get("launch", [old_core])]
    if "launch_compat" in m:
        m["launch_compat"].setdefault("env", {}).update(
            HERDER_NATIVE_COMMAND=m["core"], HERDER_PROCESS_CONFIG=m["process_config"])
        m["launch_compat"]["env"].pop("HERDER_PROCESS_WORKER", None)
    m.setdefault("build_inputs", {}).setdefault("binary_sha256", {}).update(
        core=hashes["core"], process_worker=hashes["process_worker"])
    if "resource_bridge" in hashes:
        m["build_inputs"]["binary_sha256"]["resource_bridge"] = hashes["resource_bridge"]
    m["build_inputs"].update(process_config_sha256=hashes["process_config"],
        source_commit_role="native core, process worker and trusted config; other components retain their prior pins")
    m.setdefault("component_provenance", {}).update(
        core_source_commit=source_sha, process_worker_source_commit=source_sha,
        process_config_source_commit=source_sha,
        process_leases_base_manifest=str(base_path), process_leases_base_manifest_sha256=base_hash)
    if "resource_bridge" in hashes:
        m["component_provenance"]["resource_bridge_source_commit"] = source_sha
    if "process_remote_bridge" in hashes:
        m["component_provenance"]["process_remote_bridge_source_commit"] = source_sha
    if "process_wait_reader" in hashes:
        m["component_provenance"]["process_wait_reader_source_commit"] = source_sha
    m.setdefault("composition", {})["process_leases"] = {
        "scope": "native core, worker and trusted process config updated; existing adapters, profiles and stores retained",
        "base_manifest": str(base_path), "base_manifest_sha256": base_hash}
    m["process_leases_build"] = {"source_commit": source_sha, "argv": build_argv,
        "source_state": "clean before and after build",
        "unchanged_components": ["compat", "node", "bootstrap", "adapters", "remote_ahap_wrappers"]}
    return m


ADAPTER_UPDATES = {"opencode", "zcode"}


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON member in protected configuration")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non-finite JSON value")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def profile_payload(raw, previous, replacement):
    """Replace one JSON string token; every other byte remains identical."""
    before = strict_json(raw)
    if before["owner"]["ahap_script"] != previous:
        raise ValueError("profile does not use the reviewed previous adapter")
    text = raw.decode("utf-8")
    decoder = json.JSONDecoder()
    def span(start, name):
        pos = start
        while text[pos].isspace():
            pos += 1
        if text[pos] != "{":
            raise ValueError("expected a JSON object")
        pos += 1
        while True:
            while text[pos].isspace() or text[pos] == ",":
                pos += 1
            if text[pos] == "}":
                raise ValueError("missing protected profile member")
            key, pos = decoder.raw_decode(text, pos)
            while text[pos].isspace():
                pos += 1
            if text[pos] != ":":
                raise ValueError("invalid JSON member")
            pos += 1
            while text[pos].isspace():
                pos += 1
            begin = pos
            _, pos = decoder.raw_decode(text, pos)
            if key == name:
                return begin, pos
    owner_start, _ = span(0, "owner")
    begin, end = span(owner_start, "ahap_script")
    result = (text[:begin] + json.dumps(replacement) + text[end:]).encode("utf-8")
    expected = copy.deepcopy(before)
    expected["owner"]["ahap_script"] = replacement
    if strict_json(result) != expected or len(result) > 16384:
        raise ValueError("profile migration changes protected fields or exceeds native limit")
    return result


def protected_profile(path):
    path = private_file(path)
    private_directory(path.parent)
    raw = path.read_bytes()
    if len(raw) > 16384:
        raise ValueError("protected profile exceeds native limit")
    profile = strict_json(raw)
    for key in ("database", "gate"):
        if private_file(profile[key]).parent != path.parent:
            raise ValueError("profile must be a sibling of its existing database and gate")
    return profile, raw


def adapter_source(manifest, kind):
    provenance = manifest.get("component_provenance", {})
    source = provenance.get(kind + "_source_commit")
    if source is None and not provenance:
        source = manifest.get("source_commit")
    if source is None and kind == "zcode":
        source = provenance.get("unchanged_source_commit")
    if source is None and kind == "opencode" and (
            manifest.get("build_inputs", {}).get("source_commit_role") ==
            "targeted OpenCode AHAP runner replacement; core and non-OpenCode adapters remain pinned to the prior verified artifact"):
        source = manifest.get("source_commit")
    if not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("installed adapter has no exact component provenance: " + kind)
    return source


def compile_typescript(repo, output, source, base):
    """Compile the exact clean workspace once for adapters and internal companions."""
    if (subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() != source
            or subprocess.check_output(["git", "status", "--porcelain"], cwd=repo, text=True).strip()):
        raise ValueError("TypeScript compilation requires the exact clean source commit")
    node = canonical(base["node"])
    if digest(node) != base["sha256"]["node"]:
        raise ValueError("pinned node changed before adapter build")
    builder_path = repo / "deploy/fleet/build-v1-core.py"
    builder_hash = digest(builder_path)
    committed = subprocess.check_output(["git", "show", source + ":deploy/fleet/build-v1-core.py"], cwd=repo)
    if hashlib.sha256(committed).hexdigest() != builder_hash:
        raise ValueError("adapter bundler is not from the clean source commit")
    loader = importlib.machinery.SourceFileLoader("reviewed_v1_bundler", str(builder_path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    builder = importlib.util.module_from_spec(spec)
    loader.exec_module(builder)
    scratch_parent = repo / ".tmp"
    subprocess.run(["git", "check-ignore", "--quiet", "--", ".tmp/process-leases-adapters-probe"],
                   cwd=repo, check=True)
    scratch_parent.mkdir(mode=0o700, exist_ok=True)
    canonical(scratch_parent)
    scratch = Path(tempfile.mkdtemp(prefix="process-leases-adapters-", dir=scratch_parent))
    package = scratch / "node_modules/agent-resume-mcp"
    package.mkdir(mode=0o700, parents=True)
    create(package / "package.json", (repo / "packages/agent-resume/package.json").read_bytes())
    tsconfig = {"extends": str(repo / "tsconfig.json"), "compilerOptions": {
        "outDir": str(scratch / "compiled"), "baseUrl": str(repo),
        "paths": {"agent-resume-mcp": [str(package / "dist/index.d.ts")]}}}
    create(scratch / "tsconfig.json", encoded(tsconfig))
    tsc = repo / "node_modules/typescript/bin/tsc"
    commands = [
        [str(node), str(tsc), "-p", str(repo / "packages/agent-resume/tsconfig.json"),
         "--outDir", str(package / "dist")],
        [str(node), str(tsc), "-p", str(scratch / "tsconfig.json")],
    ]
    with (output / "adapter-build.log").open("xb") as log:
        os.chmod(output / "adapter-build.log", 0o600)
        for argv in commands:
            subprocess.run(argv, cwd=repo, env={"PATH": os.defpath}, check=True,
                           stdout=log, stderr=subprocess.STDOUT, timeout=180)
    if (subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() != source
            or subprocess.check_output(["git", "status", "--porcelain"], cwd=repo, text=True).strip()):
        raise ValueError("source changed during TypeScript compilation")
    return {"node": node, "builder": builder, "builder_path": builder_path,
            "builder_hash": builder_hash, "scratch": scratch, "compiled": scratch / "compiled",
            "commands": commands, "log": output / "adapter-build.log"}


def bundle_adapters(repo, output, source, base, kinds, compilation=None):
    """Reuse fresh workspace compilation and the checked-in V1 adapter bundler."""
    build = compilation or compile_typescript(repo, output, source, base)
    node, builder = build["node"], build["builder"]
    scratch, builder_path, builder_hash = build["scratch"], build["builder_path"], build["builder_hash"]
    bundles = scratch / "bundles"
    bundles.mkdir(mode=0o700)
    with build["log"].open("ab") as log:
        entries = {kind: digest(scratch / "compiled" / ("ahap-" + kind + "-runner.js"))
                   for kind in builder.RUNNERS}
        subprocess.run([str(node), "--input-type=module", "--eval", builder.BUNDLE,
                        str(scratch / "compiled"), str(bundles)], cwd=repo,
                       env={"PATH": os.defpath}, check=True, stdout=log,
                       stderr=subprocess.STDOUT, timeout=180)
    expected = {bundles / ("ahap-" + kind + "-runner.mjs") for kind in builder.RUNNERS}
    if set(bundles.iterdir()) != expected or digest(builder_path) != builder_hash:
        raise ValueError("unexpected or changed adapter build input")
    for kind in builder.RUNNERS:
        if digest(scratch / "compiled" / ("ahap-" + kind + "-runner.js")) != entries[kind]:
            raise ValueError("compiled entrypoint changed during bundling")
    result = {}
    for kind in sorted(kinds):
        path = output / "fixture" / ("ahap-" + kind + "-runner.mjs")
        create(path, (bundles / path.name).read_bytes(), 0o400)
        subprocess.run([str(node), "--check", str(path)], env={"PATH": os.defpath}, check=True, timeout=30)
        result[kind] = {"previous_path": base["adapters"][kind],
                        "previous_sha256": base["sha256"]["adapters"][kind],
                        "previous_source_commit": adapter_source(base, kind),
                        "path": str(path), "sha256": digest(path), "source_commit": source,
                        "compiled_entrypoint_sha256": entries[kind]}
    return result, {"source_commit": source, "bundler_sha256": builder_hash, "compile_argv": build["commands"]}


def bundle_process_remote_bridge(repo, output, source, base, compilation=None):
    """A single dependency-closed ESM companion, never a mutable dist entrypoint."""
    source_path = "src/herder-process-remote-bridge.ts"
    source_file = canonical(repo / source_path)
    source_hash = digest(source_file)
    committed = subprocess.check_output(["git", "show", source + ":" + source_path], cwd=repo)
    if hashlib.sha256(committed).hexdigest() != source_hash:
        raise ValueError("remote process bridge is not from the clean source commit")
    build = compilation or compile_typescript(repo, output, source, base)
    builder, node = build["builder"], build["node"]
    if not isinstance(getattr(builder, "BUNDLE_ENTRY", None), str):
        raise ValueError("source has no reviewed single-entry bundler")
    compiled = build["compiled"] / "herder-process-remote-bridge.js"
    compiled_hash = digest(compiled)
    bundles = build["scratch"] / "process-remote-bundle"
    bundles.mkdir(mode=0o700)
    bundled = bundles / "herder-process-remote-bridge.mjs"
    with build["log"].open("ab") as log:
        subprocess.run([str(node), "--input-type=module", "--eval", builder.BUNDLE_ENTRY,
                        str(compiled), str(bundled)], cwd=repo, env={"PATH": os.defpath}, check=True,
                       stdout=log, stderr=subprocess.STDOUT, timeout=180)
    if (set(bundles.iterdir()) != {bundled} or digest(compiled) != compiled_hash
            or digest(source_file) != source_hash or digest(build["builder_path"]) != build["builder_hash"]
            or digest(node) != base["sha256"]["node"]):
        raise ValueError("remote process bridge build input changed")
    shipped = output / "fixture/herder-process-remote-bridge.mjs"
    create(shipped, bundled.read_bytes(), 0o400)
    subprocess.run([str(node), "--check", str(shipped)], env={"PATH": os.defpath}, check=True, timeout=30)
    evidence = {"version": 1, "source_commit": source, "source_path": source_path,
                "source_sha256": source_hash, "compiled_entrypoint_sha256": compiled_hash,
                "bundler_sha256": build["builder_hash"], "compile_argv": build["commands"]}
    return {"path": str(shipped), "sha256": digest(shipped), "build": evidence}


def stage_adapter_migration(base, manifest, selection, selector, output, source, adapters, build):
    """Stage bytes only; protected authority directories are never written here."""
    if not adapters or not set(adapters) <= ADAPTER_UPDATES:
        raise ValueError("only explicit opencode/zcode adapter updates are supported")
    payload_dir = output / "profile-payloads"
    payload_dir.mkdir(mode=0o700)
    profiles = []
    all_hashes = {}
    for path in selection["profiles"]:
        path = private_file(path)
        all_hashes[str(path)] = digest(path)
        profile = read_json(path)
        kind = profile["owner"]["kind"]
        if kind not in adapters:
            continue
        profile, raw = protected_profile(path)
        payload = profile_payload(raw, base["adapters"][kind], adapters[kind]["path"])
        after_hash = hashlib.sha256(payload).hexdigest()
        target = path.parent / ("profile-process-leases-" + source[:12] + "-" + after_hash[:20] + ".json")
        if os.path.lexists(target):
            raise FileExistsError("new protected profile destination already exists")
        staged = payload_dir / (after_hash + ".json")
        if not staged.exists():
            create(staged, payload, 0o400)
        profiles.append({"kind": kind, "previous_path": str(path), "previous_sha256": digest(path),
                         "path": str(target), "sha256": after_hash,
                         "payload": str(staged), "payload_sha256": digest(staged)})
    if {row["kind"] for row in profiles} != set(adapters):
        raise ValueError("every reviewed adapter update must have an exact selected profile")
    migration = {"schema": 1, "type": "herder-ahap-profile-rebind", "source_commit": source,
                 "base_selector": str(selector), "base_selector_sha256": digest(selector),
                 "base_manifest": selection["manifest"], "base_manifest_sha256": selection["manifest_sha256"],
                 "adapters": adapters, "profiles": profiles, "profile_sha256": all_hashes,
                 "build": build}
    path = output / "adapter-migration.json"
    create(path, encoded(migration), 0o400)
    manifest["adapter_migration"] = str(path)
    manifest["sha256"]["adapter_migration"] = digest(path)
    for kind, item in adapters.items():
        manifest["adapters"][kind] = item["path"]
        manifest["sha256"]["adapters"][kind] = item["sha256"]
        manifest["component_provenance"][kind + "_source_commit"] = source
        manifest["build_inputs"].setdefault("compiled_entrypoint_sha256", {})[kind] = item["compiled_entrypoint_sha256"]
    if "opencode" in adapters:
        manifest["adapter"] = adapters["opencode"]["path"]
        manifest["sha256"]["adapter"] = adapters["opencode"]["sha256"]
    manifest["process_leases_build"]["unchanged_components"].remove("adapters")
    manifest["process_leases_build"]["unchanged_adapter_kinds"] = sorted(set(base["adapters"]) - set(adapters))
    manifest["composition"]["process_leases"]["scope"] = (
        "native core and selected AHAP adapters updated; profile copies change only owner.ahap_script; authority retained")
    manifest["build_inputs"]["source_commit_role"] = "clean native core and explicitly reviewed adapters; all other pins retained"
    payload_dir.chmod(0o500)
    return migration


def adapter_transition(before, after):
    """Admit exactly the typed manifest transition, never a generic bypass."""
    migration = None
    if "adapter_migration" in after:
        path = private_file(after["adapter_migration"])
        if digest(path) != after["sha256"].get("adapter_migration"):
            raise ValueError("adapter migration digest mismatch")
        migration = strict_json(path.read_bytes())
        fields = {"schema", "type", "source_commit", "base_selector", "base_selector_sha256",
                  "base_manifest", "base_manifest_sha256", "adapters", "profiles", "profile_sha256", "build"}
        if (set(migration) != fields or migration["schema"] != 1
                or migration["type"] != "herder-ahap-profile-rebind"
                or migration["source_commit"] != after.get("process_leases_build", {}).get("source_commit")
                or migration["source_commit"] != after.get("source_commit")
                or migration["source_commit"] != after.get("source_sha")
                or not isinstance(migration["source_commit"], str)
                or not re.fullmatch(r"[a-f0-9]{40}", migration["source_commit"])):
            raise ValueError("invalid typed adapter migration")
        if (digest(private_file(migration["base_manifest"])) != migration["base_manifest_sha256"]
                or read_json(migration["base_manifest"]) != before):
            raise ValueError("adapter migration baseline mismatch")
        updates = migration["adapters"]
        if not isinstance(updates, dict) or not updates or not set(updates) <= ADAPTER_UPDATES:
            raise ValueError("unsupported adapter migration kind")
        if not isinstance(migration["profiles"], list) or not migration["profiles"]:
            raise ValueError("adapter migration has no profile transition")
        build = migration["build"]
        if (not isinstance(build, dict) or set(build) != {"source_commit", "bundler_sha256", "compile_argv"}
                or build["source_commit"] != migration["source_commit"]
                or not re.fullmatch(r"[a-f0-9]{64}", build["bundler_sha256"])
                or not isinstance(build["compile_argv"], list) or len(build["compile_argv"]) != 2
                or any(not isinstance(argv, list) or not argv or any(not isinstance(v, str) for v in argv)
                       for argv in build["compile_argv"])):
            raise ValueError("invalid adapter build provenance")
        for kind, item in updates.items():
            if set(item) != {"previous_path", "previous_sha256", "previous_source_commit", "path", "sha256",
                             "source_commit", "compiled_entrypoint_sha256"}:
                raise ValueError("unexpected adapter transition fields")
            if (item["previous_path"] != before["adapters"][kind]
                    or item["previous_sha256"] != before["sha256"]["adapters"][kind]
                    or item["previous_source_commit"] != adapter_source(before, kind)
                    or item["path"] != after["adapters"][kind]
                    or item["sha256"] != after["sha256"]["adapters"][kind]
                    or item["source_commit"] != migration["source_commit"]
                    or after["component_provenance"].get(kind + "_source_commit") != item["source_commit"]
                    or after.get("build_inputs", {}).get("compiled_entrypoint_sha256", {}).get(kind) != item["compiled_entrypoint_sha256"]
                    or not re.fullmatch(r"[a-f0-9]{64}", item["compiled_entrypoint_sha256"])):
                raise ValueError("adapter transition does not match exact component pins")
            if (digest(canonical(item["previous_path"])) != item["previous_sha256"]
                    or digest(private_file(item["path"])) != item["sha256"]):
                raise ValueError("adapter transition artifact changed")
    updates = migration["adapters"] if migration else {}
    if set(before["adapters"]) != set(after["adapters"]):
        raise ValueError("adapter kind set changed")
    for kind in before["adapters"]:
        if kind not in updates and (before["adapters"][kind] != after["adapters"][kind]
                or before["sha256"]["adapters"][kind] != after["sha256"]["adapters"][kind]):
            raise ValueError("unreviewed adapter replacement: " + kind)
    if "opencode" in updates:
        if after.get("adapter") != after["adapters"]["opencode"] or after["sha256"].get("adapter") != after["sha256"]["adapters"]["opencode"]:
            raise ValueError("OpenCode compatibility alias does not match the reviewed adapter")
    elif before.get("adapter") != after.get("adapter") or before["sha256"].get("adapter") != after["sha256"].get("adapter"):
        raise ValueError("unreviewed adapter alias replacement")
    return migration


def profile_transition(old, new, before, after, *, installed=False):
    migration = adapter_transition(before, after)
    expected = copy.deepcopy(old)
    expected.update(manifest=new["manifest"], manifest_sha256=new["manifest_sha256"])
    if migration is None:
        if expected != new:
            raise ValueError("unreviewed trusted profile selection change")
        return None
    snapshots = migration["profile_sha256"]
    if not isinstance(snapshots, dict) or set(snapshots) != set(old["profiles"]):
        raise ValueError("adapter migration profile snapshot is incomplete")
    for path, value in snapshots.items():
        if digest(private_file(path)) != value:
            raise ValueError("previous protected profile changed")
    rows = migration["profiles"]
    by_old = {}
    destinations = set()
    bundle = Path(after["adapter_migration"]).parent
    for item in rows:
        if set(item) != {"kind", "previous_path", "previous_sha256", "path", "sha256", "payload", "payload_sha256"}:
            raise ValueError("unexpected profile transition fields")
        previous, target = private_file(item["previous_path"]), planned_path(item["path"])
        if (str(previous) in by_old or target in destinations or target == previous
                or previous.parent != target.parent or str(previous) not in snapshots
                or item["previous_sha256"] != snapshots[str(previous)]):
            raise ValueError("profile migration must use distinct siblings in the existing authority")
        profile, raw = protected_profile(previous)
        kind = profile["owner"]["kind"]
        if kind != item["kind"] or kind not in migration["adapters"]:
            raise ValueError("profile kind does not match reviewed adapter")
        payload = private_file(item["payload"])
        if payload.parent != bundle / "profile-payloads":
            raise ValueError("profile payload is not inside the candidate")
        wanted = profile_payload(raw, before["adapters"][kind], after["adapters"][kind])
        if (payload.read_bytes() != wanted or digest(payload) != item["payload_sha256"]
                or item["sha256"] != item["payload_sha256"]):
            raise ValueError("profile migration changes bytes outside owner.ahap_script")
        if installed:
            if private_file(target).read_bytes() != wanted:
                raise ValueError("installed sibling profile differs from the reviewed payload")
        elif os.path.lexists(target):
            raise FileExistsError("new protected profile destination already exists")
        by_old[str(previous)] = item
        destinations.add(target)
    affected = {path for path in old["profiles"] if read_json(path)["owner"]["kind"] in migration["adapters"]}
    if set(by_old) != affected or {item["kind"] for item in rows} != set(migration["adapters"]):
        raise ValueError("adapter migration omits or adds selected profile bindings")
    expected["profiles"] = [by_old[path]["path"] if path in by_old else path for path in old["profiles"]]
    if expected != new:
        raise ValueError("selector differs from the exact reviewed profile transition")
    return migration


def check_candidate(selector, launcher):
    selection = read_json(selector)
    manifest = read_json(selection["manifest"])
    if "adapter_migration" not in manifest:
        return check_selector(selector, launcher)
    bundle = Path(selector).parent
    receipt = read_json(bundle / "process-leases-build.json")
    baseline = read_json(receipt["base_selector"])
    if (digest(private_file(receipt["base_selector"])) != receipt["base_selector_sha256"]
            or digest(private_file(selector)) != receipt["candidate_selector_sha256"]
            or digest(private_file(selection["manifest"])) != receipt["candidate_manifest_sha256"]
            or selection["manifest_sha256"] != receipt["candidate_manifest_sha256"]):
        raise ValueError("candidate or baseline changed since adapter build")
    migration = profile_transition(baseline, selection, read_json(baseline["manifest"]), manifest)
    if (migration["base_selector"] != receipt["base_selector"]
            or migration["base_selector_sha256"] != receipt["base_selector_sha256"]
            or migration["base_manifest"] != baseline["manifest"]
            or migration["base_manifest_sha256"] != baseline["manifest_sha256"]
            or migration["profile_sha256"] != receipt["profile_sha256"]):
        raise ValueError("adapter migration does not belong to this release build")
    projected = copy.deepcopy(selection)
    payloads = {row["path"]: row["payload"] for row in migration["profiles"]}
    projected["profiles"] = [payloads.get(path, path) for path in selection["profiles"]]
    staged = bundle / "check-selector.json"
    if (digest(private_file(staged)) != receipt["staged_selector_sha256"] or read_json(staged) != projected):
        raise ValueError("staged selector does not match the exact reviewed payloads")
    checked = check_selector(staged, launcher)
    return {**checked, "selector": str(selector), "selector_sha256": digest(selector),
            "adapter_migration_sha256": manifest["sha256"]["adapter_migration"],
            "profile_validation": "staged_payloads_not_installed"}


def build(args):
    repo = canonical(args.repo)
    selector = private_file(args.selector)
    before = digest(selector)
    selection = read_json(selector)
    base_path = private_file(selection["manifest"])
    base = read_json(base_path)
    reject_unmigrated_core_descriptors(base)
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
    updates = getattr(args, "adapter_update", [])
    if len(set(updates)) != len(updates) or not set(updates) <= ADAPTER_UPDATES:
        raise ValueError("select each reviewed adapter update once")
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
    binaries = [("core", "herder_native_stdio"), ("process_worker", "herder_process_worker")]
    if (repo / "crates/herder/src/bin/herder_resource_bridge.rs").is_file():
        argv.extend(["--bin", "herder_resource_bridge"])
        binaries.append(("resource_bridge", "herder_resource_bridge"))
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
    for key, name in binaries:
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
    wait_reader = repo / "deploy/fleet/process-leases-wait-status.py"
    if wait_reader.exists():
        create(fixture / "process-wait-status.py", wait_reader.read_bytes(), 0o500)
        hashes["process_wait_reader"] = digest(fixture / "process-wait-status.py")
    remote_source = repo / "src/herder-process-remote-bridge.ts"
    compilation = compile_typescript(repo, output, sha, base) if updates or remote_source.is_file() else None
    remote_bridge = None
    if remote_source.is_file():
        remote_bridge = bundle_process_remote_bridge(repo, output, sha, base, compilation)
        hashes["process_remote_bridge"] = remote_bridge["sha256"]
    manifest = compose_manifest(base, output, sha, base_path, selection["manifest_sha256"], hashes, argv)
    if remote_bridge:
        manifest["build_inputs"]["process_remote_bridge"] = remote_bridge["build"]
    migration = None
    if updates:
        adapters, adapter_build = bundle_adapters(repo, output, sha, base, updates, compilation)
        migration = stage_adapter_migration(base, manifest, selection, selector, output, sha, adapters, adapter_build)
    if (git("rev-parse", "HEAD") != sha or git("status", "--porcelain")
            or digest(selector) != before or digest(base_path) != selection["manifest_sha256"]
            or any(digest(private_file(path)) != value for path, value in profile_hashes.items())):
        raise ValueError("source or installed baseline changed during candidate composition")
    create(output / "manifest.json", encoded(manifest), 0o400)
    candidate_selection = copy.deepcopy(selection)
    candidate_selection.update(manifest=str(output / "manifest.json"), manifest_sha256=digest(output / "manifest.json"))
    if migration:
        rebound = {item["previous_path"]: item["path"] for item in migration["profiles"]}
        candidate_selection["profiles"] = [rebound.get(path, path) for path in selection["profiles"]]
    create(output / "selector.json", encoded(candidate_selection), 0o400)
    build_receipt = {"source_commit": sha, "base_selector": str(selector),
                     "base_selector_sha256": before, "base_manifest_sha256": selection["manifest_sha256"],
                     "launcher_sha256": digest(fixture / "launch-v1-core.py"), "build_argv": argv,
                     "profile_sha256": profile_hashes, "process_config_sha256": hashes["process_config"],
                     "candidate_selector_sha256": digest(output / "selector.json"),
                     "candidate_manifest_sha256": digest(output / "manifest.json")}
    if migration:
        staged = copy.deepcopy(candidate_selection)
        payloads = {item["path"]: item["payload"] for item in migration["profiles"]}
        staged["profiles"] = [payloads.get(path, path) for path in staged["profiles"]]
        create(output / "check-selector.json", encoded(staged), 0o400)
        build_receipt.update(staged_selector_sha256=digest(output / "check-selector.json"),
                             adapter_migration_sha256=manifest["sha256"]["adapter_migration"])
    create(output / "process-leases-build.json", encoded(build_receipt), 0o400)
    result = check_candidate(output / "selector.json", fixture / "launch-v1-core.py")
    fixture.chmod(0o500)
    output.chmod(0o500)
    return {**result, "status": "candidate_verified_not_installed", "build_log": str(output / "build.log")}


def require_mutation_guard(guard, selector, operation):
    if guard is None or not callable(getattr(guard, "assert_mutation_allowed", None)):
        raise RuntimeError("configuration changes require process-leases-rollout.py and its held release guard")
    guard.assert_mutation_allowed(Path(selector), operation)


def install(args, *, guard=None):
    require_mutation_guard(guard, args.selector, "install")
    candidate = private_file(args.candidate)
    bundle = candidate.parent
    candidate_launcher = bundle / "fixture/launch-v1-core.py"
    checked = check_candidate(candidate, candidate_launcher)
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
        old_manifest, candidate_manifest = read_json(old["manifest"]), read_json(new["manifest"])
        migration = profile_transition(old, new, old_manifest, candidate_manifest)
        if set(build_receipt["profile_sha256"]) != set(old["profiles"]):
            raise ValueError("candidate profile snapshot is incomplete")
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
            "profiles_preserved": migration is None, "authority_preserved": True,
            "previous_profiles_unchanged": True, "databases_modified": False}
        if migration:
            receipt["adapter_migration_sha256"] = candidate_manifest["sha256"]["adapter_migration"]
            receipt["profile_creation_intent"] = migration["profiles"]
        receipt_path = backup / "receipt.json"
        create(receipt_path, encoded(receipt))
        require_mutation_guard(guard, selector, "install")
        receipt["state_roots"] = state_roots(config, provision=True)
        receipt["status"] = "state_prepared"
        replace(receipt_path, encoded(receipt), digest(receipt_path), 0o600)
        if migration:
            # The durable intent above survives a partial creation. Never
            # overwrite or adopt pre-existing siblings on a repeated attempt.
            for item in migration["profiles"]:
                require_mutation_guard(guard, selector, "install")
                if digest(private_file(item["previous_path"])) != item["previous_sha256"]:
                    raise ValueError("previous profile changed before sibling creation")
                create(Path(item["path"]), private_file(item["payload"]).read_bytes(), 0o400)
                sync_dir(Path(item["path"]).parent)
            profile_transition(old, new, old_manifest, candidate_manifest, installed=True)
            check_selector(candidate, candidate_launcher)
            receipt["status"] = "profiles_prepared"
            replace(receipt_path, encoded(receipt), digest(receipt_path), 0o600)
        require_mutation_guard(guard, selector, "install")
        replace(launcher, candidate_launcher.read_bytes(), old_launcher_hash, receipt["launcher_mode"])
        require_mutation_guard(guard, selector, "install")
        replace(selector, candidate.read_bytes(), old_hash, receipt["selector_mode"])
        checked = check_selector(selector, launcher)
        receipt["status"] = "configured_pending_restart"
        replace(receipt_path, encoded(receipt), digest(receipt_path), 0o600)
        return {**checked, "status": receipt["status"], "rollback_receipt": str(receipt_path),
                "restart_required": True, "child_ref": "AgentHerder", "databases_modified": False}


def rollback(args, *, guard=None):
    receipt_path = private_file(args.receipt)
    r = read_json(receipt_path)
    selector, launcher = private_file(r["selector"]), private_file(r["launcher"])
    require_mutation_guard(guard, selector, "rollback")
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
        require_mutation_guard(guard, selector, "rollback")
        if current_s != r["selector_before_sha256"]:
            replace(selector, old_selector.read_bytes(), current_s, r["selector_mode"])
        require_mutation_guard(guard, selector, "rollback")
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
    b.add_argument("--adapter-update", action="append", default=[], choices=sorted(ADAPTER_UPDATES),
                   help="explicit reviewed AHAP update; may be repeated once per kind")
    c = sub.add_parser("check")
    c.add_argument("--selector", required=True, type=Path)
    c.add_argument("--launcher", required=True, type=Path)
    c.add_argument("--staged-profiles", action="store_true",
                   help="validate the exact candidate migration without creating authority siblings")
    i = sub.add_parser("install")
    for name in ("candidate", "selector", "launcher", "backup"):
        i.add_argument("--" + name, required=True, type=Path)
    i.add_argument("--expected-selector-sha256", required=True)
    r = sub.add_parser("rollback")
    r.add_argument("--receipt", required=True, type=Path)
    args = p.parse_args()
    try:
        result = {"build": build, "install": install, "rollback": rollback,
                  "check": lambda a: (check_candidate(a.selector, a.launcher) if a.staged_profiles
                                      else check_selector(a.selector, a.launcher))}[args.command](args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as e:
        print(json.dumps({"status": "failed", "error_type": type(e).__name__, "error": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
