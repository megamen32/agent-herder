#!/usr/bin/env python3
"""Read-only, Linux proof that the installed TS scheduler uses canonical Herder.

The rollout operator supplies an authenticated GET receipt. The receipt is not
an acknowledgement: the coordinator independently binds it to the live systemd
MainPID, socket, immutable executable tree, pinned configuration and drained
writers. No request in this module starts, stops or resumes anything.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import socket
import stat
import subprocess
import sys
import time

UNIT = "agent-herder.service"
CONTROLLER = "shell:roomhacker-server-100"
AUTHORITY = "mcp:shell:roomhacker-server-100:AgentHerder"
ENDPOINT = "http://127.0.0.1:18787/api/canonical-runtime-status"
PORT = 18787
CAPABILITY = "canonical-scheduler-wait-gate-v1"
MAX_AGE_MS = 60000
HASH = re.compile(r"[a-f0-9]{64}")
SOURCE = re.compile(r"[a-f0-9]{40}")
BOOT = re.compile(r"[a-f0-9-]{36}")
REQUIRED_FILES = {"index.js", "canonical-runtime-status.js", "canonical-herder.js",
                  "canonical-migration.js", "resume-after-runtime.js", "resume-after-canonical.js", "process-wait-gate.js"}
ENV_KEYS = ("AGENT_HERDER_CANONICAL_MODE", "AGENT_HERDER_CANONICAL_CONFIG",
            "AGENT_HERDER_CANONICAL_CONFIG_SHA256", "AGENT_HERDER_TS_RUNTIME_MANIFEST",
            "AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256")
INJECTION_ENV = ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT")


def now_ms():
    return int(time.time() * 1000)


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def fields(value, required, optional=()):
    if (not isinstance(value, dict) or set(required) - value.keys()
            or value.keys() - set(required) - set(optional)):
        raise ValueError("scheduler proof has an invalid typed shape")
    return value


def exact(value, maximum=4096):
    return (isinstance(value, str) and 0 < len(value) <= maximum and value.strip() == value
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value):
        raise ValueError("scheduler observation has an invalid timestamp")
    try:
        return int(datetime.datetime.fromisoformat(value[:-1] + "+00:00").timestamp() * 1000)
    except (ValueError, OverflowError):
        raise ValueError("scheduler observation has an invalid timestamp") from None


def canonical(filename):
    if not exact(filename):
        raise ValueError("scheduler proof path is invalid")
    path = Path(filename)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("scheduler proof path is not canonical")
    return path


def same_file(left, right):
    return (left.st_dev, left.st_ino, left.st_size, left.st_mtime_ns, left.st_ctime_ns) == (
        right.st_dev, right.st_ino, right.st_size, right.st_mtime_ns, right.st_ctime_ns)


def read_file(filename, maximum=8 * 1024 * 1024, policy="private"):
    path = canonical(filename)
    selected = path.lstat()
    if not stat.S_ISREG(selected.st_mode):
        raise ValueError("scheduler proof requires a regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        mode = stat.S_IMODE(before.st_mode)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or not same_file(before, selected) or before.st_size > maximum):
            raise ValueError("scheduler proof file is untrusted")
        if policy == "node":
            valid = ((before.st_uid == os.getuid() and mode == 0o500)
                     or (before.st_uid == 0 and mode == 0o555))
        elif policy == "unit":
            valid = before.st_uid in (0, os.getuid()) and not mode & 0o022
        else:
            valid = before.st_uid == os.getuid() and not mode & 0o077
            if policy == "immutable":
                valid = valid and mode == 0o400
        if not valid:
            raise ValueError("scheduler proof file permissions are untrusted")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != before.st_size or not same_file(before, os.fstat(fd)) or not same_file(before, path.lstat()):
            raise ValueError("scheduler proof file changed during observation")
        return bytes(data), before
    finally:
        os.close(fd)


def pinned_json(filename, sha256, policy="immutable", maximum=8 * 1024 * 1024):
    if not isinstance(sha256, str) or not HASH.fullmatch(sha256):
        raise ValueError("scheduler proof digest is invalid")
    data, metadata = read_file(filename, maximum=maximum, policy=policy)
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError("scheduler proof digest changed")
    return json.loads(data), metadata


def birth(pid):
    if sys.platform != "linux" or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise ValueError("scheduler readiness requires a local Linux process")
    proc = Path("/proc") / str(pid)
    values = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    if len(values) < 20 or values[0] in ("Z", "X", "x") or not values[19].isdigit():
        raise ValueError("scheduler process is not live")
    return {"pid": pid, "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "start_ticks": values[19]}


def runtime_tree(runtime):
    fields(runtime, ("manifest", "manifest_sha256", "source_commit", "capability",
                     "resume_after_authority", "legacy_fallback"))
    if (runtime["capability"] != CAPABILITY or runtime["resume_after_authority"] != "canonical"
            or runtime["legacy_fallback"] is not False or not isinstance(runtime["source_commit"], str)
            or not SOURCE.fullmatch(runtime["source_commit"])):
        raise ValueError("TS runtime lacks the canonical scheduler capability")
    manifest, _ = pinned_json(runtime["manifest"], runtime["manifest_sha256"])
    fields(manifest, ("version", "kind", "capability", "source_commit", "root", "entry", "files",
                      "node_binary", "node_sha256"))
    if (manifest["version"] != 1 or manifest["kind"] != "herder-canonical-ts-runtime"
            or manifest["capability"] != CAPABILITY or manifest["source_commit"] != runtime["source_commit"]
            or manifest["entry"] != "index.js" or not isinstance(manifest["files"], dict)
            or not REQUIRED_FILES <= manifest["files"].keys() or len(manifest["files"]) > 10000):
        raise ValueError("TS runtime manifest does not describe the complete canonical entry")
    root = canonical(manifest["root"])
    manifest_path = Path(runtime["manifest"])
    if manifest_path == root or root in manifest_path.parents:
        raise ValueError("TS runtime manifest must be outside its immutable tree")
    for relative, digest in manifest["files"].items():
        parts = PurePosixPath(relative).parts if isinstance(relative, str) else ()
        if (not parts or PurePosixPath(relative).is_absolute() or str(PurePosixPath(relative)) != relative
                or any(part in (".", "..") for part in parts) or not exact(relative)
                or not isinstance(digest, str) or not HASH.fullmatch(digest)):
            raise ValueError("TS runtime file inventory is invalid")
    observed, count, total = {}, 0, 0
    stack = [(root, 0)]
    directories = []
    while stack:
        directory, depth = stack.pop()
        before = directory.lstat()
        if (not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o500 or depth > 32):
            raise ValueError("TS runtime directory is not immutable")
        directories.append((directory, before))
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > 20000:
                    raise ValueError("TS runtime inventory exceeds its bound")
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    stack.append((path, depth + 1))
                    continue
                relative = path.relative_to(root).as_posix()
                if relative not in manifest["files"]:
                    raise ValueError("TS runtime has an unpinned file")
                data, _ = read_file(str(path), maximum=64 * 1024 * 1024, policy="immutable")
                total += len(data)
                if total > 512 * 1024 * 1024:
                    raise ValueError("TS runtime tree exceeds its bound")
                observed[relative] = hashlib.sha256(data).hexdigest()
    if observed != manifest["files"] or any(not same_file(before, path.lstat()) for path, before in directories):
        raise ValueError("TS runtime inventory changed or has a different digest")
    node, node_stat = read_file(manifest["node_binary"], maximum=256 * 1024 * 1024, policy="node")
    if not isinstance(manifest["node_sha256"], str) or hashlib.sha256(node).hexdigest() != manifest["node_sha256"]:
        raise ValueError("TS Node executable digest changed")
    return manifest, node_stat, {"device": str(directories[0][1].st_dev), "inode": str(directories[0][1].st_ino)}


def sealed_directory(filename, identity=None):
    path = canonical(filename)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o500):
        raise ValueError("retained quarantine directory is not immutable")
    if identity is not None:
        fields(identity, ("device", "inode"))
        if identity != {"device": str(info.st_dev), "inode": str(info.st_ino)}:
            raise ValueError("retained quarantine directory identity changed")
    return path, info


def quarantine(config):
    """Independently bind every retained source and profile to the pinned epoch."""
    q = fields(config["quarantine"], ("inventory_sha256", "legacy_jobs", "snapshots"))
    fields(q["legacy_jobs"], ("directory", "snapshot", "sha256"))
    if (not isinstance(q["inventory_sha256"], str) or not HASH.fullmatch(q["inventory_sha256"])
            or not isinstance(q["snapshots"], list) or not 1 <= len(q["snapshots"]) <= 128):
        raise ValueError("canonical quarantine configuration is invalid")
    sources, originals, required_keys, directories = {}, {}, {}, []

    def retain(ref, filename, digest, value, keys):
        if ref in originals or filename in sources:
            raise ValueError("quarantine source inventory is ambiguous")
        sources[filename] = digest
        required_keys[ref] = set(keys)
        originals[ref] = (filename, digest, hashlib.sha256(json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest())

    for name, kind, jobs in (
            ("resume_after", "herder-resume-after-retained", False),
            ("legacy_jobs", "herder-legacy-jobs-retained", True)):
        binding = q[name] if jobs else config[name]
        seal, _ = pinned_json(binding["snapshot"], binding["sha256"])
        fields(seal, ("version", "kind", "epoch", "directory", "directory_identity", "records"), ("sealed_at",))
        if (type(seal["version"]) is not int or seal["version"] != 1 or seal["kind"] != kind
                or seal["epoch"] != config["epoch"] or seal["directory"] != binding["directory"]
                or not isinstance(seal["records"], list) or len(seal["records"]) > 10000
                or (not jobs and "sealed_at" not in seal)
                or ("sealed_at" in seal and instant(seal["sealed_at"]) > now_ms() + 5000)):
            raise ValueError("retained quarantine snapshot identity changed")
        directory, before = sealed_directory(binding["directory"], seal["directory_identity"])
        directories.append((directory, before))
        names = set()
        for record in seal["records"]:
            fields(record, ("id", "sha256"))
            ident = record["id"]
            if (not exact(ident) or ident in (".", "..") or "/" in ident or "\\" in ident
                    or (not jobs and not re.fullmatch(r"wait_[a-f0-9]{32}", ident))
                    or not isinstance(record["sha256"], str) or not HASH.fullmatch(record["sha256"])):
                raise ValueError("retained quarantine record identity is invalid")
            entry = ident if jobs else ident + ".json"
            if entry in names:
                raise ValueError("retained quarantine snapshot repeats a record")
            names.add(entry)
            if jobs:
                folder, folder_before = sealed_directory(str(directory / ident))
                directories.append((folder, folder_before))
                filename = str(folder / "meta.json")
            else:
                filename = str(directory / entry)
            data, _ = read_file(filename, policy="immutable")
            if hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise ValueError("retained quarantine source digest changed")
            value = json.loads(data)
            if (not isinstance(value, dict) or value.get("job_id" if jobs else "id") != ident
                    or (jobs and not exact(value.get("state")))):
                raise ValueError("retained quarantine source identity changed")
            if jobs:
                key = "agent-resume:job:" + ident
                keys = [ident, key, "compat-resume:v1:" + hashlib.sha256(key.encode()).hexdigest()]
            else:
                keys = [ident, "resume-after:" + ident]
            retain(("agent-resume-job:" if jobs else "resume-after:") + ident,
                   filename, record["sha256"], value, keys)
        if set(os.listdir(directory)) != names:
            raise ValueError("retained quarantine directory inventory changed")

    binding = config["resume_receipts"]
    seal, _ = pinned_json(binding["snapshot"], binding["sha256"])
    fields(seal, ("version", "kind", "epoch", "path", "sha256", "sealed_at", "file_identity"))
    if (type(seal["version"]) is not int or seal["version"] != 1
            or seal["kind"] != "herder-resume-receipts-retained" or seal["epoch"] != config["epoch"]
            or seal["path"] != binding["path"] or instant(seal["sealed_at"]) > now_ms() + 5000):
        raise ValueError("retained receipt quarantine snapshot changed")
    ledger, info = pinned_json(binding["path"], seal["sha256"], maximum=16 * 1024 * 1024)
    fields(seal["file_identity"], ("device", "inode"))
    if seal["file_identity"] != {"device": str(info.st_dev), "inode": str(info.st_ino)}:
        raise ValueError("retained receipt quarantine file identity changed")
    if (not isinstance(ledger, dict) or type(ledger.get("version")) is not int or ledger["version"] != 1
            or not isinstance(ledger.get("receipts"), dict) or len(ledger["receipts"]) > 10000):
        raise ValueError("retained receipt quarantine ledger is invalid")
    if binding["path"] in sources:
        raise ValueError("quarantine source inventory is ambiguous")
    sources[binding["path"]] = seal["sha256"]
    for key, value in ledger["receipts"].items():
        if not exact(key) or not isinstance(value, dict) or value.get("idempotency_key") != key:
            raise ValueError("retained receipt quarantine key changed")
        ref = "resume-receipt:" + hashlib.sha256(key.encode()).hexdigest()
        required_keys[ref] = {key, "compat-resume:v1:" + hashlib.sha256(key.encode()).hexdigest()}
        originals[ref] = (
            binding["path"], seal["sha256"], hashlib.sha256(json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest())
    inventory = "".join(sorted(filename + "\0" + digest + "\n" for filename, digest in sources.items()))
    if hashlib.sha256(inventory.encode()).hexdigest() != q["inventory_sha256"]:
        raise ValueError("quarantine retained source inventory digest changed")

    profile_ids, baseline = set(), None
    for profile in q["snapshots"]:
        fields(profile, ("harness", "node_ref", "instance_ref", "authority_generation", "path", "sha256"),
               ("legacy_host_ids",))
        if (not all(exact(profile[key]) for key in ("harness", "node_ref", "instance_ref", "authority_generation"))
                or ("legacy_host_ids" in profile and (not isinstance(profile["legacy_host_ids"], list)
                    or not all(exact(host) for host in profile["legacy_host_ids"])))):
            raise ValueError("quarantine authority profile is invalid")
        identity = (profile["node_ref"], profile["instance_ref"])
        if identity in profile_ids:
            raise ValueError("quarantine authority profile is duplicated")
        profile_ids.add(identity)
        snapshot, _ = pinned_json(profile["path"], profile["sha256"], maximum=16 * 1024 * 1024)
        fields(snapshot, ("version", "kind", "epoch", "authority_generation", "node_ref", "instance_ref",
                          "writer_drain_sha256", "inventory_sha256", "sources", "records"))
        if (type(snapshot["version"]) is not int or snapshot["version"] != 1
                or snapshot["kind"] != "herder-legacy-quarantine" or snapshot["epoch"] != config["epoch"]
                or any(snapshot[key] != profile[key] for key in ("node_ref", "instance_ref", "authority_generation"))
                or snapshot["writer_drain_sha256"] != config["writer_drain"]["sha256"]
                or snapshot["inventory_sha256"] != q["inventory_sha256"]
                or not isinstance(snapshot["sources"], list) or len(snapshot["sources"]) != len(sources)
                or not isinstance(snapshot["records"], list) or len(snapshot["records"]) > 20000):
            raise ValueError("quarantine snapshot epoch, generation or inventory changed")
        observed_sources = {}
        for source in snapshot["sources"]:
            fields(source, ("path", "sha256"))
            if not isinstance(source["path"], str) or source["path"] in observed_sources:
                raise ValueError("quarantine snapshot source is duplicated")
            observed_sources[source["path"]] = source["sha256"]
        if observed_sources != sources:
            raise ValueError("quarantine snapshot source coverage is incomplete")
        records = {}
        for record in snapshot["records"]:
            fields(record, ("record_ref", "source_path", "source_sha256", "record_sha256",
                            "request_keys", "outcome", "holds"))
            ref = record["record_ref"]
            if (not exact(ref) or ref in records or originals.get(ref) != (
                    record["source_path"], record["source_sha256"], record["record_sha256"])
                    or not isinstance(record["request_keys"], list) or not record["request_keys"]
                    or not all(exact(key) for key in record["request_keys"])
                    or record["outcome"] not in ("accepted", "not_submitted", "unknown")
                    or not isinstance(record["holds"], list)
                    or (record["outcome"] == "unknown") != bool(record["holds"])):
                raise ValueError("quarantine snapshot retained record changed")
            if not required_keys[ref] <= set(record["request_keys"]):
                raise ValueError("quarantine original and derived request key coverage is incomplete")
            for hold in record["holds"]:
                fields(hold, ("node_ref", "instance_ref", "native_session_id"))
                if (not exact(hold["node_ref"]) or not exact(hold["instance_ref"])
                        or (hold["native_session_id"] is not None
                            and (not exact(hold["native_session_id"]) or hold["native_session_id"] == "*"))):
                    raise ValueError("quarantine snapshot hold scope is invalid")
            records[ref] = record
        if records.keys() != originals.keys():
            raise ValueError("quarantine snapshot record coverage is incomplete")
        if baseline is not None and records != baseline:
            raise ValueError("quarantine snapshots disagree on retained records")
        baseline = records
    if any(not same_file(before, directory.lstat()) or stat.S_IMODE(directory.stat().st_mode) != 0o500
           for directory, before in directories):
        raise ValueError("retained quarantine directory changed during observation")
    return q


def quarantine_response(config, response, *, operational):
    q = config.get("quarantine")
    if q is None:
        if response is not None:
            raise ValueError("scheduler returned an unconfigured quarantine proof")
        return
    fields(response, ("version", "configured", "local_verified", "native_verified",
                      "inventory_sha256", "snapshots", "authorities"))
    projections = [{key: profile[key] for key in (
        "harness", "node_ref", "instance_ref", "authority_generation", "sha256")} for profile in q["snapshots"]]
    if (type(response["version"]) is not int or response["version"] != 1 or response["configured"] is not True
            or response["local_verified"] is not True or response["native_verified"] is not operational
            or response["inventory_sha256"] != q["inventory_sha256"] or response["snapshots"] != projections
            or not isinstance(response["authorities"], list)):
        raise ValueError("scheduler quarantine proof differs from its pinned configuration")
    if not operational:
        if response["authorities"]:
            raise ValueError("preflight cannot claim an operational native quarantine proof")
        return
    expected = {(profile["node_ref"], profile["instance_ref"], profile["authority_generation"]): profile
                for profile in q["snapshots"]}
    seen = set()
    for proof in response["authorities"]:
        fields(proof, ("version", "configured", "epoch", "authority_generation", "node_ref", "instance_ref",
                       "required_epoch", "snapshot_sha256", "writer_drain_sha256", "inventory_sha256"))
        identity = tuple(proof[key] for key in ("node_ref", "instance_ref", "authority_generation"))
        if not all(exact(value) for value in identity):
            raise ValueError("native quarantine authority identity is invalid")
        profile = expected.get(identity)
        if (profile is None or identity in seen or type(proof["version"]) is not int or proof["version"] != 1
                or proof["configured"] is not True or proof["epoch"] != config["epoch"]
                or proof["required_epoch"] != config["epoch"] or proof["snapshot_sha256"] != profile["sha256"]
                or proof["writer_drain_sha256"] != config["writer_drain"]["sha256"]
                or proof["inventory_sha256"] != q["inventory_sha256"]):
            raise ValueError("native quarantine authority proof differs from the pinned snapshot")
        seen.add(identity)
    if seen != expected.keys():
        raise ValueError("native quarantine authority coverage is incomplete")


def writer_drain(canonical_identity):
    fields(canonical_identity, ("config", "config_sha256", "epoch", "authority", "writer_drain_sha256"))
    config, _ = pinned_json(canonical_identity["config"], canonical_identity["config_sha256"])
    fields(config, ("version", "mode", "epoch", "authority", "writer_drain", "resume_after", "resume_receipts"), ("node_ref", "quarantine"))
    if (config["version"] != 1 or config["mode"] != "canonical" or not exact(config["epoch"], 128)
            or config["epoch"] != canonical_identity["epoch"] or config["authority"] != AUTHORITY
            or canonical_identity["authority"] != AUTHORITY):
        raise ValueError("TS scheduler selects a different authority or migration epoch")
    fields(config["writer_drain"], ("path", "sha256"))
    fields(config["resume_after"], ("directory", "snapshot", "sha256"))
    fields(config["resume_receipts"], ("path", "snapshot", "sha256"))
    if config["writer_drain"]["sha256"] != canonical_identity["writer_drain_sha256"]:
        raise ValueError("TS scheduler writer drain proof changed")
    proof, _ = pinned_json(config["writer_drain"]["path"], config["writer_drain"]["sha256"])
    fields(proof, ("version", "kind", "epoch", "platform", "hostname", "node_ref", "completed_at", "sources", "writers"))
    if (proof["version"] != 1 or proof["kind"] != "herder-legacy-writer-drain" or proof["epoch"] != config["epoch"]
            or proof["platform"] != "linux" or proof["hostname"] != socket.gethostname() or not exact(proof["node_ref"])
            or instant(proof["completed_at"]) > now_ms() + 5000 or not isinstance(proof["sources"], list)
            or not all(exact(source) and Path(source).is_absolute() for source in proof["sources"])
            or len(set(proof["sources"])) != len(proof["sources"]) or not isinstance(proof["writers"], list)
            or not 1 <= len(proof["writers"]) <= 256):
        raise ValueError("TS scheduler writer drain is unverified")
    required_sources = {config["resume_after"]["directory"], config["resume_receipts"]["path"]}
    if "quarantine" in config:
        q = fields(config["quarantine"], ("inventory_sha256", "legacy_jobs", "snapshots"))
        fields(q["legacy_jobs"], ("directory", "snapshot", "sha256"))
        if not exact(q["legacy_jobs"]["directory"]):
            raise ValueError("legacy jobs directory is invalid")
        required_sources.add(q["legacy_jobs"]["directory"])
    if not required_sources <= set(proof["sources"]):
        raise ValueError("writer drain does not cover waits, direct resume receipts and configured legacy jobs")
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    identities, covered = set(), set()
    for writer in proof["writers"]:
        fields(writer, ("pid", "boot_id", "start_ticks", "executable_sha256", "sources", "observation"))
        observation = fields(writer["observation"], ("observed_at", "result", "provider_operation_id", "target", "method"))
        if (not isinstance(writer["pid"], int) or isinstance(writer["pid"], bool) or writer["pid"] <= 1
                or not isinstance(writer["boot_id"], str) or not BOOT.fullmatch(writer["boot_id"])
                or not isinstance(writer["start_ticks"], str) or not writer["start_ticks"].isdigit()
                or not isinstance(writer["executable_sha256"], str) or not HASH.fullmatch(writer["executable_sha256"])
                or not isinstance(writer["sources"], list) or not writer["sources"]
                or not all(source in proof["sources"] for source in writer["sources"])
                or observation["result"] != "identity_absent"
                or instant(observation["observed_at"]) > instant(proof["completed_at"])
                or not all(exact(observation[key]) for key in ("provider_operation_id", "target", "method"))):
            raise ValueError("writer drain has an invalid process observation")
        identity = (writer["boot_id"], writer["pid"], writer["start_ticks"])
        if identity in identities:
            raise ValueError("writer drain repeats an ambiguous process identity")
        identities.add(identity)
        covered.update(writer["sources"])
        if writer["boot_id"] == boot:
            try:
                values = (Path("/proc") / str(writer["pid"]) / "stat").read_text().rsplit(")", 1)[1].split()
            except FileNotFoundError:
                continue
            if len(values) < 20 or not values[19].isdigit():
                raise ValueError("legacy writer identity is unavailable")
            if values[19] == writer["start_ticks"]:
                raise ValueError("a retained legacy writer is still alive")
    if set(proof["sources"]) - covered:
        raise ValueError("writer drain inventory is incomplete")
    # Exact sealed snapshots remain readable evidence. The actual loaded TS
    # service also revalidates every retained record before reporting readiness.
    for key in ("resume_after", "resume_receipts"):
        snapshot, _ = pinned_json(config[key]["snapshot"], config[key]["sha256"])
        if not isinstance(snapshot, dict) or snapshot.get("epoch") != config["epoch"]:
            raise ValueError("retained migration snapshot belongs to a different epoch")
    if "quarantine" in config:
        quarantine(config)
    return config


def systemd_snapshot(pid, expected_environment, node, entry):
    """Read the existing user service; never create, reload or restart a unit."""
    environment = dict(os.environ)
    environment.update(XDG_RUNTIME_DIR="/run/user/" + str(os.getuid()),
                       DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/" + str(os.getuid()) + "/bus",
                       SYSTEMD_PAGER="cat", SYSTEMD_COLORS="0")
    names = ("Id", "LoadState", "ActiveState", "SubState", "MainPID", "NeedDaemonReload", "FragmentPath",
             "DropInPaths", "ExecStart", "Environment", "EnvironmentFiles")
    result = subprocess.run(["/usr/bin/systemctl", "--user", "show", UNIT, "--property=" + ",".join(names)],
                            env=environment, capture_output=True, text=True, timeout=5)
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError("installed TS systemd service is unavailable")
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if (set(names) - values.keys() or values["Id"] != UNIT or values["LoadState"] != "loaded"
            or values["ActiveState"] != "active" or values["SubState"] != "running"
            or values["MainPID"] != str(pid) or values["NeedDaemonReload"] != "no"):
        raise ValueError("scheduler proof is not the actual loaded TS service MainPID")
    if any(re.search(r"[\s;]", path) for path in (node, entry)):
        raise ValueError("unsupported TS systemd command path")
    command = "{ path=" + node + " ; argv[]=" + node + " " + entry + " ;"
    if not values["ExecStart"].startswith(command) or values["ExecStart"].count("{ path=") != 1:
        raise ValueError("TS service restart command does not select the immutable entry")
    selected = {}
    for item in shlex.split(values["Environment"]):
        key, separator, value = item.partition("=")
        if separator and key in INJECTION_ENV and value:
            raise ValueError("TS service restart has an unpinned executable injection option")
        if separator and key in ENV_KEYS:
            if key in selected:
                raise ValueError("TS service has ambiguous canonical environment pins")
            selected[key] = value
    if selected != expected_environment:
        raise ValueError("TS canonical pins must be explicit in the persistent systemd Environment")
    files = [values["FragmentPath"], *shlex.split(values["DropInPaths"])]
    environment_files = values["EnvironmentFiles"]
    matches = list(re.finditer(r"([^\s]+) \(ignore_errors=(?:yes|no)\)(?: |$)", environment_files))
    if "".join(match.group(0) for match in matches).strip() != environment_files.strip():
        raise ValueError("TS service environment file inventory is ambiguous")
    evidence = []
    for filename in sorted(set(files + [match.group(1) for match in matches])):
        data, _ = read_file(filename, maximum=2 * 1024 * 1024, policy="unit")
        if filename in [match.group(1) for match in matches] and any(key.encode() in data for key in (*ENV_KEYS, *INJECTION_ENV)):
            raise ValueError("environment files must not override canonical pins or executable injection options")
        evidence.append({"path": filename, "sha256": hashlib.sha256(data).hexdigest()})
    return {"unit": UNIT, "files": evidence, "exec_start_sha256": hashlib.sha256(values["ExecStart"].encode()).hexdigest(),
            "canonical_environment_sha256": json_hash(selected)}


def listening_socket(pid):
    inodes = set()
    for filename in ("/proc/net/tcp", "/proc/net/tcp6"):
        data = Path(filename).read_bytes()
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("local listening socket inventory exceeds its bound")
        for line in data.decode().splitlines()[1:]:
            parts = line.split()
            address, port = parts[1].split(":")
            if int(port, 16) != PORT or parts[3] != "0A":
                continue
            if address not in ("0100007F", "00000000", "0" * 32, "0" * 24 + "01000000") or int(parts[7]) != os.getuid():
                raise ValueError("TS listener address or owner is ambiguous")
            inodes.add(parts[9])
    owned = set()
    for fd in (Path("/proc") / str(pid) / "fd").iterdir():
        try:
            match = re.fullmatch(r"socket:\[(\d+)\]", os.readlink(fd))
        except FileNotFoundError:
            continue
        if match:
            owned.add(match.group(1))
    if len(inodes) != 1 or not inodes <= owned:
        raise ValueError("canonical status endpoint is not owned by the TS service MainPID")
    return {"port": PORT, "inode": next(iter(inodes))}


def observe(identity):
    """Independently repeat all durable and live checks around the selector CAS."""
    fields(identity, ("process", "runtime", "canonical"), ("tree", "service", "listener"))
    process = fields(identity["process"], ("pid", "boot_id", "start_ticks", "entry", "entry_sha256", "node_binary", "node_sha256"))
    before = birth(process["pid"])
    if any(process[key] != value for key, value in before.items()):
        raise ValueError("scheduler process PID or birth identity changed")
    manifest, node_stat, tree = runtime_tree(identity["runtime"])
    entry = str(Path(manifest["root"]) / manifest["entry"])
    if (process["entry"] != entry or process["entry_sha256"] != manifest["files"][manifest["entry"]]
            or process["node_binary"] != manifest["node_binary"] or process["node_sha256"] != manifest["node_sha256"]):
        raise ValueError("scheduler process does not select the pinned immutable entry")
    writer_drain(identity["canonical"])
    proc = Path("/proc") / str(process["pid"])
    if proc.stat().st_uid != os.getuid():
        raise ValueError("scheduler process belongs to another user")
    uid = next(line.split()[1:] for line in (proc / "status").read_text().splitlines() if line.startswith("Uid:"))
    if any(int(value) != os.getuid() for value in uid):
        raise ValueError("scheduler process credentials changed")
    argv = [item.decode() for item in (proc / "cmdline").read_bytes().split(b"\0") if item]
    if argv != [manifest["node_binary"], entry] or os.readlink(proc / "exe") != manifest["node_binary"]:
        raise ValueError("actual TS command differs from the claimed immutable entry")
    actual_exe = (proc / "exe").stat()
    if actual_exe.st_dev != node_stat.st_dev or actual_exe.st_ino != node_stat.st_ino:
        raise ValueError("actual TS executable inode differs from its pinned Node")
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
    expected = {ENV_KEYS[0]: "canonical", ENV_KEYS[1]: identity["canonical"]["config"],
                ENV_KEYS[2]: identity["canonical"]["config_sha256"], ENV_KEYS[3]: identity["runtime"]["manifest"],
                ENV_KEYS[4]: identity["runtime"]["manifest_sha256"]}
    if any(env.get(key.encode(), b"").decode() != value for key, value in expected.items()):
        raise ValueError("live TS canonical mode or configuration epoch is different")
    if env.get(b"AGENT_HERDER_WEB_PORT") != str(PORT).encode():
        raise ValueError("live TS runtime uses a different HTTP listener")
    if any(env.get(key.encode()) for key in INJECTION_ENV):
        raise ValueError("TS runtime has an unpinned executable injection option")
    service = systemd_snapshot(process["pid"], expected, manifest["node_binary"], entry)
    listener = listening_socket(process["pid"])
    if birth(process["pid"]) != before:
        raise ValueError("scheduler process changed during readiness observation")
    result = {"process": dict(process), "runtime": dict(identity["runtime"]), "canonical": dict(identity["canonical"]),
              "tree": tree, "service": service, "listener": listener}
    if set(identity) - {"process", "runtime", "canonical"} and result != identity:
        raise ValueError("installed TS scheduler configuration changed after admission")
    return result


def validate_receipt(receipt, source_commit, *, stage, expected=None, challenge=None, job_id=None, minimum=0):
    fields(receipt, ("version", "kind", "stage", "target", "unit", "method", "provider_operation_id",
                     "observed_at_unix_ms", "request", "response", "response_sha256"), ("job_id",))
    if (receipt["version"] != 1 or receipt["kind"] != "herder-canonical-scheduler-proof" or receipt["stage"] != stage
            or receipt["target"] != CONTROLLER or receipt["unit"] != UNIT or receipt["method"] != "http_get"
            or not isinstance(receipt["provider_operation_id"], str)
            or not re.fullmatch(r"[A-Za-z0-9_:/.-]{8,240}", receipt["provider_operation_id"])):
        raise ValueError("scheduler receipt is not an authenticated observation of the installed TS service")
    stamp = receipt["observed_at_unix_ms"]
    current = now_ms()
    if (not isinstance(stamp, int) or isinstance(stamp, bool) or stamp < max(minimum, current - MAX_AGE_MS)
            or stamp > current + 5000):
        raise ValueError("scheduler readiness proof is stale")
    request = fields(receipt["request"], ("endpoint", "challenge"), ("probe",))
    if (request["endpoint"] != ENDPOINT or not isinstance(request["challenge"], str)
            or not HASH.fullmatch(request["challenge"]) or (challenge is not None and request["challenge"] != challenge)):
        raise ValueError("scheduler readiness challenge or endpoint is different")
    response = fields(receipt["response"], ("version", "kind", "challenge", "observedAt", "process", "runtime",
                                           "canonical", "migration_ready", "readiness_scope", "probe"), ("quarantine",))
    if stage not in ("preflight", "consumer"):
        raise ValueError("unknown scheduler readiness stage")
    operational = stage == "consumer"
    observed_at = instant(response["observedAt"])
    if (response["version"] != 1 or response["kind"] != "herder-canonical-runtime-status"
            or response["challenge"] != request["challenge"] or response["migration_ready"] is not operational
            or response["readiness_scope"] != ("operational" if operational else "preflight")
            or receipt["response_sha256"] != json_hash(response) or observed_at < max(minimum, current - MAX_AGE_MS)
            or observed_at > stamp + 1000 or stamp - observed_at > 15000):
        raise ValueError("scheduler response is stale, incomplete or not tied to this request")
    if not isinstance(response["runtime"], dict) or response["runtime"].get("source_commit") != source_commit:
        raise ValueError("TS runtime and native candidate must use the same source commit")
    identity = {key: response[key] for key in ("process", "runtime", "canonical")}
    if expected is not None and any(identity[key] != expected[key] for key in identity):
        raise ValueError("scheduler proof changed PID, source, configuration or migration epoch")
    config = writer_drain(identity["canonical"])
    quarantine_response(config, response.get("quarantine"), operational=operational)
    if stage == "preflight":
        if "probe" in request or response["probe"] is not None or "job_id" in receipt:
            raise ValueError("preflight must not depend on an old native core API")
    elif stage == "consumer":
        if receipt.get("job_id") != job_id or expected is None or challenge is None:
            raise ValueError("scheduler consumer proof does not belong to this rollout")
        probe_request = fields(request.get("probe"), ("harness", "native_session_id"), ("node_ref",))
        if not all(exact(value, 512) for value in probe_request.values()):
            raise ValueError("scheduler probe has an invalid native identity")
        probe = fields(response["probe"], ("request", "decision", "gateBlocked"))
        decision = fields(probe["decision"], ("version", "configured", "complete", "blocked", "reason", "mapped",
                                              "sessionRefs", "ruleRefs", "observedAt"))
        if (probe["request"] != probe_request or decision["version"] != 1 or decision["configured"] is not True
                or decision["complete"] is not True or not isinstance(decision["blocked"], bool)
                or not isinstance(decision["mapped"], bool) or not exact(decision["reason"], 1024)
                or not isinstance(probe["gateBlocked"], bool) or probe["gateBlocked"] != decision["blocked"]):
            raise ValueError("actual TS process-wait gate did not return a complete canonical decision")
        for key in ("sessionRefs", "ruleRefs"):
            if (not isinstance(decision[key], list) or len(decision[key]) > 10000
                    or not all(exact(value, 512) for value in decision[key]) or len(set(decision[key])) != len(decision[key])):
                raise ValueError("canonical gate returned invalid scoped references")
        if decision["mapped"] != bool(decision["sessionRefs"]):
            raise ValueError("canonical gate returned inconsistent mapping evidence")
        decision_at = instant(decision["observedAt"])
        if decision_at < max(minimum, current - MAX_AGE_MS) or decision_at > observed_at + 1000:
            raise ValueError("canonical gate result is not fresh after the native restart")
    else:
        raise ValueError("unknown scheduler readiness stage")
    observed = observe(expected if expected is not None else identity)
    return {"identity": observed, "provider_operation_id": receipt["provider_operation_id"],
            "response_sha256": receipt["response_sha256"], "observed_at_unix_ms": stamp,
            "request": request, "gate": response["probe"], "readiness_scope": response["readiness_scope"],
            **({"quarantine": response["quarantine"]} if "quarantine" in response else {})}
