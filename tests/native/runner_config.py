#!/usr/bin/env python3
"""Validate an OpenCode artifact and print argv for the existing isolated stand.

Dry-run is the only operation: it never launches a process or sends a message.
Paths in the config are absolute; artifact paths may also be relative to artifact_root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys


class ConfigError(ValueError):
    pass


def read_json(path, label):
    try:
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, UnicodeError):
        raise ConfigError(f"{label}: cannot read valid JSON") from None
    if not isinstance(data, dict):
        raise ConfigError(f"{label}: expected an object")
    return data


def required_string(obj, key, label):
    value = obj.get(key)
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ConfigError(f"{label}.{key}: expected a nonempty string")
    return value


def file_path(value, label, executable=False):
    path = Path(value)
    try:
        if not path.is_absolute() or not path.is_file():
            raise ConfigError(f"{label}: expected an existing absolute regular file")
        if executable and not os.access(path, os.X_OK):
            raise ConfigError(f"{label}: file is not executable")
        return str(path.resolve(strict=True))
    except OSError:
        raise ConfigError(f"{label}: cannot access file") from None


def build(config):
    if not isinstance(config, dict):
        raise ConfigError("config: expected an object")
    capabilities = config.get("capabilities")
    if not isinstance(capabilities, dict):
        raise ConfigError("config.capabilities: expected an object")
    os_name = required_string(capabilities, "os", "capabilities")
    arch = required_string(capabilities, "arch", "capabilities")
    backend = required_string(capabilities, "backend", "capabilities")
    if os_name != "linux" or backend != "linux-netns-bwrap":
        raise ConfigError("capabilities: only linux with linux-netns-bwrap is supported")
    if platform.system().lower() != os_name or platform.machine().lower() != arch.lower():
        raise ConfigError("capabilities: configured OS/architecture does not match this host")
    # launch.py uses both the inherited PATH and os.defpath in its sandbox.
    for tool in ("unshare", "bwrap", "ip"):
        if not shutil.which(tool) or not shutil.which(tool, path=os.defpath):
            raise ConfigError(f"capabilities: required executable {tool} is unavailable")
    paths = {}
    for name in ("python", "node", "bootstrap", "stand", "launcher"):
        paths[name] = file_path(required_string(config, name, "config"), name,
                                executable=name in ("python", "node", "bootstrap"))
    file_path(str(Path(paths["launcher"]).with_name("test-model-server.py")), "launcher fixture")
    root = Path(required_string(config, "artifact_root", "config"))
    try:
        if not root.is_absolute() or not root.is_dir():
            raise ConfigError("artifact_root: expected an existing absolute directory")
        root = root.resolve(strict=True)
    except OSError:
        raise ConfigError("artifact_root: cannot access directory") from None
    manifest_path = file_path(required_string(config, "manifest", "config"), "manifest")
    manifest = read_json(manifest_path, "manifest")
    commit = required_string(manifest, "source_commit", "manifest")
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", commit):
        raise ConfigError("manifest.source_commit: expected a full hexadecimal commit")
    launch = manifest.get("launch")
    if not isinstance(launch, list) or not launch or any(not isinstance(x, str) or not x or len(x) > 4096 for x in launch):
        raise ConfigError("manifest.launch: expected a nonempty argv list")
    hashes = manifest.get("sha256")
    if not isinstance(hashes, dict):
        raise ConfigError("manifest.sha256: expected an object")
    identities = {}
    for name in ("core", "adapter", "opencode"):
        value = required_string(manifest, name, "manifest")
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = root / candidate
        resolved = Path(file_path(str(candidate), name, executable=name != "adapter"))
        if not resolved.is_relative_to(root):
            raise ConfigError(f"manifest.{name}: artifact is outside artifact_root")
        digest = required_string(hashes, name, "manifest.sha256")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise ConfigError(f"manifest.sha256.{name}: expected SHA-256")
        try:
            with resolved.open("rb") as stream:
                hasher = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(chunk)
                actual = hasher.hexdigest()
        except OSError:
            raise ConfigError(f"manifest.{name}: cannot hash artifact") from None
        if actual != digest.lower():
            raise ConfigError(f"manifest.{name}: SHA-256 mismatch")
        paths[name] = str(resolved)
        identities[name] = actual
    stand_dir = Path(paths["stand"]).parent
    if stand_dir in (Path("/"), Path("/tmp"), Path.home()):
        raise ConfigError("stand: containing directory is too broad to mount")
    mounts = [str(stand_dir), *(paths[name] for name in ("python", "node", "bootstrap", "core", "adapter", "opencode"))]
    argv = [paths["python"], paths["launcher"]]
    for mount in dict.fromkeys(mounts):
        argv.extend(["--ro-bind", mount])
    argv.extend(["--", paths["python"], paths["stand"],
                 "--core", paths["core"], "--runner", paths["adapter"], "--opencode", paths["opencode"],
                 "--node", paths["node"], "--bootstrap", paths["bootstrap"]])
    return {"argv": argv, "identities": {"source_commit": commit.lower(), "sha256": identities,
                                            "os": os_name, "arch": arch, "backend": backend}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(build(read_json(args.config, "config")), sort_keys=True))
    except (ConfigError, OSError, ValueError):
        error = sys.exc_info()[1]
        print(f"runner config: {error if isinstance(error, ConfigError) else 'invalid input'}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
