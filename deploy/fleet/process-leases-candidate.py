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
import ipaddress
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
from urllib.parse import urlsplit

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
    p = Path(path)
    if not p.is_absolute() or p.is_symlink():
        raise ValueError("expected an absolute non-symlink private file: " + str(p))
    # Installed authority profiles may live below a private symlinked artifact
    # directory (the final file itself must still be a regular file).  Resolve
    # that stable directory indirection before checking ownership and mode.
    p = p.resolve(strict=True)
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


def canonical_migration_identity(manifest):
    """Use the reviewed source validator, independently of the supplied launcher."""
    if "canonical_migration" not in manifest:
        return None
    loader = importlib.machinery.SourceFileLoader(
        "process_leases_trusted_migration_launcher", str(Path(__file__).with_name("launch-v1-core.py")))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module.migration_binding(manifest)


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
    if "native_profile_migration" in manifest or "adapter_migration" in manifest:
        expected_argv = [manifest["compat"]]
        for path in selection["profiles"]:
            expected_argv.extend(["--trusted-owner-profile", path])
        if argv != expected_argv:
            raise ValueError("launcher does not pass the exact reviewed owner profiles")
    migration = canonical_migration_identity(manifest)
    expected_epoch = migration["epoch"] if migration is not None else None
    if env.get("AGENT_HERDER_MIGRATION_EPOCH") != expected_epoch or receipt.get("canonical_migration") != migration:
        raise ValueError("launcher does not pass the pinned canonical migration epoch and receipt")
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
            "canonical_migration": migration,
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
    m.pop("native_profile_migration", None)
    m["sha256"].pop("native_profile_migration", None)
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


ADAPTER_UPDATES = {"opencode", "zcode", "codex"}
BROWSER_KINDS = {"chatgpt", "zai"}
NATIVE_PROFILE_UPDATES = {"opencode"} | BROWSER_KINDS


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


def member_span(text, start, name, *, remove=False):
    """Locate a value, or the whole member and one separator, in strict JSON."""
    decoder = json.JSONDecoder()
    skip = json.decoder.WHITESPACE.match
    start = skip(text, start).end()
    if text[start] != "{":
        raise ValueError("expected a protected profile object")
    pos = skip(text, start + 1).end()
    comma = None
    while text[pos] != "}":
        key, end = decoder.raw_decode(text, pos)
        colon = skip(text, end).end()
        begin = skip(text, colon + 1).end()
        _, end = decoder.raw_decode(text, begin)
        sep = skip(text, end).end()
        if key == name:
            if not remove:
                return begin, end
            if comma is None:
                return start + 1, sep + 1 if text[sep] == "," else end
            return comma, end
        if text[sep] != ",":
            break
        comma = sep
        pos = skip(text, sep + 1).end()
    raise ValueError("missing protected profile member")


def edit_owner(raw, replacements, *, remove_script=False):
    expected = strict_json(raw)
    text = raw.decode("utf-8")
    owner_start, _ = member_span(text, 0, "owner")
    edits = []
    for key, value in replacements.items():
        begin, end = member_span(text, owner_start, key)
        edits.append((begin, end, json.dumps(value, sort_keys=True)))
        expected["owner"][key] = value
    if remove_script:
        begin, end = member_span(text, owner_start, "ahap_script", remove=True)
        edits.append((begin, end, ""))
        del expected["owner"]["ahap_script"]
    for begin, end, replacement in sorted(edits, reverse=True):
        text = text[:begin] + replacement + text[end:]
    payload = text.encode("utf-8")
    if len(payload) > 16384 or strict_json(payload) != expected:
        raise ValueError("profile migration changes protected fields or exceeds native limit")
    return payload


def profile_payload(raw, previous, replacement):
    if strict_json(raw)["owner"]["ahap_script"] != previous:
        raise ValueError("profile does not use the reviewed previous adapter")
    return edit_owner(raw, {"ahap_script": replacement})


def native_profile_payload(raw):
    """Remove only the legacy OpenCode runner member from a trusted profile."""
    owner = strict_json(raw)["owner"]
    if owner.get("kind") != "opencode" or not isinstance(owner.get("ahap_script"), str):
        raise ValueError("profile is not a legacy OpenCode owner profile")
    if not isinstance(owner.get("ahap_base_url"), str) or not owner["ahap_base_url"].strip():
        raise ValueError("native OpenCode profile requires an endpoint")
    return edit_owner(raw, {}, remove_script=True)


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


def authority_parent(path, profile):
    # Rust compares the lexical parents, even for a protected directory alias.
    parent = Path(profile["database"]).parent
    if parent != Path(profile["gate"]).parent or parent.resolve(strict=True) != path.parent:
        raise ValueError("profile requires one existing authority directory")
    return parent


def adapter_source(manifest, kind):
    provenance = manifest.get("component_provenance", {})
    source = provenance.get(kind + "_source_commit")
    if source is None and not provenance:
        source = manifest.get("source_commit")
    if source is None and kind in {"zcode", "codex"}:
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


