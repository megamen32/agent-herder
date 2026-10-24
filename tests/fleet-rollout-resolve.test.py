"""The rollout must leave the runtime able to resolve the packages of the store.

A package of the shared store is a link of the release, and the resolver of
Node follows the real path of the file: it walks up the parents of the file and
looks for a directory named "node_modules" in every one of them. The store is
named "shared-node-modules/<identity>", so the walk leaves the store and finds
nothing - the import of a sibling package fails with ERR_MODULE_NOT_FOUND and
the runtime does not start at all.

These tests observe the area of a fleet in a temporary directory, with the real
tools of deploy/fleet. Nothing of the live fleet is touched.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FLEET = ROOT / "deploy/fleet"
sys.path.insert(0, str(FLEET))


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rules = load("release_rules.py")
rollout = load("rollout-node.py")


def make_package(root: pathlib.Path, name: str, imports: str = "") -> None:
    """A package of the store that imports a sibling by its bare name."""
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "package.json").write_text(
        json.dumps({"name": name, "version": "1.0.0", "main": "index.js"}) + "\n")
    (directory / "index.js").write_text(
        f"const sibling = require({imports!r});\nmodule.exports = sibling;\n")


def make_store(source: pathlib.Path) -> pathlib.Path:
    """A source of packages: two packages, one of them imports the other."""
    make_package(source, "pkg-a", imports="pkg-b")
    make_package(source, "pkg-b")
    return source


def make_release(area: pathlib.Path, sha: str, lock: str = '{"lockfileVersion":3}\n') -> pathlib.Path:
    """A release of the area: the lock file names the dependency set."""
    release = area / "releases" / sha
    (release / "packages" / "agent-resume").mkdir(parents=True, exist_ok=True)
    (release / "packages" / "agent-resume" / "package.json").write_text(
        json.dumps({"name": "agent-resume-mcp", "version": "1.0.0", "main": "index.js"}) + "\n")
    (release / "packages" / "agent-resume" / "index.js").write_text("module.exports = {};\n")
    (release / "package-lock.json").write_text(lock)
    return release


def resolve_from(package_file: pathlib.Path, spec: str) -> str:
    """The real path Node resolves for a bare import made from a file."""
    script = ("const {createRequire}=require('module');"
              "console.log(require('fs').realpathSync("
              "createRequire(process.argv[1]).resolve(process.argv[2])));")
    result = subprocess.run(["node", "-e", script, str(package_file), spec],
                            capture_output=True, text=True, check=False, timeout=60)
    if result.returncode != 0:
        raise AssertionError(f"the import did not resolve: {result.stderr.strip()[:200]}")
    return result.stdout.strip()


class AreaPackageRoot(unittest.TestCase):
    """The area must offer the store to the resolver of Node."""

    def test_the_area_offers_the_store_under_the_name_the_resolver_looks_for(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            source = make_store(area / "source")
            store_dir = area / "shared-node-modules" / ("a" * 64)
            rules.materialize_shared_store(source, store_dir, "a" * 64)

            self.assertFalse((area / "node_modules").exists())
            state = rules.ensure_area_package_root(area, store_dir)
            self.assertEqual(state["state"], "created")
            root = area / "node_modules"
            self.assertTrue(root.is_symlink())
            self.assertEqual(root.resolve(), store_dir.resolve())

    def test_a_legacy_root_store_is_left_alone_and_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            legacy = area / "node_modules"
            legacy.mkdir()
            (legacy / "pkg-b").mkdir()
            store_dir = area / "shared-node-modules" / ("b" * 64)
            store_dir.mkdir(parents=True)

            state = rules.ensure_area_package_root(area, store_dir)
            self.assertEqual(state["state"], "legacy-directory")
            self.assertTrue(legacy.is_dir())
            self.assertFalse(legacy.is_symlink())

    def test_the_state_is_read_without_creating_anything(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store_dir = area / "shared-node-modules" / ("c" * 64)
            store_dir.mkdir(parents=True)
            state = rules.area_package_root_state(area, store_dir)
            self.assertEqual(state["state"], "absent")
            self.assertFalse((area / "node_modules").exists())


class ResolutionWithoutLegacyRoot(unittest.TestCase):
    """The regression: the runtime must start without the legacy root store."""

    def test_a_sibling_of_a_store_package_resolves_into_the_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            sha = "d" * 40
            release = make_release(area, sha)
            source = make_store(area / "source")

            # The area of the node has no legacy root store at all.
            self.assertFalse((area / "node_modules").exists())

            identity = rules.dependency_identity(release, None, source)
            store_dir = rules.shared_store_dir(area, identity)
            rules.materialize_shared_store(source, store_dir, identity)
            rules.link_release_packages(release, store_dir)
            rules.ensure_area_package_root(area, store_dir)

            # The import that the runtime of the release makes from inside the
            # package of the store: it must land in the store of the area.
            importer = store_dir / "pkg-a" / "index.js"
            resolved = pathlib.Path(resolve_from(importer, "pkg-b")).resolve()
            self.assertTrue(str(resolved).startswith(str(store_dir.resolve())),
                            f"the import left the store: {resolved}")

    def test_the_same_import_fails_without_the_package_root_of_the_area(self):
        """The failure of the release of R7, reproduced on purpose."""
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            sha = "e" * 40
            release = make_release(area, sha)
            source = make_store(area / "source")

            identity = rules.dependency_identity(release, None, source)
            store_dir = rules.shared_store_dir(area, identity)
            rules.materialize_shared_store(source, store_dir, identity)
            rules.link_release_packages(release, store_dir)
            # The package root of the area is missing: the import cannot resolve.
            importer = store_dir / "pkg-a" / "index.js"
            with self.assertRaises(AssertionError):
                resolve_from(importer, "pkg-b")


class RolloutPreparesTheArea(unittest.TestCase):
    """The rollout itself must leave the area ready, before the unit restarts."""

    def test_prepare_packages_leaves_the_area_with_a_package_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            sha = "f" * 40
            previous = "0" * 40
            release = make_release(area, sha)
            previous_release = make_release(area, previous)
            source = make_store(area / "source")
            # The previous release carries the packages of the node.
            (previous_release / "node_modules" / "pkg-a").mkdir(parents=True)
            (previous_release / "node_modules" / "pkg-b").mkdir(parents=True)

            message = rollout.prepare_packages(area, sha, previous)
            self.assertIn("area package root", message)
            self.assertTrue((area / "node_modules").is_symlink())
            self.assertIn("state=created", message)


if __name__ == "__main__":
    unittest.main()
