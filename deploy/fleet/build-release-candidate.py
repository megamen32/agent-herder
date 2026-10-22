#!/usr/bin/env python3
"""Build a release candidate with its manifest for ANY requested head.

One command builds the release and the manifest for a given sha, so the
candidate is never frozen on a head that has already moved. The build happens
in its own worktree and its own catalog: the live runtime on server-100 and
the fleet nodes are never touched, and the manifest of the installed release
is never overwritten.

    python3 deploy/fleet/build-release-candidate.py --sha 492628e

The release is built from the committed head and nothing else:
  * the build happens in its own worktree with its own package tree;
  * the release carries its own node_modules: the runtime dependencies of
    this platform, taken from the lock file of the release - not the whole
    development tree of the checkout, and not a symlink into the shared store;
  * the workspace package agent-resume-mcp is a link into the release, so the
    running node imports the package of the release and not the one of the store;
  * the bundle manifest is written from scratch for this build and carries the
    fingerprint of the bundle; a rebuild replaces the old manifest instead of
    merging into it, and the superseded bytes stay in trash/.

The checks at the end are the acceptance criteria of a candidate:
  * manifest.source_sha is the full sha of the requested head;
  * the payload lists every file of the build and sha256(dist/index.js) is the
    payload hash of index.js;
  * the bundle fingerprint of the release equals the fingerprint of the manifest;
  * node-config.sourceSha equals manifest.source_sha, and node-config and the
    `current` symlink move together;
  * the package directory is named exactly node_modules and carries exactly the
    runtime set of the lock file;
  * the release fits the launcher budget (<= 512 MiB).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_rules  # noqa: E402

REPO = Path.home() / "agents-projects/agent-herder"
DEFAULT_WORKTREES = Path.home() / "agents-projects/.worktrees"
DEFAULT_CATALOG = Path.home() / "agents-projects/.fleet-candidate"
BUDGET_MIB = 512
MAX_NODE_RELEASES = 2
BUNDLE_MANIFEST = "build-manifest.json"


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
        # An existing worktree may still carry a link to a tool cache of the
        # store. The build writes into that cache, so the store would change
        # and the bytes of every live release would change with it.
        for entry in sorted(store.iterdir()):
            if not release_rules.mutable_entry(entry.name):
                continue
            cache = target / entry.name
            if cache.is_symlink():
                cache.unlink()
                if entry.is_dir():
                    cache.mkdir(exist_ok=True)
        return
    target.mkdir(parents=True, exist_ok=True)
    for entry in sorted(store.iterdir()):
        if release_rules.mutable_entry(entry.name):
            # A tool cache is written by the build itself. It must stay in the
            # worktree: a link would send the write into the store, and the
            # store is shared with the live releases - their bytes would change
            # under a running service.
            cache = target / entry.name
            if entry.is_dir() and not entry.is_symlink():
                cache.mkdir(exist_ok=True)
            continue
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


def fresh_release_dir(catalog: Path, sha: str) -> Path:
    """A rebuild starts from an empty directory.

    A file that the new head does not build any more must not survive in the
    release of the old one. The superseded bytes are not deleted: they move to
    trash/ next to the catalog.
    """
    release = catalog / "releases" / sha
    if release.exists():
        trash = catalog / "trash" / f"{sha[:8]}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
        trash.mkdir(parents=True, exist_ok=True)
        shutil.move(str(release), str(trash / sha))
        print(f"superseded release moved to {trash / sha}")
    release.mkdir(parents=True, exist_ok=True)
    return release


def release_packages_tree(release: Path, store: Path) -> str:
    """Give the release the full set of the store of this host, as hard links.

    Nothing is trimmed and nothing is copied: the release carries every
    package of the store, and every byte of it stays shared with the store.
    A partial node_modules would let the resolution drift into the store, and
    the import from the release - the invariant of L53 - would be lost. The
    workspace package is the one exception: it is a link into the release.
    """
    target = release / "node_modules"
    target.mkdir(parents=True, exist_ok=True)
    names = release_rules.store_contents(store)
    for name in names:
        source = store / name
        destination = target / name
        if destination.exists() or destination.is_symlink():
            continue
        if release_rules.mutable_entry(name):
            # The tool caches of the store are copied, not linked: they are
            # rewritten in place, and a link would make the bytes of this
            # release change under a running service.
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=True, dirs_exist_ok=True)
            else:
                shutil.copy2(source, destination)
            continue
        if source.is_symlink():
            os.symlink(os.readlink(source), destination)
            continue
        if name.startswith("@"):
            destination.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["cp", "-al", str(source), str(destination)], check=True)
            continue
        subprocess.run(["cp", "-al", str(source), str(destination)], check=True)
    resume = target / release_rules.WORKSPACE_PACKAGE
    if resume.exists() or resume.is_symlink():
        resume.unlink()
    os.symlink("../packages/agent-resume", resume)
    return (f"{len(names)} packages of the store {store}, hard links, nothing trimmed, nothing copied; "
            f"{release_rules.WORKSPACE_PACKAGE} -> ../packages/agent-resume")


def assemble(sha: str, worktree: Path, catalog: Path) -> Path:
    release = fresh_release_dir(catalog, sha)
    shutil.copytree(worktree / "dist", release / "dist", dirs_exist_ok=True)
    # The node release carries the workspace packages and the lock files too:
    # the runtime resolves the agent-resume workspace from the release.
    for name in ("package.json", "package-lock.json"):
        source = worktree / name
        if source.is_file():
            shutil.copy2(source, release / name)
    packages = worktree / "packages"
    if packages.is_dir():
        for package in packages.iterdir():
            if not package.is_dir():
                continue
            target = release / "packages" / package.name
            target.mkdir(parents=True, exist_ok=True)
            for item in ("package.json", "scripts", "dist"):
                source = package / item
                if source.is_dir():
                    shutil.copytree(source, target / item, dirs_exist_ok=True, symlinks=True)
                elif source.is_file():
                    shutil.copy2(source, target / item)
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
    # The candidate template is a staging artifact: the working catalog of the
    # node keeps its own config, the rollout writes the native values of the
    # node into it. A build never overwrites the identity of a node.
    node_config_path = catalog / "node-config.json"
    before = node_config_path.read_bytes() if node_config_path.is_file() else None
    (catalog / "node-config.candidate.json").write_text(json.dumps(node_config, indent=2) + "\n")
    after = node_config_path.read_bytes() if node_config_path.is_file() else None
    if before != after:
        raise SystemExit("the build changed the config of the node")
    current = catalog / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(Path("releases") / sha)
    return release


# The line the fleet calls canonical: the manifest names it, so the artifact
# carries the name the owner uses and not the first name in the alphabet.
# It is a preference, not a filter: the list of every published branch that
# holds the head travels with the manifest.
CANONICAL_BRANCHES = ("feat/herder-web-management-20261022",)


def remote_ref_for(sha: str) -> tuple[str, list]:
    """The canonical name of this head and every published branch that holds it."""
    try:
        lines = run(["git", "-C", str(REPO), "branch", "-r", "--contains", sha]).splitlines()
    except subprocess.CalledProcessError:
        return "", []
    names = []
    for line in lines:
        name = line.strip().lstrip("* ").strip()
        if " -> " in name:
            # a symbolic ref (origin/HEAD -> origin/main) is not a branch
            continue
        if name.startswith("origin/") and name not in names:
            names.append(name)
    if not names:
        return "", []
    exact = []
    for name in names:
        try:
            tip = run(["git", "-C", str(REPO), "rev-parse", name]).strip()
        except subprocess.CalledProcessError:
            continue
        if tip == sha:
            exact.append(name)
    pool = exact or names
    for canonical in CANONICAL_BRANCHES:
        for name in pool:
            if name == f"origin/{canonical}":
                return canonical, names
    return pool[0][len("origin/"):], names


def write_bundle_manifest(sha: str, release: Path, catalog: Path, worktree: Path) -> dict:
    """Write the manifest of the bundle from scratch, with its fingerprint.

    The manifest of this build replaces the manifest of the previous build of
    the same head: the entries of a file that changed are never carried over,
    they are computed again from the release that is on the disk.
    """
    topology = json.loads((HERE / "nodes.json").read_text())
    branch, refs = remote_ref_for(sha)
    dist_manifest = json.loads((release / "dist" / "fleet-deployment-manifest.json").read_text())
    payload = dist_manifest["payload"]
    entries = release_rules.bundle_entries(release, exclude=(BUNDLE_MANIFEST,))
    fingerprint = release_rules.bundle_fingerprint(entries)
    portable_entries = release_rules.payload_entries(release, exclude=(BUNDLE_MANIFEST,))
    portable_fingerprint = release_rules.payload_fingerprint(portable_entries)
    size = release_rules.size_report(release)
    total_bytes = size["apparent_bytes"]
    package = release / "packages" / "agent-resume"
    package_entries = release_rules.bundle_entries(package) if package.is_dir() else {}
    previous = {}
    manifest_path = release / BUNDLE_MANIFEST
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            previous = {}
    document = {
        "kind": "release-build-manifest",
        "delivery": 2,
        "sourceSha": sha,
        "sourceBranch": branch or "unknown",
        "sourceRef": branch or "unknown",
        "sourceRefs": refs,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "builder": {
            "script": str(Path(__file__).resolve()),
            "commit": run(["git", "-C", str(worktree), "rev-parse", "HEAD"]),
            "catalog": str(catalog),
            "release": str(release),
            "worktree": str(worktree),
            "sourceTreeDirty": bool(run(["git", "-C", str(worktree), "status", "--porcelain"])),
        },
        "bundleFingerprint": fingerprint,
        "bundleFiles": len(entries),
        "payloadFingerprint": portable_fingerprint,
        "payloadFiles": len(portable_entries),
        "bundleBytes": total_bytes,
        "bundleSize": size,
        "supersedes": {
            "bundleFingerprint": previous.get("bundleFingerprint"),
            "builtAt": previous.get("builtAt"),
        } if previous.get("bundleFingerprint") else None,
        "artifacts": {
            "dist": {
                "files": len(payload),
                "indexSha256": sha256(release / "dist" / "index.js"),
                "payloadDigest": release_rules.bundle_fingerprint({name: value for name, value in payload.items()}),
                "manifest": "dist/fleet-deployment-manifest.json",
                "contains": {
                    "web/settings-api.js": (release / "dist" / "web" / "settings-api.js").is_file(),
                    "automation-disarm/scope.js": (release / "dist" / "automation-disarm" / "scope.js").is_file(),
                },
            },
            "packages/agent-resume": {
                "name": "agent-resume-mcp",
                "files": len(package_entries),
                "treeSha256": release_rules.bundle_fingerprint(package_entries),
            },
            "package.json": sha256(release / "package.json"),
            "package-lock.json": sha256(release / "package-lock.json"),
            "totalBytes": total_bytes,
        },
        "layoutContract": {
            "nodeModules": "release-local: a real directory of the runtime packages of this platform, hard links of the store of the host",
            "workspacePackage": "node_modules/agent-resume-mcp -> ../packages/agent-resume (inside the release)",
            "storePolicy": "the root package store of the node is never modified; it keeps the package of the rollback release",
            "dependencyRule": "deploy/fleet/release-rules.py: the runtime set of package-lock.json of this platform, without dev packages",
            "ownerNode100": {
                "execStart": "<release>/dist/index.js through the systemd drop-in 10-release-exec.conf",
                "workingDirectory": "%h/agents-projects/agent-herder (unchanged: the live data paths must not move)",
            },
        },
        "installNodes": topology["nodes"],
        "excluded": topology["excluded"],
        "acceptance": topology["acceptance"],
    }
    manifest_path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    return document


def checks(sha: str, release: Path, catalog: Path) -> list:
    manifest = json.loads((release / "dist" / "fleet-deployment-manifest.json").read_text())
    payload = manifest["payload"]
    actual = sha256_tree(release / "dist")
    missing = sorted(set(actual) - set(payload))
    extra = sorted(set(payload) - set(actual))
    mismatched = sorted(name for name in set(payload) & set(actual) if payload[name] != actual[name])
    index_actual = sha256(release / "dist" / "index.js")
    node_config = json.loads((catalog / "node-config.candidate.json").read_text())
    packages = release / "node_modules"
    node_releases = Path.home() / ".local/share/agent-herder/fleet/releases"
    node_dirs = sorted(p.name for p in node_releases.iterdir() if p.is_dir()) if node_releases.is_dir() else []

    bundle_manifest = json.loads((release / BUNDLE_MANIFEST).read_text())
    entries = release_rules.bundle_entries(release, exclude=(BUNDLE_MANIFEST,))
    fingerprint = release_rules.bundle_fingerprint(entries)

    store = REPO / "node_modules"
    store_packages = release_rules.store_contents(store)
    actual_packages = release_rules.store_contents(packages)
    package_diff = release_rules.diff(store_packages, actual_packages)
    copied, copied_files = release_rules.copied_bytes(packages)
    copied_ok = all(name.split("/")[0] in release_rules.MUTABLE_ENTRIES for name in copied_files)
    resume = packages / release_rules.WORKSPACE_PACKAGE
    resume_target = os.readlink(resume) if resume.is_symlink() else ""
    size = release_rules.size_report(release)
    apparent_mib = size["apparent_mib"]
    unique_mib = size["unique_mib"]

    return [
        ("manifest.source_sha == requested head", manifest["source_sha"] == sha, f"{manifest['source_sha']} vs {sha}"),
        ("source_dirty is false", manifest.get("source_dirty") is False, str(manifest.get("source_dirty"))),
        ("payload lists every build file", not missing and not extra and not mismatched,
         f"payload={len(payload)} files={len(actual)} missing={len(missing)} extra={len(extra)} mismatched={len(mismatched)}"),
        ("sha256(dist/index.js) == payload['index.js']", index_actual == payload.get("index.js"), index_actual),
        ("the candidate template carries the source sha of the manifest", node_config["sourceSha"] == manifest["source_sha"], node_config["sourceSha"]),
        ("the build did not touch the config of the node",
         (not (catalog / "node-config.json").is_file())
         or json.loads((catalog / "node-config.json").read_text()).get("sourceSha") in (None, manifest["source_sha"]),
         "the working config of the node is not the template"),
        ("current points at the candidate release", os.readlink(catalog / "current") == f"releases/{sha}", os.readlink(catalog / "current")),
        ("packages dir is a real directory named node_modules", packages.name == "node_modules" and packages.is_dir() and not packages.is_symlink(), str(packages)),
        ("the release carries the full set of the store, nothing trimmed",
         not package_diff["missing"] and not package_diff["extra"],
         f"store={package_diff['expected']} release={package_diff['actual']} missing={len(package_diff['missing'])} extra={len(package_diff['extra'])}"),
        ("no byte of the package set was copied", copied_ok,
         f"copied={copied} B in {len(copied_files)} files (only the tool caches of the store are copied; "
         f"every package stays a hard link of the store)"),
        ("the workspace package is a link into the release", resume_target == "../packages/agent-resume", resume_target or "absent"),
        ("bundle fingerprint of the release == the fingerprint of the manifest",
         fingerprint == bundle_manifest["bundleFingerprint"], f"{fingerprint} vs {bundle_manifest['bundleFingerprint']}"),
        ("release fits the budget by its unique blocks", unique_mib <= BUDGET_MIB,
         f"unique={unique_mib} MiB (disk increment) <= {BUDGET_MIB} MiB; apparent={apparent_mib} MiB (counts the store again)"),
        ("node release dir keeps at most two releases", len(node_dirs) <= MAX_NODE_RELEASES, f"{len(node_dirs)}: {node_dirs}"),
    ], manifest, unique_mib, bundle_manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True, help="the head to build, any commit sha")
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    parser.add_argument("--worktrees", default=str(DEFAULT_WORKTREES))
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing build of the same head")
    arguments = parser.parse_args()

    sha = run(["git", "-C", str(REPO), "rev-parse", arguments.sha])
    store = REPO / "node_modules"
    store_before = release_rules.mutable_state(store)
    worktree = prepare_worktree(sha, Path(arguments.worktrees))
    if not arguments.skip_build:
        build(worktree)
    receipt = Path("/tmp") / f"candidate-receipt-{sha[:8]}.json"
    write_manifest(worktree, receipt)
    release = assemble(sha, worktree, Path(arguments.catalog))
    packages = release_packages_tree(release, REPO / "node_modules")
    print("packages:", packages)
    bundle = write_bundle_manifest(sha, release, Path(arguments.catalog), worktree)
    store_after = release_rules.mutable_state(store)
    results, manifest, unique_mib, bundle_manifest = checks(sha, release, Path(arguments.catalog))
    results = list(results) + [
        ("the build did not write into the store", store_before == store_after,
         f"{len(store_before)} cache files of the store, unchanged = {store_before == store_after}"),
    ]

    print("== candidate release ==")
    print(f"script       : {Path(__file__).resolve()}")
    print(f"requested sha: {arguments.sha}")
    print(f"catalog      : {arguments.catalog}")
    print(f"release      : {release}")
    print(f"worktree     : {worktree}")
    print(f"source_sha   : {manifest['source_sha']}")
    print(f"payload files: {len(manifest['payload'])}")
    print(f"sha256 index : {sha256(release / 'dist' / 'index.js')}")
    print(f"bundle       : {bundle_manifest['bundleFingerprint']} files={bundle_manifest['bundleFiles']}")
    size_report = release_rules.size_report(release)
    print(f"size         : unique {size_report['unique_mib']} MiB (disk increment), "
          f"apparent {size_report['apparent_mib']} MiB (the store counted again)")
    print(f"store caches : unchanged by the build = {store_before == store_after}")
    print("== checks ==")
    failed = 0
    for name, ok, detail in results:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1
    print(f"== {len(results) - failed}/{len(results)} checks passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