def retained_remote_wrapper(owner, manifest):
    kind = owner["kind"]
    wrappers = manifest.get("remote_ahap_wrappers", [])
    fields = {"node", "instance", "kind", "script", "script_sha256", "config_sha256"}
    if not isinstance(wrappers, list) or any(not isinstance(item, dict) or set(item) != fields for item in wrappers):
        raise ValueError("invalid retained remote wrapper")
    identity = (owner.get("node"), owner.get("instance"), kind)
    matches = [item for item in wrappers if (item["node"], item["instance"], item["kind"]) == identity]
    if not matches:
        return False
    if len(matches) != 1 or matches[0]["script"] != owner.get("ahap_script"):
        raise ValueError("profile is neither the reviewed local adapter nor an exact retained remote wrapper")
    wrapper = matches[0]
    script = canonical(wrapper["script"])
    companion = private_file(str(script) + ".json")
    config = strict_json(companion.read_bytes())
    if (digest(script) != wrapper["script_sha256"] or digest(companion) != wrapper["config_sha256"]
            or config.get("nodeRef") != owner.get("node") or config.get("kind") != kind):
        raise ValueError("retained remote wrapper identity or digest changed")
    return True


def uses_reviewed_local_adapter(profile, manifest, updates):
    """Preserve an exact per-instance remote wrapper when its local kind updates."""
    owner = profile["owner"]
    kind = owner["kind"]
    if kind not in updates or retained_remote_wrapper(owner, manifest):
        return False
    if owner.get("ahap_script") == manifest["adapters"][kind]:
        return True
    if kind == "opencode" and owner.get("ahap_script") is None and owner.get("ahap_base_url"):
        return False
    raise ValueError("profile is neither the reviewed local adapter nor an exact retained remote wrapper")


def stage_adapter_migration(base, manifest, selection, selector, output, source, adapters, build):
    """Stage bytes only; protected authority directories are never written here."""
    if not adapters or not set(adapters) <= ADAPTER_UPDATES:
        raise ValueError("only explicit opencode/zcode/codex adapter updates are supported")
    payload_dir = output / "profile-payloads"
    payload_dir.mkdir(mode=0o700)
    profiles = []
    all_hashes, native = native_profile_plan(base, manifest, selection, output, source, [], {})
    for selected in selection["profiles"]:
        path = private_file(selected)
        profile = strict_json(path.read_bytes())
        kind = profile["owner"]["kind"]
        if not uses_reviewed_local_adapter(profile, base, adapters):
            continue
        profile, raw = protected_profile(path)
        payload = profile_payload(raw, base["adapters"][kind], adapters[kind]["path"])
        after_hash = hashlib.sha256(payload).hexdigest()
        parent = authority_parent(path, profile)
        target = parent / ("profile-process-leases-" + source[:12] + "-" + after_hash[:20] + ".json")
        if os.path.lexists(target):
            raise FileExistsError("new protected profile destination already exists")
        staged = payload_dir / (after_hash + ".json")
        if not staged.exists():
            create(staged, payload, 0o400)
        profiles.append({"kind": kind, "previous_path": selected, "previous_sha256": all_hashes[selected],
                         "path": str(target), "sha256": after_hash,
                         "payload": str(staged), "payload_sha256": digest(staged)})
    if {row["kind"] for row in profiles} != set(adapters):
        raise ValueError("every reviewed adapter update must have an exact selected profile")
    profiles.extend(stage_native_payloads(native))
    migration = {"schema": 2 if native else 1, "type": "herder-ahap-profile-rebind", "source_commit": source,
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
        "native core and selected AHAP adapters updated; protected owner bindings retained")
    manifest["build_inputs"]["source_commit_role"] = "clean native core and explicitly reviewed adapters; all other pins retained"
    payload_dir.chmod(0o500)
    return migration


def check_codex_autopilot(config, recovery):
    if not isinstance(config, dict) or set(config) - {"state_dir", "policy_file", "holds", "judge"}:
        raise ValueError("invalid Codex autopilot profile")
    for key in ("state_dir", "policy_file"):
        if key == "state_dir" or config.get(key) is not None:
            path = config.get(key)
            if not isinstance(path, str) or not Path(path).is_absolute() or ".." in Path(path).parts:
                raise ValueError("invalid Codex autopilot state path")
    holds = config.get("holds")
    if not isinstance(holds, dict) or set(holds) != {"human_stops", "human_requests", "choices", "unfinished_sessions"}:
        raise ValueError("incomplete Codex autopilot holds")
    handoff = (recovery or {}).get("legacy_handoff")
    for key, path in holds.items():
        if not isinstance(path, str) or handoff is not None and handoff.get(key) != path:
            raise ValueError("Codex autopilot must use the installed hold registries")
        private_file(path)
    judge = config.get("judge")
    if not isinstance(judge, dict) or set(judge) - {"base_url", "model", "token_file"}:
        raise ValueError("invalid Codex autopilot judge")
    model, url = judge.get("model"), judge.get("base_url")
    if not isinstance(model, str) or not model.strip() or len(model.encode()) > 256 or not isinstance(url, str):
        raise ValueError("invalid Codex autopilot judge model or URL")
    endpoint = urlsplit(url)
    if (not endpoint.hostname or endpoint.port == 0 or endpoint.username is not None or endpoint.password is not None
            or endpoint.query or endpoint.fragment or not (
                endpoint.scheme == "https" or endpoint.scheme == "http" and endpoint.hostname in {"localhost", "127.0.0.1", "::1"})):
        raise ValueError("Codex autopilot requires an HTTPS or loopback judge")
    if judge.get("token_file") is not None:
        if not isinstance(judge["token_file"], str):
            raise ValueError("invalid Codex autopilot judge token file")
        private_file(judge["token_file"])


