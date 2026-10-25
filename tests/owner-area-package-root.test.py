"""The owner rollout must leave the area able to resolve the packages of the store.

The incident R7: the owner release was rolled out into a new area, and the
area had no package root. The runtime of that release could not resolve the
siblings of a package of the shared store, so it did not start, and the
acceptance stayed green because it never looked at the root of the area.

Nothing of a live node is touched here: the rollout runs on a catalog of its
own, in a temporary directory, and the acceptance is measured on it.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
FLEET = ROOT / "deploy/fleet"
sys.path.insert(0, str(FLEET))

SHA = "a" * 40


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rules = load("release_rules.py")
rollout = load("rollout-candidate.py")
accept = load("accept-node.py")


def write(path: pathlib.Path, text: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def make_store(store: pathlib.Path) -> None:
    """The store of the checkout: two packages, one of them imports the other."""
    write(store / "pkg-a" / "package.json",
          json.dumps({"name": "pkg-a", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(store / "pkg-a" / "index.js", "module.exports = require('pkg-b');\n")
    write(store / "pkg-b" / "package.json",
          json.dumps({"name": "pkg-b", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(store / "pkg-b" / "index.js", "module.exports = 1;\n")


def make_payload(source: pathlib.Path) -> pathlib.Path:
    """The payload of a release: the build of the node, without the packages."""
    write(source / "dist" / "index.js", "const a = require('pkg-a');\nmodule.exports = a;\n")
    write(source / "packages" / "agent-resume" / "package.json",
          json.dumps({"name": "agent-resume-mcp", "version": "1.0.0", "main": "index.js"}) + "\n")
    write(source / "packages" / "agent-resume" / "index.js", "module.exports = {};\n")
    write(source / "package.json", json.dumps({"name": "agent-herder", "version": "0.2.2"}) + "\n")
    write(source / "package-lock.json", '{"lockfileVersion":3}\n')
    return source


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


class OwnerAreaTests(unittest.TestCase):
    """The owner rollout on a catalog of its own."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.catalog = self.root / "catalog"
        self.catalog.mkdir()
        self.work = self.root / "work"
        make_store(self.work / "node_modules")
        self.source = make_payload(self.root / "source")
        self.addCleanup(self.temporary.cleanup)

    def rollout_owner(self) -> str:
        """The owner node side of the rollout, on the catalog of the test."""
        archive = self.root / "release.tar"
        rollout.pack_release(self.source, archive)
        argv = ["rollout-candidate.py", "--node-side", "--kind", "owner",
                "--sha", SHA, "--archive", str(archive),
                "--catalog", str(self.catalog), "--previous-sha", "",
                "--drop-in", str(self.root / "unit.d" / "10-release-exec.conf"),
                "--working-directory", str(self.work),
                "--web-port", "18787", "--unit", "agent-herder.service",
                "--node-config", json.dumps({"hostId": "roomhacker-server-100",
                                             "harnesses": ["codex"],
                                             "nodeBin": "/usr/local/bin/node",
                                             "webPort": 18787})]
        calls = []
        real_run = subprocess.run

        def run(command, *args, **kwargs):
            calls.append(list(command))
            # only the systemctl calls of the rollout are captured: the copy
            # of the packages into the store of the area is a real one
            if list(command)[:1] == ["systemctl"]:
                return MagicMock(returncode=0)
            return real_run(command, *args, **kwargs)

        with (patch.object(sys, "argv", argv),
              patch.object(rollout.subprocess, "run", side_effect=run),
              patch("urllib.request.urlopen", return_value=MagicMock())):
            self.assertEqual(rollout.main(), 0)
        # the rollout of the owner restarts its own unit and nothing else
        self.assertEqual([call for call in calls if call[0] == "systemctl"],
                         [["systemctl", "--user", "daemon-reload"],
                          ["systemctl", "--user", "restart", "agent-herder.service"]])
        return str(self.catalog / "releases" / SHA)

    def test_the_rollout_prepares_the_area_of_a_clean_catalog(self):
        """The area of the owner must offer the store to the resolver of Node."""
        self.assertFalse((self.catalog / "node_modules").exists())
        release = pathlib.Path(self.rollout_owner())
        root = self.catalog / "node_modules"
        self.assertTrue(root.is_symlink())
        store = root.resolve()
        self.assertEqual(store.parent.name, rules.SHARED_STORE_DIRNAME)
        self.assertTrue(store.is_dir())
        # the store carries the packages of the checkout and its manifest
        self.assertTrue((store / "pkg-a" / "index.js").is_file())
        self.assertTrue(rules.shared_store_manifest_path(store).is_file())
        # the release carries no copy of the packages: it links them
        link = pathlib.Path(release) / "node_modules" / "pkg-a"
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.path.realpath(link), str(store / "pkg-a"))
        # the import the runtime makes from inside a package of the store
        # lands in the store: the runtime of the release can start
        importer = store / "pkg-a" / "index.js"
        resolved = pathlib.Path(resolve_from(importer, "pkg-b")).resolve()
        self.assertTrue(str(resolved).startswith(str(store)),
                        f"the import left the store: {resolved}")

    def test_the_acceptance_catches_an_area_without_the_package_root(self):
        """The absence of the root of the area must not stay green."""
        release = pathlib.Path(self.rollout_owner())
        root = self.catalog / "node_modules"
        self.assertTrue(root.is_symlink())
        accepted = accept.import_check(release, "node")
        self.assertTrue(accepted["ok"], accepted)
        # the root of the area is gone: the runtime of the release cannot
        # resolve the packages of the store any more
        root.unlink()
        broken = accept.import_check(release, "node")
        self.assertFalse(broken["ok"])
        self.assertEqual(broken["area_package_root"]["state"], "absent")
        self.assertFalse(broken["area_package_root_ok"])

    def test_the_acceptance_accepts_the_area_of_the_rollout(self):
        """The positive control: the area of the rollout is accepted."""
        release = pathlib.Path(self.rollout_owner())
        accepted = accept.import_check(release, "node")
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["area_package_root"]["state"], "link")
        self.assertTrue(accepted["area_package_root"]["points_at_store"])
        self.assertEqual(accepted["outside"], [])
        self.assertEqual(accepted["unresolved"], [])

    def test_a_legacy_root_store_of_the_area_is_not_accepted(self):
        """A real directory at the root of the area resolves the imports.

        The runtime of such an area resolves its packages from that directory
        and not from the verified store, so the acceptance has to refuse it.
        """
        release = pathlib.Path(self.rollout_owner())
        root = self.catalog / "node_modules"
        root.unlink()
        legacy = self.catalog / "node_modules"
        legacy.mkdir()
        (legacy / "pkg-b").mkdir()
        (legacy / "pkg-b" / "package.json").write_text(
            json.dumps({"name": "pkg-b", "version": "1.0.0", "main": "index.js"}) + "\n")
        (legacy / "pkg-b" / "index.js").write_text("module.exports = 2;\n")
        broken = accept.import_check(release, "node")
        self.assertFalse(broken["ok"])
        self.assertEqual(broken["area_package_root"]["state"], "legacy-directory")
        self.assertFalse(broken["area_package_root"].get("points_at_store"))


if __name__ == "__main__":
    unittest.main()
