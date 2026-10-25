"""The shared store of an area must be the source of the resolution.

On a fleet node the root of the area held the legacy root store of the node:
a real directory with the packages of the node. The resolver of Node walks
up the real path of a package of the shared store and looks for a directory
named "node_modules" in every parent - the store is named
"shared-node-modules/<identity>", so the walk left the store and found the
legacy root store there. The import of a sibling of a package of the store
was resolved from the legacy store, the new store was not the source of the
resolution, and the rollout did not change that.

The store therefore offers its own packages under the name the resolver looks
for, and the rollout takes the root of the area from the legacy store: the
legacy store moves aside, its bytes stay, and the owner decides about them.

Nothing of a live node is touched here: every fact is observed in a
temporary directory, with the real tools of deploy/fleet.
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

SHA = "d" * 40
LOCK = '{"lockfileVersion":3}\n'


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rules = load("release_rules.py")
rollout = load("rollout-node.py")
accept = load("accept-node.py")


def write(path: pathlib.Path, text: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def make_package(root: pathlib.Path, name: str, imports: str = "") -> None:
    """A package that imports a sibling by its bare name."""
    write(root / name / "package.json",
          json.dumps({"name": name, "version": "1.0.0", "main": "index.js"}) + "\n")
    write(root / name / "index.js", f"module.exports = require({imports!r});\n")


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


class NodeStoreSourceTests(unittest.TestCase):
    """The area of a fleet node with a legacy root store at its root."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.area = pathlib.Path(self.temporary.name) / "area"
        self.release = self.area / "releases" / SHA
        # the legacy root store of the node: a real directory with the packages
        self.legacy = self.area / "node_modules"
        make_package(self.legacy, "pkg-b")
        make_package(self.legacy, "pkg-a", imports="pkg-b")
        # the release and the store of its dependency set
        write(self.release / "dist" / "index.js",
              "const a = require('pkg-a');\nmodule.exports = a;\n")
        write(self.release / "packages" / "agent-resume" / "package.json",
              json.dumps({"name": "agent-resume-mcp", "version": "1.0.0", "main": "index.js"}) + "\n")
        write(self.release / "packages" / "agent-resume" / "index.js", "module.exports = {};\n")
        write(self.release / "package-lock.json", LOCK)
        identity = rules.dependency_identity(self.release)
        self.store = rules.shared_store_dir(self.area, identity)
        rules.materialize_shared_store(self.legacy, self.store, identity)
        rules.link_release_packages(self.release, self.store)
        self.addCleanup(self.temporary.cleanup)

    def test_the_sibling_of_a_package_of_the_store_resolves_inside_the_store(self):
        """The defect of the node: the legacy root store held the resolution."""
        importer = self.store / "pkg-a" / "index.js"
        resolved = pathlib.Path(resolve_from(importer, "pkg-b")).resolve()
        self.assertTrue(str(resolved).startswith(str(self.store.resolve())),
                        f"the import left the store: {resolved}")

    def test_the_store_offers_its_packages_to_the_resolver(self):
        """The store is named shared-node-modules/<identity>: it offers itself."""
        state = rules.store_package_root_state(self.store)
        self.assertEqual(state["state"], "link")
        self.assertTrue(state["points_at_store"])

    def test_the_acceptance_sees_no_import_outside_the_store(self):
        """The acceptance must not see an import outside the release and the store."""
        result = accept.import_check(self.release, "node")
        self.assertEqual(result["outside"], [])
        for item in result["outside"]:
            self.assertFalse(str(item["target"]).startswith(str(self.legacy)))
        self.assertEqual(result["unresolved_release"], 0)
        self.assertFalse(result["truncated"])

    def test_the_rollout_takes_the_root_of_the_area_from_the_legacy_store(self):
        """The legacy root store moves aside, its bytes stay."""
        self.assertTrue(self.legacy.is_dir())
        self.assertFalse(self.legacy.is_symlink())
        message = rollout.prepare_packages(self.area, SHA, "0" * 40)
        root = self.area / "node_modules"
        self.assertTrue(root.is_symlink())
        self.assertEqual(root.resolve(), self.store.resolve())
        moved = [item for item in self.area.iterdir()
                 if item.name.startswith("node_modules.legacy-")]
        self.assertEqual(len(moved), 1)
        # the bytes of the legacy store are still there
        self.assertTrue((moved[0] / "pkg-b" / "index.js").is_file())
        self.assertIn("moved aside", message)
        # and the area is accepted: the store of the release is the source
        result = accept.import_check(self.release, "node")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["area_package_root"]["state"], "link")
        self.assertTrue(result["area_package_root"]["points_at_store"])


if __name__ == "__main__":
    unittest.main()