def check_recovery_scope(kind, handoff):
    wide = handoff.get("instance_wide", False)
    if not isinstance(wide, bool) or (wide and ("native_sessions" in handoff or "workspaces" in handoff)):
        raise ValueError("instance_wide recovery requires a boolean and a single handoff scope")
    if wide:
        return
    if "native_sessions" not in handoff and "workspaces" not in handoff:
        raise ValueError("installed recovery needs an explicit handoff scope")
    if "native_sessions" in handoff:
        ids = handoff["native_sessions"]
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 128
                or any(not isinstance(value, str) or not value.strip() for value in ids)
                or len(set(ids)) != len(ids)):
            raise ValueError("installed recovery requires an exact unique session cohort")
    if "workspaces" in handoff:
        workspaces = handoff["workspaces"]
        if kind != "codex" or not isinstance(workspaces, list) or not workspaces:
            raise ValueError("workspace recovery requires an explicit list of Codex workspaces")
        seen = set()
        for workspace in workspaces:
            if not isinstance(workspace, dict) or set(workspace) != {"cwd", "provider"}:
                raise ValueError("a recovery workspace needs exactly cwd and provider")
            cwd, provider = workspace["cwd"], workspace["provider"]
            if (not isinstance(cwd, str) or not cwd.startswith("/") or len(cwd.encode()) > 4096
                    or cwd != "/" and any(part in {"", ".", ".."} for part in cwd[1:].split("/"))
                    or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in cwd)
                    or not isinstance(provider, str) or not re.fullmatch(r"[a-zA-Z0-9._/:$-]{1,256}", provider)):
                raise ValueError("invalid recovery workspace or provider")
            key = (cwd, provider)
            if key in seen:
                raise ValueError("duplicate recovery workspace and provider")
            seen.add(key)


def recovery_profile_payload(previous, changed, *, installed=False):
    """Stage a reviewed native socket, recovery handoff, or semantic autopilot binding."""
    expected = strict_json(previous)
    actual = strict_json(changed)
    owner, new = expected["owner"], actual["owner"]
    kind = owner.get("kind")
    socket_only = False
    if kind == "codex":
        binding = owner.get("ahap_env", {})
        if not all(binding.get(key) for key in ("AHAP_CODEX_BIN", "AHAP_CODEX_CWD", "CODEX_HOME")):
            raise ValueError("Codex recovery requires the existing native instance binding")
        socket = new.get("ahap_env", {}).get("AHAP_CODEX_SOCKET")
        if not isinstance(socket, str) or not Path(socket).is_absolute() or ".." in Path(socket).parts:
            raise ValueError("Codex recovery requires the exact shared app-server socket")
        prior_socket = binding.get("AHAP_CODEX_SOCKET")
        if prior_socket not in (None, socket):
            raise ValueError("native recovery cannot change the existing Codex socket")
        socket_only = prior_socket is None and "codex_recovery" not in owner and "codex_recovery" not in new
        binding["AHAP_CODEX_SOCKET"] = socket
    elif kind == "opencode":
        if owner.get("ahap_script") is not None or not owner.get("ahap_base_url"):
            raise ValueError("OpenCode recovery requires the existing native HTTP profile")
    else:
        raise ValueError("unsupported native recovery profile kind")
    recovery = new.get(kind + "_recovery")
    recovery_changed = recovery != owner.get(kind + "_recovery")
    autopilot_changed = kind == "codex" and owner.get("codex_autopilot") != new.get("codex_autopilot")
    # A change confined to the semantic rule binding keeps the active recovery marker.
    if not socket_only and (recovery_changed or not autopilot_changed):
        if not isinstance(recovery, dict) or not isinstance(recovery.get("legacy_handoff"), dict):
            raise ValueError("installed recovery requires an explicit compatibility handoff")
        handoff = recovery["legacy_handoff"]
        check_recovery_scope(kind, handoff)
        activation = handoff.get("activation_file")
        if not isinstance(activation, str) or not Path(activation).is_absolute() or ".." in Path(activation).parts \
                or not installed and os.path.lexists(activation):
            raise ValueError("stage recovery with a fresh private activation path")
        for field in ("human_stops", "human_requests", "choices", "unfinished_sessions"):
            private_file(handoff[field])
        owner[kind + "_recovery"] = recovery
    if kind == "codex" and "codex_autopilot" in new and (autopilot_changed or recovery_changed):
        check_codex_autopilot(new["codex_autopilot"], recovery)
        owner["codex_autopilot"] = new["codex_autopilot"]
    elif autopilot_changed:
        del owner["codex_autopilot"]
    if actual != expected or len(changed) > 16384:
        raise ValueError("native recovery changes protected profile fields or exceeds the native limit")
    return changed


def native_profile_identity(owner):
    return tuple(owner.get(field) for field in ("kind", "node", "instance"))


BROWSER_SCOPE = "AHAP_BROWSER_ACCOUNT_SCOPE"
USERIO_SCOPE = "AHAP_USERIO_ACCOUNT_SCOPE"
CDP_FIELDS = {BROWSER_SCOPE, "AHAP_BROWSER_TRANSPORT", "AHAP_BROWSER_CDP_WS_URL",
              "AHAP_BROWSER_CDP_CONTEXT_ID", "AHAP_BROWSER_CDP_TARGET_ID"}
ORIGIN_PORT = "AHAP_BROWSER_CDP_ORIGIN_PORT"
EXTENSION_FIELDS = {BROWSER_SCOPE, "AHAP_BROWSER_TRANSPORT", "AHAP_BROWSER_EXTENSION_LISTEN",
                    "AHAP_BROWSER_EXTENSION_TOKEN_FILE"}
