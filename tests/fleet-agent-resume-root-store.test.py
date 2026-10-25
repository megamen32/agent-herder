"""The root store of the area must not offer the package of the release as a copy.

The check of the layout of the workspace package asked for a number: the count
of the lines of the client of the opencode harness that hold the word
"archived". That word belongs to the archived sessions of the harness, so the
number was an accident of the content of the file: the published package of
another version had none of them, the package of the repo has nine, and the
next publish of the package moves the number and breaks the rollout of every
fleet node. The number could not be satisfied at all once the root of the area
is the shared store of the area, because the shared store does not carry the
workspace package: it is a link into the release.

The check that matters is a fact, not a number. The import of the workspace
package must come from the release, and the root store of the area must not
offer the package of the release as a copy: the resolver of Node looks for a
directory named node_modules in every parent of the file it resolves, so a
copy that lies in the root store of the area is reachable, and the runtime can
import that copy instead of the package of the release.

The root store of the area is the shared store of the area since the takeover
of the root, and the shared store does not carry the workspace package at all.
The legacy layout of the root store carried the published package of another
version. Both are admitted. A copy of the package of the release in the root
store is refused.

Nothing of a live node is touched here: every fact is observed in a temporary
directory, with the real tools of deploy/fleet.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FLEET = ROOT / "deploy/fleet"
sys.path.insert(0, str(FLEET))

SHA = "a" * 40
NODE = shutil.which("node") or shutil.which("nodejs")


def load(name: str):
    """Load a tool of deploy/fleet by its path: the name carries a dash."""
    path = FLEET / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rollout = load("rollout-node.py")


def write(path: pathlib.Path, text: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def make_release(fleet: pathlib.Path, archived_lines: int = 9) -> pathlib.Path:
    """A release that links the workspace package into itself."""
    release = fleet / "releases" / SHA
    package = release / "packages" / "agent-resume"
    write(package / "package.json",
          json.dumps({"name": "agent-resume-mcp", "version": "0.2.2", "main": "dist/index.js"}) + "\n")
    write(package / "dist" / "index.js", "module.exports = { name: 'agent-resume-mcp' };\n")
    body = ["// the client of the opencode harness\n"]
    for index in range(archived_lines):
        body.append(f"// an archived session of the harness, number {index}\n")
    write(package / "dist" / "harness" / "opencode" / "client.js", "".join(body))
    # The entry of the release imports the workspace package by its bare name.
    write(release / "dist" / "index.js", "require('agent-resume-mcp');\n")
    # The release links the workspace package into itself.
    link = release / "node_modules" / "agent-resume-mcp"
    link.parent.mkdir(parents=True, exist_ok=True)
    os.symlink("../packages/agent-resume", link)
    return release


def copy_of_the_release_package(release: pathlib.Path, target: pathlib.Path) -> pathlib.Path:
    """A copy of the package of the release, byte for byte."""
    source = release / "packages" / "agent-resume"
    shutil.copytree(source, target, symlinks=True)
    return target


def published_package(target: pathlib.Path) -> pathlib.Path:
    """The published package of another version: the same name, other bytes."""
    write(target / "package.json",
          json.dumps({"name": "agent-resume-mcp", "version": "0.2.1", "main": "dist/index.js"}) + "\n")
    write(target / "dist" / "index.js", "module.exports = { name: 'agent-resume-mcp' };\n")
    write(target / "dist" / "harness" / "opencode" / "client.js",
          "// the client of the opencode harness\n")
    return target


class RootStoreWorkspaceCopyTests(unittest.TestCase):
    """The layout of the workspace package against the root store of the area."""

    def setUp(self) -> None:
        if not NODE:
            self.skipTest("node is not on the PATH: the layout of the package is resolved by node")
        self.home = tempfile.mkdtemp(prefix="fleet-root-store-")
        self.fleet = pathlib.Path(self.home) / "fleet"
        self.fleet.mkdir(parents=True)
        write(self.fleet / "node-config.json", json.dumps({"nodeBin": NODE}) + "\n")
        self.release = make_release(self.fleet)

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def test_the_shared_store_of_the_area_is_admitted(self) -> None:
        """The root of the area is the shared store: it carries no workspace package.

        The shared store of the area does not carry the workspace package: it
        is a link into the release. The import of the package comes from the
        release, and the root store offers nothing that could shadow it.
        """
        store = self.fleet / "shared-node-modules" / ("b" * 64)
        store.mkdir(parents=True)
        write(store / "some-package" / "package.json",
              json.dumps({"name": "some-package", "version": "1.0.0"}) + "\n")
        # The store offers its own packages under the name the resolver looks for.
        os.symlink(".", store / "node_modules")
        # The root of the area is the store.
        os.symlink(str(store), self.fleet / "node_modules")

        self.assertTrue(rollout.verify_agent_resume_layout(self.fleet, SHA))

    def test_the_legacy_root_store_of_the_node_is_admitted(self) -> None:
        """The legacy root store holds the published package of another version."""
        published_package(self.fleet / "node_modules" / "agent-resume-mcp")

        self.assertTrue(rollout.verify_agent_resume_layout(self.fleet, SHA))

    def test_a_copy_of_the_package_of_the_release_in_the_root_store_is_refused(self) -> None:
        """A copy of the package of the release in the root store is refused.

        The resolver of Node can reach that copy: the import could come from
        it instead of the package of the release. The sense of the check - the
        import must not come from a copy outside the release - is kept.
        """
        copy_of_the_release_package(self.release, self.fleet / "node_modules" / "agent-resume-mcp")

        self.assertFalse(rollout.verify_agent_resume_layout(self.fleet, SHA))

    def test_the_import_must_come_from_the_release(self) -> None:
        """The release that imports the package of another place is refused."""
        published_package(self.fleet / "node_modules" / "agent-resume-mcp")
        link = self.release / "node_modules" / "agent-resume-mcp"
        link.unlink()
        os.symlink(str(self.fleet / "node_modules" / "agent-resume-mcp"), link)

        self.assertFalse(rollout.verify_agent_resume_layout(self.fleet, SHA))


if __name__ == "__main__":
    unittest.main()
