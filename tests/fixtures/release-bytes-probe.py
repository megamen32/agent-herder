#!/usr/bin/env python3
"""The bytes of a release: the facts the regression test of the fleet asserts.

The probe builds the state of a fleet catalog in a temporary directory and
runs the real tools of deploy/fleet on it: the node side materialization, the
builder of a release and the archive of a rollout. It prints one JSON
document with the facts it observed. Nothing outside the temporary directory
is written, and the live fleet is never touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "deploy" / "fleet"


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_")[:-3], path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(FLEET))
    spec.loader.exec_module(module)
    return module


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def sha256_of(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_store(store: Path) -> None:
    """A store of packages with the tool caches of a real node."""
    write(store / "alpha" / "index.js", "module.exports = 1;\n")
    write(store / ".package-lock.json", '{"lockfileVersion":3}\n')
    write(store / ".vite" / "vitest" / "hash" / "results.json", '{"ok":true}\n')


def nlink(path: Path) -> int:
    return path.stat().st_nlink if path.exists() else -1


def inode(path: Path) -> int:
    return path.stat().st_ino if path.exists() else -1


def scenario_node_materialize(root: Path) -> dict:
    """The node materializes the release of the next rollout."""
    node = load("rollout-node.py")
    rules = load("release_rules.py")
    fleet = root / "fleet"
    store = fleet / "node_modules"
    make_store(store)
    previous = "a" * 40
    current = "b" * 40
    for sha in (previous, current):
        write(fleet / "releases" / sha / "packages" / "agent-resume" / "package.json",
              '{"name":"agent-resume-mcp"}\n')
    node.prepare_packages(fleet, current, previous, release_local_packages=True)
    packages = fleet / "releases" / current / "node_modules"
    cache = packages / ".package-lock.json"
    vitest = packages / ".vite" / "vitest" / "hash" / "results.json"
    facts = {
        "release_cache_nlink": nlink(cache),
        "release_cache_own_inode": inode(cache) != inode(store / ".package-lock.json"),
        "release_vitest_nlink": nlink(vitest),
        "release_vitest_own_inode": inode(vitest) != inode(store / ".vite" / "vitest" / "hash" / "results.json"),
        "store_cache_nlink": nlink(store / ".package-lock.json"),
        "package_stays_a_link": nlink(packages / "alpha" / "index.js") > 1,
        "shared_cache_files": rules.shared_cache_files(packages),
    }
    # the mode that carries the packages of the previous release
    third = "c" * 40
    write(fleet / "releases" / third / "packages" / "agent-resume" / "package.json",
          '{"name":"agent-resume-mcp"}\n')
    node.prepare_packages(fleet, third, current, release_local_packages=False)
    carried = fleet / "releases" / third / "node_modules"
    facts["carried_cache_nlink"] = nlink(carried / ".package-lock.json")
    facts["carried_cache_own_inode"] = inode(carried / ".package-lock.json") != inode(cache)
    facts["carried_shared_cache_files"] = rules.shared_cache_files(carried)
    return facts


def scenario_build(root: Path) -> dict:
    """The builder builds a release over a materialized one."""
    builder = load("build-release-candidate.py")
    rules = load("release_rules.py")
    catalog = root / "catalog"
    (catalog / "releases").mkdir(parents=True)
    (catalog / "trash").mkdir(parents=True)
    store = root / "store"
    make_store(store)
    worktree = root / "worktree"
    sha_a = "1" * 40
    sha_b = "2" * 40
    sha_c = "3" * 40
    index = write(worktree / "dist" / "index.js", "console.log(1);\n")
    write(worktree / "dist" / "fleet-deployment-manifest.json",
          json.dumps({"source_sha": sha_a, "payload": {"index.js": sha256_of(index)}}) + "\n")
    write(worktree / "package.json", '{"name":"agent-herder"}\n')
    write(worktree / "package-lock.json", '{"lockfileVersion":3}\n')
    write(worktree / "packages" / "agent-resume" / "package.json", '{"name":"agent-resume-mcp"}\n')
    for command in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "probe"]):
        subprocess.run(["git", "-C", str(worktree), "-c", "user.name=probe",
                        "-c", "user.email=probe@example.invalid", *command], check=True,
                       capture_output=True)

    release_a = builder.assemble(sha_a, worktree, catalog)
    builder.release_packages_tree(release_a, store)
    manifest_a = builder.write_bundle_manifest(sha_a, release_a, catalog, worktree)
    before = (release_a / "build-manifest.json").read_text()
    fingerprint_a = manifest_a["bundleFingerprint"]
    cache_a = release_a / "node_modules" / ".package-lock.json"

    # the installer materializes the next release as a hard link copy
    release_b = catalog / "releases" / sha_b
    shutil.copytree(release_a, release_b, copy_function=os.link, symlinks=True)
    cache_b = release_b / "node_modules" / ".package-lock.json"
    facts = {"materialized_cache_nlink": nlink(cache_b),
             "materialized_cache_shared": inode(cache_b) == inode(cache_a)}

    # the builder writes the manifest of the materialized release
    builder.write_bundle_manifest(sha_b, release_b, catalog, worktree)
    after = (release_a / "build-manifest.json").read_text()
    facts["base_manifest_unchanged"] = before == after
    facts["base_manifest_source_sha"] = json.loads(after)["sourceSha"]
    facts["manifest_inodes_differ"] = (inode(release_a / "build-manifest.json")
                                       != inode(release_b / "build-manifest.json"))

    # the builder gives the materialized release its own package bytes
    builder.release_packages_tree(release_b, store)
    facts["cache_nlink_after_build"] = nlink(cache_b)
    facts["cache_own_inode_after_build"] = inode(cache_b) != inode(cache_a)
    facts["shared_cache_files_after_build"] = rules.shared_cache_files(release_b / "node_modules")

    # a release with other content carries another fingerprint
    index = write(worktree / "dist" / "index.js", "console.log(2);\n")
    write(worktree / "dist" / "fleet-deployment-manifest.json",
          json.dumps({"source_sha": sha_c, "payload": {"index.js": sha256_of(index)}}) + "\n")
    release_c = builder.assemble(sha_c, worktree, catalog)
    builder.release_packages_tree(release_c, store)
    manifest_c = builder.write_bundle_manifest(sha_c, release_c, catalog, worktree)
    facts["fingerprints_differ"] = fingerprint_a != manifest_c["bundleFingerprint"]
    offenders = rules.copied_bytes(release_c / "node_modules")[1]
    facts["copied_only_tool_caches"] = all(name.split("/")[0] in rules.MUTABLE_ENTRIES
                                           for name in offenders)
    return facts


def scenario_pack(root: Path) -> dict:
    """The archive of a rollout carries the bytes of the release."""
    rollout = load("rollout-candidate.py")
    release = root / "release"
    write(release / "dist" / "index.js", "console.log(1);\n")
    os.link(release / "dist" / "index.js", release / "dist" / "linked.js")
    write(release / "package.json", '{"name":"agent-herder"}\n')
    write(release / "build-manifest.json", '{"kind":"release-build-manifest"}\n')
    archive = root / "release.tar"
    rollout.pack_release(release, archive)
    with tarfile.open(archive) as handle:
        members = handle.getmembers()
    facts = {"link_members": [member.name for member in members
                              if member.type == tarfile.LNKTYPE],
             "members": len(members)}
    target = root / "node-release"
    rollout.unpack_release(archive, target)
    facts["unpacked_shared"] = sorted(path.name for path in (target / "dist").iterdir()
                                      if path.stat().st_nlink > 1)
    facts["unpacked_nlink"] = nlink(target / "dist" / "index.js")
    return facts


SCENARIOS = {
    "node-materialize": scenario_node_materialize,
    "build": scenario_build,
    "pack": scenario_pack,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in SCENARIOS:
        print("usage: release-bytes-probe.py <scenario> [root]", file=sys.stderr)
        return 2
    scenario = SCENARIOS[sys.argv[1]]
    if len(sys.argv) > 2:
        root = Path(sys.argv[2])
        root.mkdir(parents=True, exist_ok=True)
        facts = scenario(root)
    else:
        with tempfile.TemporaryDirectory() as directory:
            facts = scenario(Path(directory))
    print(json.dumps(facts, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