# Only transport settings understood by the legacy profile may be retired.
LEGACY_BROWSER_FIELDS = {
    "userio": {USERIO_SCOPE, "AHAP_USERIO_ENDPOINT", "AHAP_USERIO_AGENT_ID", "AHAP_USERIO_INSTANCE_ID",
               "AHAP_USERIO_ACCESS_TOKEN_FILE", "AHAP_USERIO_TOKEN_FILE", "AHAP_USERIO_CONNECTION_ID",
               "AHAP_USERIO_PRINCIPAL_ID"},
    "mac-mini": {"AHAP_BROWSER_PAGE_ID", "AGENT_HERDER_MAC_MINI_SSH_TARGET",
                 "AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT", "AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_URL"},
    "vibe": {"AHAP_BROWSER_PAGE_ID", "AHAP_BROWSER_VIBE_TARGET", "AHAP_BROWSER_VIBE_SESSION_ID",
             "AHAP_BROWSER_VIBE_RELAY_PORT", "AHAP_BROWSER_VIBE_STATE_DIR", "AGENT_HERDER_VIBE_MAC_SSH_TARGET",
             "AGENT_HERDER_VIBE_MAC_NODE_PATH", "AGENT_HERDER_VIBE_MAC_CLI_PATH", "AGENT_HERDER_VIBE_SERVER_CLI_PATH"},
}


def validate_direct_cdp(env):
    """Match the protected Rust native browser contract without contacting Chrome."""
    if (not isinstance(env, dict) or set(env) not in (CDP_FIELDS, CDP_FIELDS | {ORIGIN_PORT})
            or not all(isinstance(v, str) for v in env.values())
            or env["AHAP_BROWSER_TRANSPORT"] != "direct-cdp"
            or not re.fullmatch(r"[a-f0-9]{64}", env[BROWSER_SCOPE])):
        raise ValueError("invalid native browser binding fields or scope")
    for key in ("AHAP_BROWSER_CDP_CONTEXT_ID", "AHAP_BROWSER_CDP_TARGET_ID"):
        value = env[key]
        if not value.strip() or len(value.encode("utf-8")) > 256 or re.search(r"[\x00-\x1f\x7f-\x9f]", value):
            raise ValueError("invalid native browser context or target")
    endpoint = re.fullmatch(r"ws://(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?"
                            r"/devtools/browser/[a-zA-Z0-9_-]{1,128}", env["AHAP_BROWSER_CDP_WS_URL"])
    if not endpoint or (endpoint[1] and not 0 < int(endpoint[1]) <= 65535):
        raise ValueError("invalid loopback browser WebSocket endpoint")
    if ORIGIN_PORT in env and (not re.fullmatch(r"[0-9]{1,5}", env[ORIGIN_PORT])
                               or not 0 < int(env[ORIGIN_PORT]) <= 65535):
        raise ValueError("invalid native browser origin port")


def validate_herder_extension(env):
    if (not isinstance(env, dict) or set(env) != EXTENSION_FIELDS
            or not all(isinstance(v, str) for v in env.values())
            or env["AHAP_BROWSER_TRANSPORT"] != "herder-extension"
            or not re.fullmatch(r"[a-f0-9]{64}", env[BROWSER_SCOPE])):
        raise ValueError("invalid Herder extension binding fields or scope")
    try:
        match = re.fullmatch(r"(\[[0-9a-fA-F:]+\]|[0-9.]+):([0-9]{1,5})",
                             env["AHAP_BROWSER_EXTENSION_LISTEN"])
        if (match is None or not ipaddress.ip_address(match[1].strip("[]")).is_loopback
                or not 0 < int(match[2]) <= 65535):
            raise ValueError()
    except ValueError:
        raise ValueError("Herder extension listener must use a loopback address and a fixed port") from None
    try:
        path = private_file(env["AHAP_BROWSER_EXTENSION_TOKEN_FILE"])
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                    or info.st_nlink != 1 or info.st_size > 130):
                raise ValueError()
            token = stream.read(131)
            if len(token) > 130 or re.fullmatch(rb"[A-Za-z0-9_-]{32,128}", token.rstrip(b"\r\n")) is None:
                raise ValueError()
    except (OSError, ValueError):
        raise ValueError("invalid private Herder extension token file") from None


def validate_browser_transport(env):
    if isinstance(env, dict) and env.get("AHAP_BROWSER_TRANSPORT") == "herder-extension":
        validate_herder_extension(env)
    else:
        validate_direct_cdp(env)


def read_browser_binding(pin, bundle, kind, profile_hash):
    """Authenticate independent operator input. Receipts contain only the file pin."""
    if (not isinstance(pin, dict) or set(pin) != {"path", "sha256"}
            or not isinstance(pin["path"], str) or not isinstance(pin["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", pin["sha256"])):
        raise ValueError("invalid private browser binding pin")
    path = canonical(pin["path"])
    if path.is_relative_to(bundle):
        raise ValueError("browser binding must be independent of the candidate")
    private_directory(path.parent)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_nlink != 1 or info.st_size > 16384):
            raise ValueError("expected a private owner-controlled browser binding")
        raw = stream.read(16385)
    if len(raw) > 16384 or hashlib.sha256(raw).hexdigest() != pin["sha256"]:
        raise ValueError("private browser binding digest mismatch")
    binding = strict_json(raw)
    required = {"kind", "profile_sha256", "ahap_env"}
    if (not isinstance(binding, dict) or set(binding) not in (required, required | {"browser_recovery"})
            or binding["kind"] != kind or binding["profile_sha256"] != profile_hash):
        raise ValueError("private browser binding does not select this provider and protected profile")
    return binding


