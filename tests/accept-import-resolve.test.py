"""The acceptance must see where the runtime really resolves its imports.

The incident R7, section 4.9: the resolution of the runtime walked the bare
specs of the bundle and never the imports a package of the shared store makes
of its siblings. The legacy root store of the area holds those siblings, the
resolution left the verified store without failing, and the acceptance stayed
green while the new store was not the source of the resolution at all.

The resolution of an import is made from the file that makes it, with a
createRequire bound to that file: that is where the runtime of the release
resolves it. A resolution that leaves the release and the store of the area
is an outside, and the acceptance refuses it.

Nothing of a live node is touched here: every fact is observed in a
temporary directory, with the real tools of deploy/fleet.
"""
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

SHA = "b" * 40
LOCK = '{"lockfileVersion":3}\n'


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rules = load("release_rules.py")
accept = load("accept-node.py")


def write(path: pathlib.Path, text: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def make_source(source: pathlib.Path) -> pathlib.Path:
    """The store of the checkout: two packages, one of them imports the other."""
    write(source / "pkg-a" / "package.json",
          json.dumps({"name": "pkg-a", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(source / "pkg-a" / "index.js", "module.exports = require('pkg-b');\n")
    write(source / "pkg-b" / "package.json",
          json.dumps({"name": "pkg-b", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(source / "pkg-b" / "index.js", "module.exports = 1;\n")
    return source


def make_area(area: pathlib.Path) -> tuple:
    """An area of the owner with one release and the store of its lock file."""
    source = make_source(area / "checkout" / "node_modules")
    release = area / "releases" / SHA
    write(release / "dist" / "index.js",
          "const a = require('pkg-a');\nconst r = require('agent-resume-mcp');\nmodule.exports = [a, r];\n")
    write(release / "packages" / "agent-resume" / "package.json",
          json.dumps({"name": "agent-resume-mcp", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(release / "packages" / "agent-resume" / "index.js", "module.exports = {};\n")
    write(release / "package-lock.json", LOCK)
    identity = rules.dependency_identity(release)
    store = rules.shared_store_dir(area, identity)
    rules.materialize_shared_store(source, store, identity)
    rules.link_release_packages(release, store)
    rules.ensure_area_package_root(area, store)
    return release, store


def make_legacy_farm(area: pathlib.Path) -> pathlib.Path:
    """The legacy root store of a node: a real directory with the packages."""
    legacy = area / "node_modules"
    write(legacy / "pkg-b" / "package.json",
          json.dumps({"name": "pkg-b", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(legacy / "pkg-b" / "index.js", "module.exports = 2;\n")
    return legacy


class ImportResolutionTests(unittest.TestCase):
    """The probe of the acceptance, on an area of its own."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.area = pathlib.Path(self.temporary.name)
        self.release, self.store = make_area(self.area)
        self.addCleanup(self.temporary.cleanup)

    def test_the_clean_area_resolves_every_import_inside_the_store(self):
        """The positive control: the store of the area is the source."""
        result = accept.import_check(self.release, "node")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["outside"], [])
        self.assertEqual(result["unresolved_release"], 0)
        self.assertTrue(result["area_package_root_ok"])
        self.assertEqual(result["area_package_root"]["state"], "link")
        # the resolution of the import of the store package landed in the store
        self.assertGreater(result["from_store"], 0)

    def test_the_legacy_root_store_of_the_area_is_refused(self):
        """R7 section 4.9: the resolution leaves the store for the legacy farm."""
        root = self.area / "node_modules"
        target = root.resolve()
        root.unlink()
        legacy = make_legacy_farm(self.area)
        result = accept.import_check(self.release, "node")
        self.assertFalse(result["ok"])
        # the import of the sibling of a package of the store was resolved
        # from the legacy directory of the area, not from the store
        self.assertTrue(result["outside"])
        for item in result["outside"]:
            self.assertTrue(str(item["target"]).startswith(str(legacy)),
                            f"the import did not leave for the legacy farm: {item}")
            self.assertEqual(item["scope"], "store")
        # the root of the area is a legacy directory: the store of the release
        # is not the source of the resolution
        self.assertEqual(result["area_package_root"]["state"], "legacy-directory")
        self.assertFalse(result["area_package_root_ok"])

    def test_an_area_without_the_package_root_is_refused(self):
        """The root of the area is gone: the runtime cannot resolve."""
        (self.area / "node_modules").unlink()
        result = accept.import_check(self.release, "node")
        self.assertFalse(result["ok"])
        self.assertEqual(result["area_package_root"]["state"], "absent")
        self.assertFalse(result["area_package_root_ok"])

    def test_the_release_behind_the_current_symlink_is_not_an_outside(self):
        """The comparison is made against the real path of the release."""
        link = self.area / "current"
        link.symlink_to(f"releases/{SHA}")
        result = accept.import_check(link, "node")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["outside"], [])
        self.assertGreater(result["from_release"], 0)


if __name__ == "__main__":
    unittest.main()
