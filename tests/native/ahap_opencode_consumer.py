#!/usr/bin/env python3
"""Validate and launch one AHAP -> OpenCode consumer case in the native fixture.

The immutable artifact handoff is a JSON manifest with these fields:
  core: absolute path to the Rust AHAP client executable
  adapter: absolute path to the built TypeScript AHAP runner entrypoint
  opencode: absolute path to the real OpenCode executable
  sha256: exact handoff digest for each artifact above
  adapter_source_commits: source commits embedded in the adapter build
  launch: argv template for the existing native launcher/stand; tokens
          {core}, {adapter}, {opencode} are replaced with immutable paths.

The fixture model is injected only by tests/native/launch.py. No model or
adapter is mocked here. The stand command is supplied by the artifact owner
because the runner's final CLI contract is part of that handoff.

Run via the existing launcher, which mounts artifact_root read-only:
  python3 tests/native/launch.py --scenario text --candidate RELEASE -- \
    /usr/bin/python3 tests/native/ahap_opencode_consumer.py HANDOFF.json
Add launch.py's --retain-on-failure PATH before -- to preserve failed scratch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


TOKENS = ("{core}", "{adapter}", "{opencode}")
REQUIRED_ADAPTER_COMMIT = "c3b5aa58"
MAX_MANIFEST = 64 * 1024


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("artifact manifest must be a regular absolute file")
    if path.stat().st_size > MAX_MANIFEST:
        raise ValueError("artifact manifest exceeds size limit")
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict):
        raise ValueError("artifact manifest must be an object")
    artifacts = {}
    root_value = manifest.get("artifact_root")
    if not isinstance(root_value, str):
        raise ValueError("missing absolute immutable artifact_root")
    root = Path(root_value)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("artifact_root must be an immutable absolute directory")
    for name in ("core", "adapter", "opencode"):
        value = manifest.get(name)
        if not isinstance(value, str):
            raise ValueError(f"missing absolute {name} artifact path")
        artifact = Path(value)
        if not artifact.is_absolute() or artifact.is_symlink() or not artifact.is_file():
            raise ValueError(f"{name} must be a regular absolute file")
        if not artifact.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"{name} must be inside artifact_root for read-only fixture mounting")
        artifacts[name] = artifact
    digests = manifest.get("sha256")
    if not isinstance(digests, dict):
        raise ValueError("missing artifact SHA-256 handoff digests")
    for name, artifact in artifacts.items():
        expected = digests.get(name)
        if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            raise ValueError(f"invalid {name} SHA-256 handoff digest")
        if sha256(artifact) != expected:
            raise ValueError(f"{name} artifact SHA-256 does not match handoff")
    commits = manifest.get("adapter_source_commits")
    if not isinstance(commits, list) or not all(isinstance(c, str) for c in commits):
        raise ValueError("adapter_source_commits must list the runner build provenance")
    if not any(c == REQUIRED_ADAPTER_COMMIT or c.startswith(REQUIRED_ADAPTER_COMMIT)
               for c in commits):
        raise ValueError(f"adapter build must include runner fix {REQUIRED_ADAPTER_COMMIT}")
    command = manifest.get("launch")
    if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
        raise ValueError("launch must be a non-empty argv array")
    joined = "\0".join(command)
    if not all(token in joined for token in TOKENS):
        raise ValueError("launch must bind core, adapter, and OpenCode artifacts")
    if any("{model}" in arg or "{model_url}" in arg for arg in command):
        raise ValueError("model endpoint is controlled exclusively by launch.py")
    return manifest, artifacts, command


def render_command(template, artifacts):
    result = []
    replacements = {f"{{{name}}}": str(path) for name, path in artifacts.items()}
    for arg in template:
        for marker, value in replacements.items():
            arg = arg.replace(marker, value)
        result.append(arg)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="immutable artifact handoff JSON")
    parser.add_argument("--timeout", type=int, default=150)
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 300:
        parser.error("timeout must be between 1 and 300 seconds")
    manifest, artifacts, template = load_manifest(args.manifest)
    command = render_command(template, artifacts)
    if not Path(command[0]).is_absolute():
        raise ValueError("launch executable must be absolute")
    receipt = {name: {"path": str(path), "sha256": sha256(path)}
               for name, path in artifacts.items()}
    print(json.dumps({"phase": "artifact-preflight", "artifacts": receipt,
                      "launch": command, "timeout_seconds": args.timeout}, sort_keys=True), flush=True)
    if not os.environ.get("HERDER_TEST_MODEL_BASE_URL", "").startswith("http://127.0.0.1:"):
        raise ValueError("consumer must be started inside tests/native/launch.py")
    env = dict(os.environ)
    env.pop("OPENAI_API_KEY", None)
    env.pop("ANTHROPIC_API_KEY", None)
    try:
        completed = subprocess.run(command, env=env, check=False, timeout=args.timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"AHAP/OpenCode consumer timed out after {args.timeout}s") from error
    if completed.returncode:
        print(json.dumps({"phase": "consumer-failed", "returncode": completed.returncode,
                          "artifacts": receipt}, sort_keys=True), file=sys.stderr, flush=True)
    else:
        print(json.dumps({"phase": "consumer-exited", "returncode": 0,
                          "artifacts": receipt}, sort_keys=True), flush=True)
    return completed.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        print(f"AHAP consumer preflight failed: {error}", file=sys.stderr)
        sys.exit(2)