def check_browser_recovery(kind, recovery, *, installed):
    if (not isinstance(recovery, dict)
            or not isinstance(recovery.get("legacy_handoff"), dict)
            or recovery.get("runner", "mcp") != "mcp"
            or recovery.get("fallback_routes", []) != []
            or not isinstance(recovery.get("autopilot_state_dir"), str)
            or not Path(recovery["autopilot_state_dir"]).is_absolute()):
        raise ValueError("browser recovery requires a same-chat MCP profile")
    handoff = recovery["legacy_handoff"]
    check_recovery_scope(kind, handoff)
    if handoff.get("instance_wide") or "native_sessions" not in handoff or "workspaces" in handoff:
        raise ValueError("browser recovery requires an exact session handoff")
    marker = handoff.get("activation_file")
    if (not isinstance(marker, str) or not Path(marker).is_absolute()
            or ".." in Path(marker).parts or (not installed and os.path.lexists(marker))):
        raise ValueError("stage browser recovery with a fresh private activation path")
    for field in ("human_stops", "human_requests", "choices", "unfinished_sessions"):
        path = handoff.get(field)
        if not isinstance(path, str):
            raise ValueError("browser recovery requires the existing private hold files")
        private_file(path)


def browser_profile_payload(raw, owner, core, binding, *, installed=False):
    env = owner.get("ahap_env")
    if (not isinstance(env, dict) or not all(isinstance(v, str) for v in env.values())
            or owner.get("ahap_base_url") is not None):
        raise ValueError("invalid previous browser profile transport")
    legacy = owner.get("ahap_script") is not None
    transport = env.get("AHAP_BROWSER_TRANSPORT")
    if binding is not None:
        if transport in ("direct-cdp", "herder-extension"):
            old_env = env.copy()
            if legacy:
                old_env.pop("AHAP_BROWSER_PAGE_ID", None)
            validate_browser_transport(old_env)
        elif (not legacy or transport not in LEGACY_BROWSER_FIELDS
              or set(env) - LEGACY_BROWSER_FIELDS[transport] - {BROWSER_SCOPE, "AHAP_BROWSER_TRANSPORT"}):
            raise ValueError("unsupported previous browser transport or fields")
        new_env = binding["ahap_env"]
    elif transport in ("direct-cdp", "herder-extension"):
        new_env = env.copy()
        if legacy:
            new_env.pop("AHAP_BROWSER_PAGE_ID", None)  # The old runner's numeric display hint.
    else:
        raise ValueError("legacy browser transport requires a reviewed private browser binding")
    validate_browser_transport(new_env)
    scopes = [env[key] for key in (BROWSER_SCOPE, USERIO_SCOPE) if key in env]
    grants = owner.get("existing_sessions", [])
    if (not scopes or any(scope != new_env[BROWSER_SCOPE] for scope in scopes)
            or not isinstance(grants, list)
            or any(not isinstance(grant, dict) or grant.get("account_scope") != new_env[BROWSER_SCOPE]
                   for grant in grants)):
        raise ValueError("native browser scope differs from protected profile or grants")
    changes = {"executable": core}
    if new_env != env:
        changes["ahap_env"] = new_env
    payload = edit_owner(raw, changes, remove_script=legacy)
    if binding is not None and "browser_recovery" in binding:
        recovery = binding["browser_recovery"]
        check_browser_recovery(owner["kind"], recovery, installed=installed)
        updated = strict_json(payload)
        updated["owner"]["browser_recovery"] = recovery
        payload = encoded(updated)
        if len(payload) > 16384:
            raise ValueError("browser recovery exceeds the native profile limit")
    return payload


def native_profile_plan(base, manifest, selection, output, source, kinds, bindings, *,
                        recovery_profiles=(), installed=False, legacy_recovery_paths=False):
    """Derive every sibling again from the old selector and independent pins."""
    if (not isinstance(kinds, (list, set, tuple)) or not all(isinstance(k, str) for k in kinds)
            or len(set(kinds)) != len(kinds) or not set(kinds) <= NATIVE_PROFILE_UPDATES
            or not isinstance(bindings, dict) or not set(bindings) <= set(kinds) & BROWSER_KINDS):
        raise ValueError("invalid native profile selection or browser binding providers")
    if recovery_profiles and (kinds or bindings):
        raise ValueError("select only one profile migration type")
    reviewed = {}
    for successor in recovery_profiles:
        raw = private_file(successor).read_bytes()
        identity = native_profile_identity(strict_json(raw)["owner"])
        if identity in reviewed:
            raise ValueError("duplicate native recovery profile identity")
        reviewed[identity] = raw
    matched = set()
    snapshots, planned, used_bindings = {}, [], set()
    for selected in selection["profiles"]:
        path = private_file(selected)
        raw = path.read_bytes()
        snapshots[selected] = profile_hash = hashlib.sha256(raw).hexdigest()
        owner = strict_json(raw)["owner"]
        kind = owner.get("kind")
        script = owner.get("ahap_script")
        native_browser = kind in BROWSER_KINDS and script is None
        identity = native_profile_identity(owner)
        recovering = bool(reviewed) and identity in reviewed
        if not recovering:
            if kind not in kinds and not native_browser:
                continue
            if retained_remote_wrapper(owner, base):
                continue
            if script is None and kind == "opencode":
                continue  # The native OpenCode owner retains the Node and endpoint pins.
            if owner.get("executable") != base["core" if native_browser else "node"]:
                raise ValueError("previous owner does not select the exact installed executable")
            if not native_browser and (not isinstance(script, str) or script != base["adapters"].get(kind)):
                raise ValueError("previous owner does not select the reviewed local runner")
        profile, checked = protected_profile(path)
        if checked != raw:
            raise ValueError("protected profile changed during migration")
        if recovering:
            if identity in matched:
                raise ValueError("selected recovery profile identity is ambiguous")
            matched.add(identity)
            payload = recovery_profile_payload(raw, reviewed[identity], installed=installed)
        elif kind == "opencode":
            payload = native_profile_payload(raw)
        else:
            binding = None
            env = owner.get("ahap_env")
            if kind in bindings:
                binding = read_browser_binding(bindings[kind], output, kind, profile_hash)
                used_bindings.add(kind)
            payload = browser_profile_payload(raw, owner, manifest["core"], binding, installed=installed)
        after_hash = hashlib.sha256(payload).hexdigest()
        # Schema 1 recovery receipts recorded the resolved authority directory.
        parent = path.parent if recovering and legacy_recovery_paths else authority_parent(path, profile)
        target = parent / ("profile-process-leases-native-" + source[:12] + "-" + after_hash[:20] + ".json")
        row = {"kind": kind, "previous_path": selected, "previous_sha256": profile_hash,
               "path": str(target), "sha256": after_hash, "payload_sha256": after_hash,
               "payload": str(output / "profile-payloads" / (after_hash + ".json"))}
        if kind in BROWSER_KINDS or (recovering and parent != path.parent):
            row["authority_directory"] = str(path.parent)
        planned.append((row, payload))
    if matched != reviewed.keys():
        raise ValueError("every native recovery profile must match an exact selected profile")
    if not set(kinds) <= {row["kind"] for row, _ in planned} or used_bindings != set(bindings):
        raise ValueError("each selected native update and private binding must match a profile")
    if len({Path(row["path"]).resolve() for row, _ in planned}) != len(planned):
        raise ValueError("native profile migration requires distinct sibling destinations")
    return snapshots, planned


