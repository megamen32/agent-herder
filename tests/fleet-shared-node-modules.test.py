"""The shared package store of the releases: a deterministic address and a clear refusal.

Nothing of the live fleet is touched: every fact is observed in a temporary
directory, with the real tools of deploy/fleet.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
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
builder = load("build-release-candidate.py")
rollout = load("rollout-node.py")
bootstrap = load("node-bootstrap.py")
accept = load("accept-node.py")


def write(path: pathlib.Path, text: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def make_store(store: pathlib.Path) -> None:
    """A store of packages with the tool caches of a real node."""
    write(store / "alpha" / "index.js", "module.exports = 1;\n")
    write(store / "@scope" / "beta" / "index.js", "module.exports = 2;\n")
    write(store / ".package-lock.json", '{"lockfileVersion":3}\n')
    write(store / ".vite" / "vitest" / "hash" / "results.json", '{"ok":true}\n')


def make_release(area: pathlib.Path, sha: str, lock: str) -> pathlib.Path:
    release = area / "releases" / sha
    write(release / "package-lock.json", lock)
    write(release / "packages" / "agent-resume" / "package.json", '{"name":"agent-resume-mcp"}\n')
    return release


class SharedStoreAddressingTests(unittest.TestCase):
    def test_the_same_lock_file_names_one_shared_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            first = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            second = make_release(area, "b" * 40, '{"lockfileVersion":3}\n')
            identity = rules.dependency_identity(first)
            # the address is the content of the lock file, nothing else
            self.assertEqual(identity, hashlib.sha256(b'{"lockfileVersion":3}\n').hexdigest())
            self.assertEqual(rules.dependency_identity(second), identity)
            self.assertEqual(rules.shared_store_dir(area, identity),
                             rules.shared_store_dir(area, rules.dependency_identity(second)))

    def test_a_changed_lock_file_names_another_store_and_leaves_the_old_one_intact(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store = area / "store"
            make_store(store)
            first = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            builder.release_packages_tree(first, store)
            old_dir = rules.shared_store_dir(area, rules.dependency_identity(first))
            self.assertTrue(old_dir.is_dir())
            manifest = (old_dir / rules.SHARED_STORE_MANIFEST).read_text()
            names = sorted(item.name for item in old_dir.iterdir())
            second = make_release(area, "b" * 40, '{"lockfileVersion":4}\n')
            builder.release_packages_tree(second, store)
            new_dir = rules.shared_store_dir(area, rules.dependency_identity(second))
            self.assertNotEqual(old_dir, new_dir)
            self.assertTrue(new_dir.is_dir())
            # the store of the old lock file is untouched: it belongs to the
            # releases that still run
            self.assertEqual((old_dir / rules.SHARED_STORE_MANIFEST).read_text(), manifest)
            self.assertEqual(sorted(item.name for item in old_dir.iterdir()), names)
            # and the new release links the new store
            self.assertTrue((second / "node_modules" / "alpha").is_symlink())
            self.assertEqual(os.path.realpath(second / "node_modules" / "alpha"),
                             os.path.realpath(new_dir / "alpha"))

    def test_two_builds_with_one_lock_share_one_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store = area / "store"
            make_store(store)
            first = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            second = make_release(area, "b" * 40, '{"lockfileVersion":3}\n')
            builder.release_packages_tree(first, store)
            builder.release_packages_tree(second, store)
            stores = sorted(item.name for item in (area / rules.SHARED_STORE_DIRNAME).iterdir())
            self.assertEqual(len(stores), 1)
            self.assertEqual(stores[0], rules.dependency_identity(first))


class SharedStoreReleaseTests(unittest.TestCase):
    def test_the_release_carries_links_and_no_copy_of_the_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store = area / "store"
            make_store(store)
            release = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            builder.release_packages_tree(release, store)
            packages = release / "node_modules"
            # the directory of the packages stays a real directory
            self.assertTrue(packages.is_dir())
            self.assertFalse(packages.is_symlink())
            # every package is a link into the shared store
            self.assertTrue((packages / "alpha").is_symlink())
            self.assertTrue((packages / "@scope" / "beta").is_symlink())
            self.assertFalse((packages / "@scope").is_symlink())
            # the workspace package stays inside the release
            resume = packages / rules.WORKSPACE_PACKAGE
            self.assertTrue(resume.is_symlink())
            self.assertEqual(os.readlink(resume), "../packages/agent-resume")
            self.assertEqual(os.path.realpath(resume),
                             str((release / "packages" / "agent-resume").resolve()))
            # no byte of a package is copied into the release
            copied, offenders = rules.copied_bytes(packages)
            self.assertTrue(all(name.split("/")[0] in rules.MUTABLE_ENTRIES for name in offenders),
                            offenders)
            # the bytes of the packages are the bytes of the store: no new disk
            self.assertEqual((packages / "alpha" / "index.js").stat().st_ino,
                             (store / "alpha" / "index.js").stat().st_ino)
            self.assertGreater((store / "alpha" / "index.js").stat().st_nlink, 1)

    def test_the_acceptance_names_the_shared_store_of_a_farm_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store = area / "store"
            make_store(store)
            release = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            builder.release_packages_tree(release, store)
            self.assertTrue(accept.release_shared_store(release))
            # a release that still carries its own packages has no shared store
            plain = make_release(area, "c" * 40, '{"lockfileVersion":3}\n')
            write(plain / "node_modules" / "alpha" / "index.js", "module.exports = 1;\n")
            self.assertEqual(accept.release_shared_store(plain), "")


class SharedStoreAbsenceTests(unittest.TestCase):
    def test_the_installer_refuses_a_node_without_a_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            fleet = pathlib.Path(temporary) / "fleet"
            sha = "b" * 40
            previous = "a" * 40
            write(fleet / "releases" / sha / "packages" / "agent-resume" / "package.json",
                  '{"name":"agent-resume-mcp"}\n')
            with self.assertRaises(RuntimeError) as error:
                rollout.prepare_packages(fleet, sha, previous)
            self.assertIn("shared package store", str(error.exception))
            # nothing was created: no link that points nowhere
            self.assertFalse((fleet / "releases" / sha / "node_modules").exists())

    def test_the_bootstrap_refuses_a_release_whose_store_is_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            release = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            link = release / "node_modules" / "alpha"
            link.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.path.relpath(area / "shared-node-modules" / "dead" / "alpha", link), link)
            with self.assertRaises(SystemExit) as error:
                bootstrap.verify_release_packages(release)
            self.assertIn("shared package store is absent", str(error.exception))

    def test_the_bootstrap_accepts_a_release_whose_store_is_there(self):
        with tempfile.TemporaryDirectory() as temporary:
            area = pathlib.Path(temporary)
            store = area / "store"
            make_store(store)
            release = make_release(area, "a" * 40, '{"lockfileVersion":3}\n')
            builder.release_packages_tree(release, store)
            bootstrap.verify_release_packages(release)


if __name__ == "__main__":
    unittest.main()
