#!/usr/bin/env python3
"""Build a release candidate with its manifest for ANY requested head.

One command builds the release and the manifest for a given sha, so the
candidate is never frozen on a head that has already moved. The build happens
in its own worktree and its own catalog: the live runtime on server-100 and
the fleet nodes are never touched, and the manifest of the installed release
is never overwritten.

    python3 deploy/fleet/build-release-candidate.py --sha 492628e

The checks at the end are the acceptance criteria of a candidate:
  * manifest.source_sha is the full sha of the requested head;
  * the payload lists every file of the build and sha256(dist/index.js) is the
    payload hash of index.js;
  * node-config.sourceSha equals manifest.source_sha, and node-config and the
    `current` symlink move together;
  * the package directory is named exactly node_modules;
  * the release fits the launcher budget (<= 512 MiB), and the node release
    directory keeps at most two releases.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path.home() / "agents-projects/agent-herder"
DEFAULT_WORKTREES = Path.home() / "agents-projects/.worktrees"
DEFAULT_CATALOG = Path.home() / "agents-projects/.fleet-candidate"
BUDGET_MIB = 512
MAX_NODE_RELEASES = 2


def run(command, cwd=None):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_tree(root: Path) -> dict:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        if name == "fleet-deployment-manifest.json":
            continue
        result[name] = sha256(path)
    return result


def worktree_for(sha: str, worktrees: Path) -> Path:
    return worktrees / f"herder-fleet-candidate-{sha[:8]}"


def materialize_packages(worktree: Path):
    """Give the worktree its own node_modules of symlinks.

    A single symlink to the shared store is not enough: the workspace links
    inside it (node_modules/<pkg> -> ../packages/<pkg>) are relative, so they
    resolve into the SHARED store - the workspace package of the live checkout
    gets built instead of the one of this head, and the release is contaminated
    by another tree. Owning the directory makes every relative link resolve
    inside the worktree, while the packages themselves stay shared.
    """
    store = REPO / "node_modules"
    target = worktree / "node_modules"
    if target.is_symlink():
        target.unlink()
    if target.exists():
        return
    target.mkdir(parents=True, exist_ok=True)
    for entry in sorted(store.iterdir()):
        if entry.name == ".bin":
            binary = target / ".bin"
            binary.mkdir(exist_ok=True)
            for item in entry.iterdir():
                os.symlink(os.path.realpath(item), binary / item.name)
            continue
        if entry.name.startswith("@") and entry.is_dir():
            scope = target / entry.name
            scope.mkdir(exist_ok=True)
            for item in entry.iterdir():
                os.symlink(os.path.realpath(item), scope / item.name)
            continue
        if entry.is_symlink():
            resolved = entry.resolve()
            packages = REPO / "packages"
            if str(resolved).startswith(str(packages)):
                # A workspace package: link the one of this worktree.
                relative = os.path.relpath(worktree / "packages" / resolved.relative_to(packages), target)
                os.symlink(relative, target / entry.name)
                continue
            os.symlink(resolved, target / entry.name)
            continue
        os.symlink(entry, target / entry.name)


def prepare_worktree(sha: str, worktrees: Path) -> Path:
    worktree = worktree_for(sha, worktrees)
    branch = f"fleet/candidate-{sha[:8]}"
    if not worktree.exists():
        run(["git", "-C", str(REPO), "worktree", "add", str(worktree), "-b", branch, sha])
    materialize_packages(worktree)
    return worktree


def build(worktree: Path):
    run(["npm", "run", "build"], cwd=str(worktree))


def write_manifest(worktree: Path, receipt: Path):
    writer = worktree / "deploy" / "fleet" / "write-deployment-manifest.py"
    run(["python3", str(writer), "capture", "--root", str(worktree), "--receipt", str(receipt)])
    run(["python3", str(writer), "write", "--root", str(worktree), "--dist", str(worktree / "dist"), "--receipt", str(receipt)])
    run(["python3", str(writer), "verify", "--root", str(worktree), "--dist", str(worktree / "dist")])


def assemble(sha: str, worktree: Path, catalog: Path) -> Path:
    release = catalog / "releases" / sha
    release.mkdir(parents=True, exist_ok=True)
    shutil.copytree(worktree / "dist", release / "dist", dirs_exist_ok=True)
    packages = release / "node_modules"
    if not packages.exists():
        packages.symlink_to(REPO / "node_modules")
    manifest = json.loads((release / "dist" / "fleet-deployment-manifest.json").read_text())
    node_config = {
        "note": "candidate template: the rollout writes the node's native values, sourceSha stays this sha",
        "candidate": True,
        "hostId": "<node-host-id>",
        "harnesses": ["codex"],
        "sourceSha": manifest["source_sha"],
        "nodeBin": "/usr/bin/node",
        "webPort": 18789,
        "codexSocket": "<managed-codex-socket>",
        "codexBin": "<codex-binary>",
    }
    (catalog / "node-config.json").write_text(json.dumps(node_config, indent=2) + "\n")
    current = catalog / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(Path("releases") / sha)
    return release


def checks(sha: str, release: Path, catalog: Path) -> list:
    manifest = json.loads((release / "dist" / "fleet-deployment-manifest.json").read_text())
    payload = manifest["payload"]
    actual = sha256_tree(release / "dist")
    missing = sorted(set(actual) - set(payload))
    extra = sorted(set(payload) - set(actual))
    mismatched = sorted(name for name in set(payload) & set(actual) if payload[name] != actual[name])
    index_actual = sha256(release / "dist" / "index.js")
    node_config = json.loads((catalog / "node-config.json").read_text())
    packages = release / "node_modules"
    size_mib = round(sum(path.stat().st_size for path in release.rglob("*")
                          if path.is_file() and not path.is_symlink()) / 1024 / 1024, 1)
    node_releases = Path.home() / ".local/share/agent-herder/fleet/releases"
    node_dirs = sorted(p.name for p in node_releases.iterdir() if p.is_dir()) if node_releases.is_dir() else []
    return [
        ("manifest.source_sha == requested head", manifest["source_sha"] == sha, f"{manifest['source_sha']} vs {sha}"),
        ("source_dirty is false", manifest.get("source_dirty") is False, str(manifest.get("source_dirty"))),
        ("payload lists every build file", not missing and not extra and not mismatched,
         f"payload={len(payload)} files={len(actual)} missing={len(missing)} extra={len(extra)} mismatched={len(mismatched)}"),
        ("sha256(dist/index.js) == payload['index.js']", index_actual == payload.get("index.js"), index_actual),
        ("node-config.sourceSha == manifest.source_sha", node_config["sourceSha"] == manifest["source_sha"], node_config["sourceSha"]),
        ("current points at the candidate release", os.readlink(catalog / "current") == f"releases/{sha}", os.readlink(catalog / "current")),
        ("packages dir is named exactly node_modules", packages.name == "node_modules" and packages.is_symlink(), str(packages)),
        ("release size within the launcher budget", size_mib <= BUDGET_MIB, f"{size_mib} MiB <= {BUDGET_MIB} MiB"),
        ("node release dir keeps at most two releases", len(node_dirs) <= MAX_NODE_RELEASES, f"{len(node_dirs)}: {node_dirs}"),
    ], manifest, size_mib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True, help="the head to build, any commit sha")
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    parser.add_argument("--worktrees", default=str(DEFAULT_WORKTREES))
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing build of the same head")
    arguments = parser.parse_args()

    sha = run(["git", "-C", str(REPO), "rev-parse", arguments.sha])
    worktree = prepare_worktree(sha, Path(arguments.worktrees))
    if not arguments.skip_build:
        build(worktree)
    receipt = Path("/tmp") / f"candidate-receipt-{sha[:8]}.json"
    write_manifest(worktree, receipt)
    release = assemble(sha, worktree, Path(arguments.catalog))
    results, manifest, size_mib = checks(sha, release, Path(arguments.catalog))

    print("== candidate release ==")
    print(f"script       : {Path(__file__).resolve()}")
    print(f"requested sha: {arguments.sha}")
    print(f"catalog      : {arguments.catalog}")
    print(f"release      : {release}")
    print(f"worktree     : {worktree}")
    print(f"source_sha   : {manifest['source_sha']}")
    print(f"payload files: {len(manifest['payload'])}")
    print(f"sha256 index : {sha256(release / 'dist' / 'index.js')}")
    print(f"size         : {size_mib} MiB")
    print("== checks ==")
    failed = 0
    for name, ok, detail in results:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1
    print(f"== {len(results) - failed}/{len(results)} checks passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