def stage_native_payloads(planned):
    profiles = []
    for row, payload in planned:
        if os.path.lexists(row["path"]):
            raise FileExistsError("new protected profile destination already exists")
        staged = Path(row["payload"])
        if not staged.exists():
            create(staged, payload, 0o400)
        profiles.append(row)
    return profiles


def stage_native_profile_migration(base, manifest, selection, selector, output, source, kinds, bindings=None, *,
                                   recovery_profiles=()):
    # Earlier callers supplied the recovery profile paths as the eighth positional argument.
    if isinstance(bindings, (list, tuple)) and not recovery_profiles:
        recovery_profiles, bindings = bindings, None
    bindings = {} if bindings is None else bindings
    snapshots, planned = native_profile_plan(base, manifest, selection, output, source, kinds, bindings,
                                             recovery_profiles=recovery_profiles)
    if not planned:
        return None
    payload_dir = output / "profile-payloads"
    payload_dir.mkdir(mode=0o700)
    profiles = stage_native_payloads(planned)
    if recovery_profiles:
        # Browsers and recovery siblings behind directory aliases also pin the resolved authority.
        pinned_authority = any("authority_directory" in row for row in profiles)
        version = {"schema": 3 if pinned_authority else 1, "kind": "recovery"}
    elif all(row["kind"] == "opencode" for row in profiles):
        version = {"schema": 1, "kind": "opencode"}
    else:
        version = {"schema": 2, "kinds": sorted(kinds), "bindings": bindings}
    migration = {**version, "type": "herder-native-profile-rebind", "source_commit": source,
                 "base_selector": str(selector), "base_selector_sha256": digest(selector),
                 "base_manifest": selection["manifest"], "base_manifest_sha256": selection["manifest_sha256"],
                 "profile_sha256": snapshots, "profiles": profiles}
    path = output / "native-profile-migration.json"
    create(path, encoded(migration), 0o400)
    manifest["native_profile_migration"] = str(path)
    manifest["sha256"]["native_profile_migration"] = digest(path)
    manifest["composition"]["process_leases"]["scope"] = "native core and reviewed protected owner profiles updated"
    manifest["build_inputs"]["source_commit_role"] = "clean native core and reviewed native owner profiles"
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
        if (set(migration) != fields or type(migration["schema"]) is not int or migration["schema"] not in (1, 2)
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
    if before.get("remote_ahap_wrappers", []) != after.get("remote_ahap_wrappers", []):
        raise ValueError("unreviewed remote wrapper replacement")
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


def checked_native_rows(rows, planned, installed):
    if rows != [row for row, _ in planned]:
        raise ValueError("native migration differs from the exact reviewed profile bindings")
    rebound = {}
    for row, wanted in planned:
        payload = Path(row["payload"])
        private_directory(payload.parent)
        if private_file(payload).read_bytes() != wanted:
            raise ValueError("native profile migration changes protected fields")
        target = Path(row["path"])
        if installed:
            if private_file(target).read_bytes() != wanted:
                raise ValueError("installed native profile differs from reviewed payload")
        elif os.path.lexists(target):
            raise FileExistsError("new protected profile destination already exists")
        rebound[row["previous_path"]] = row
    return rebound


def native_profile_transition(old, new, before, after, *, installed=False):
    bundle = private_file(new["manifest"]).parent
    migration_path = private_file(after["native_profile_migration"])
    if (migration_path != bundle / "native-profile-migration.json"
            or digest(migration_path) != after["sha256"].get("native_profile_migration")):
        raise ValueError("native profile migration path or digest mismatch")
    migration = strict_json(migration_path.read_bytes())
    fields = {"schema", "type", "source_commit", "base_selector", "base_selector_sha256",
              "base_manifest", "base_manifest_sha256", "profile_sha256", "profiles"}
    if not isinstance(migration, dict) or type(migration.get("schema")) is not int:
        raise ValueError("invalid native profile migration")
    schema = migration["schema"]
    recovering = schema in (1, 3) and migration.get("kind") == "recovery"
    if recovering:
        fields.add("kind")
        kinds, bindings = [], {}
    elif schema == 1 and migration.get("kind") == "opencode":
        fields.add("kind")
        kinds, bindings = ["opencode"], {}
    elif schema == 2:
        fields.update(("kinds", "bindings"))
        kinds, bindings = migration.get("kinds"), migration.get("bindings")
    else:
        raise ValueError("unsupported native profile migration")
    source = after.get("source_commit")
    if (set(migration) != fields or migration["type"] != "herder-native-profile-rebind"
            or migration["source_commit"] != source or source != after.get("source_sha")
            or source != after["process_leases_build"]["source_commit"]
            or not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40}", source)):
        raise ValueError("invalid native profile migration")
    if (migration["base_manifest"] != old["manifest"] or migration["base_manifest_sha256"] != old["manifest_sha256"]
            or digest(private_file(old["manifest"])) != old["manifest_sha256"] or read_json(old["manifest"]) != before):
        raise ValueError("native profile migration baseline mismatch")
    adapter_transition(before, after)
    recovery_profiles = []
    if recovering:
        payload_dir = private_directory(bundle / "profile-payloads")
        if not isinstance(migration["profiles"], list):
            raise ValueError("invalid native recovery profiles")
        for row in migration["profiles"]:
            if not isinstance(row, dict):
                raise ValueError("invalid native recovery profile row")
            if row.get("kind") in BROWSER_KINDS:
                continue  # The planner derives browser rows exclusively from the old selector.
            sha = row.get("payload_sha256")
            if (row.get("kind") not in ("codex", "opencode") or not isinstance(sha, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", sha)):
                raise ValueError("invalid native recovery profile row")
            recovery_profiles.append(payload_dir / (sha + ".json"))
        if not recovery_profiles:
            raise ValueError("native recovery migration requires a reviewed recovery profile")
    snapshots, planned = native_profile_plan(before, after, old, bundle, source, kinds, bindings,
                                             recovery_profiles=recovery_profiles, installed=installed,
                                             legacy_recovery_paths=recovering and schema == 1)
    if snapshots != migration["profile_sha256"]:
        raise ValueError("previous protected profile changed or snapshot is incomplete")
    pinned_authority = any("authority_directory" in row for row, _ in planned)
    if not planned or (schema == 1 and pinned_authority) or (schema == 3 and not pinned_authority):
        raise ValueError("invalid native profile migration coverage")
    rebound = checked_native_rows(migration["profiles"], planned, installed)
    expected = copy.deepcopy(old)
    expected.update(manifest=new["manifest"], manifest_sha256=new["manifest_sha256"])
    expected["profiles"] = [rebound[path]["path"] if path in rebound else path for path in old["profiles"]]
    if expected != new:
        raise ValueError("selector differs from exact native profile transition")
    return migration


def profile_migration(old, new, before, after, *, installed=False):
    if "adapter_migration" in after and "native_profile_migration" in after:
        raise ValueError("candidate contains multiple profile migrations")
    if "native_profile_migration" in after:
        return native_profile_transition(old, new, before, after, installed=installed)
    return profile_transition(old, new, before, after, installed=installed)


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
    rows = migration["profiles"]
    by_old = {}
    destinations = set()
    bundle = Path(after["adapter_migration"]).parent
    # AHAP updates may carry only an existing native browser's exact core rebind.
    actual, planned = native_profile_plan(before, after, old, bundle, migration["source_commit"], [], {})
    if snapshots != actual:
        raise ValueError("previous protected profile changed")
    if bool(planned) != (migration["schema"] == 2):
        raise ValueError("adapter migration differs from the required native browser core rebinds")
    native = checked_native_rows([row for row in rows if row["kind"] in BROWSER_KINDS], planned, installed)
    rows = [row for row in rows if row["kind"] not in BROWSER_KINDS]
    destinations.update(Path(row["path"]).resolve() for row in native.values())
    for item in rows:
        if set(item) != {"kind", "previous_path", "previous_sha256", "path", "sha256", "payload", "payload_sha256"}:
            raise ValueError("unexpected profile transition fields")
        selected = item["previous_path"]
        previous, target = private_file(selected), Path(item["path"])
        profile, raw = protected_profile(previous)
        destination = planned_path(previous.parent / target.name)
        if (selected in by_old or destination in destinations or destination == previous
                or target.parent != authority_parent(previous, profile) or selected not in snapshots
                or item["previous_sha256"] != snapshots[selected]):
            raise ValueError("profile migration must use distinct siblings in the existing authority")
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
        by_old[selected] = item
        destinations.add(destination)
    affected = {path for path in old["profiles"]
                if uses_reviewed_local_adapter(strict_json(private_file(path).read_bytes()), before, migration["adapters"])}
    if set(by_old) != affected or {item["kind"] for item in rows} != set(migration["adapters"]):
        raise ValueError("adapter migration omits or adds selected profile bindings")
    by_old.update(native)
    expected["profiles"] = [by_old[path]["path"] if path in by_old else path for path in old["profiles"]]
    if expected != new:
        raise ValueError("selector differs from the exact reviewed profile transition")
    return migration


def check_candidate(selector, launcher):
    selection = read_json(selector)
    manifest = read_json(selection["manifest"])
    if "adapter_migration" not in manifest and "native_profile_migration" not in manifest:
        return check_selector(selector, launcher)
    bundle = private_file(selector).parent
    receipt = read_json(bundle / "process-leases-build.json")
    if private_file(selection["manifest"]) != bundle / "manifest.json" or digest(private_file(launcher)) != receipt["launcher_sha256"]:
        raise ValueError("candidate manifest or launcher differs from the reviewed build")
    key = "native_profile_migration" if "native_profile_migration" in manifest else "adapter_migration"
    migration_hash = manifest["sha256"][key]
    if receipt.get("profile_migration_sha256", receipt.get("adapter_migration_sha256")) != migration_hash:
        raise ValueError("profile migration differs from the build receipt")
    baseline = read_json(receipt["base_selector"])
    if (digest(private_file(receipt["base_selector"])) != receipt["base_selector_sha256"]
            or digest(private_file(selector)) != receipt["candidate_selector_sha256"]
            or digest(private_file(selection["manifest"])) != receipt["candidate_manifest_sha256"]
            or selection["manifest_sha256"] != receipt["candidate_manifest_sha256"]):
        raise ValueError("candidate or baseline changed since adapter build")
    migration = profile_migration(baseline, selection, read_json(baseline["manifest"]), manifest)
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
            "profile_migration_sha256": migration_hash,
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
    native_updates = getattr(args, "native_update", [])
    recovery_profiles = getattr(args, "native_recovery_profile", [])
    if len(set(updates)) != len(updates) or not set(updates) <= ADAPTER_UPDATES:
        raise ValueError("select each reviewed adapter update once")
    if len(set(native_updates)) != len(native_updates) or not set(native_updates) <= NATIVE_PROFILE_UPDATES:
        raise ValueError("select each reviewed native profile update once")
    if sum(map(bool, (updates, native_updates, recovery_profiles))) > 1:
        raise ValueError("select only one profile migration type")
    browser_bindings = {}
    for kind, path, sha256 in getattr(args, "browser_binding", []):
        if kind not in BROWSER_KINDS or kind not in native_updates or kind in browser_bindings:
            raise ValueError("supply one private binding per explicitly selected browser provider")
        browser_bindings[kind] = {"path": path, "sha256": sha256}
    canonical_config = getattr(args, "canonical_config", None)
    canonical_hash = getattr(args, "canonical_config_sha256", None)
    if (canonical_config is None) != (canonical_hash is None):
        raise ValueError("canonical config path and digest must be provided together")
    migration_binding = None
    if canonical_config is not None:
        migration_binding = {"config": str(private_file(canonical_config)), "sha256": canonical_hash}
        canonical_migration_identity({"canonical_migration": migration_binding})
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
    replace_remote_bridge = not recovery_profiles and remote_source.is_file()
    compilation = compile_typescript(repo, output, sha, base) if updates or replace_remote_bridge else None
    remote_bridge = None
    if replace_remote_bridge:
        remote_bridge = bundle_process_remote_bridge(repo, output, sha, base, compilation)
        hashes["process_remote_bridge"] = remote_bridge["sha256"]
    manifest = compose_manifest(base, output, sha, base_path, selection["manifest_sha256"], hashes, argv)
    if remote_bridge:
        manifest["build_inputs"]["process_remote_bridge"] = remote_bridge["build"]
    if migration_binding is not None:
        if digest(private_file(migration_binding["config"])) != migration_binding["sha256"]:
            raise ValueError("canonical migration configuration changed during build")
        manifest["canonical_migration"] = migration_binding
    migration = None
    if updates:
        adapters, adapter_build = bundle_adapters(repo, output, sha, base, updates, compilation)
        migration = stage_adapter_migration(base, manifest, selection, selector, output, sha, adapters, adapter_build)
    else:
        migration = stage_native_profile_migration(base, manifest, selection, selector, output, sha,
                                                  native_updates, browser_bindings, recovery_profiles=recovery_profiles)
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
                             profile_migration_sha256=manifest["sha256"].get("adapter_migration", manifest["sha256"].get("native_profile_migration")))
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
        migration = profile_migration(old, new, old_manifest, candidate_manifest)
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
            receipt["profile_migration_sha256"] = candidate_manifest["sha256"].get("adapter_migration", candidate_manifest["sha256"].get("native_profile_migration"))
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
                previous = private_file(item["previous_path"])
                if digest(previous) != item["previous_sha256"]:
                    raise ValueError("previous profile changed before sibling creation")
                target = Path(item["path"])
                if (target.parent.resolve(strict=True) != previous.parent
                        or item.get("authority_directory", str(previous.parent)) != str(previous.parent)):
                    raise ValueError("profile authority directory changed before sibling creation")
                target = previous.parent / target.name
                create(target, private_file(item["payload"]).read_bytes(), 0o400)
                sync_dir(target.parent)
            profile_migration(old, new, old_manifest, candidate_manifest, installed=True)
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
    b.add_argument("--canonical-config", type=Path, help="reviewed immutable canonical migration configuration")
    b.add_argument("--canonical-config-sha256", help="exact digest of the canonical migration configuration")
    b.add_argument("--adapter-update", action="append", default=[], choices=sorted(ADAPTER_UPDATES),
                   help="explicit reviewed AHAP update; may be repeated once per kind")
    b.add_argument("--native-update", action="append", default=[], choices=sorted(NATIVE_PROFILE_UPDATES),
                   help="explicit reviewed native owner profile update")
    b.add_argument("--native-recovery-profile", "--native-autopilot-profile", action="append", default=[], type=Path,
                   help="reviewed successor profile for a shared Codex socket, recovery handoff or session autopilot")
    b.add_argument("--browser-binding", action="append", nargs=3, default=[], metavar=("KIND", "FILE", "SHA256"),
                   help="pin a private operator-reviewed browser binding for a selected browser")
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
