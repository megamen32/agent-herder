"""The owner rollout must leave `current` on the release that is live now.

The owner node keeps one release directory: the new one. The release that was
live moves to rollback/, so the `current` symlink has to follow the new
release: after the rollout it names `releases/<sha>`, never the place the old
release moved to. The consumers of the owner node read that symlink.

Nothing here touches a live node: the rollout runs on a catalog of its own and
every systemctl call is captured.
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rollout_candidate", ROOT / "deploy/fleet/rollout-candidate.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)

OLD_SHA = "5172044c68eeae2effaba1936354393b069d4dd4"
NEW_SHA = "a19ea5bd3a67cee267d0515f15f1d99ab4bc6788"


class OwnerCurrentTests(unittest.TestCase):
    """The owner path of the rollout, measured on a catalog of its own."""

    def rollout_owner(self, catalog: pathlib.Path, old_home: str) -> pathlib.Path:
        """A catalog with one live release, rolled out to a new one.

        old_home is where the release that is live now lives: `releases` after
        a normal rollout, `rollback` after a rollback that moved it there.
        """
        old_release = catalog / old_home / OLD_SHA
        (old_release / "dist").mkdir(parents=True)
        (old_release / "dist" / "index.js").write_text("console.log('old');\n")
        link = catalog / "current"
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(f"{old_home}/{OLD_SHA}")
        (catalog / "node-config.json").write_text(json.dumps({
            "hostId": "roomhacker-server-100",
            "harnesses": ["codex"],
            "nodeBin": "/usr/local/bin/node",
            "webPort": 18787,
            "sourceSha": OLD_SHA,
        }, indent=2) + "\n")
        drop_in = catalog / "agent-herder.service.d" / "10-release-exec.conf"
        drop_in.parent.mkdir(parents=True)
        drop_in.write_text(
            "# Release-local runtime of the candidate " + OLD_SHA + ".\n"
            "[Service]\n"
            "ExecStart=\n"
            f"ExecStart=/usr/local/bin/node {old_release}/dist/index.js\n")

        source = catalog.parent / "source"
        (source / "dist").mkdir(parents=True)
        (source / "dist" / "index.js").write_text("console.log('new');\n")
        archive = catalog.parent / "release.tar"
        rollout.pack_release(source, archive)

        argv = ["rollout-candidate.py", "--node-side", "--kind", "owner",
                "--sha", NEW_SHA, "--archive", str(archive),
                "--catalog", str(catalog), "--previous-sha", OLD_SHA,
                "--drop-in", str(drop_in), "--web-port", "18787",
                "--unit", "agent-herder.service",
                "--node-config", json.dumps({
                    "hostId": "roomhacker-server-100",
                    "harnesses": ["codex"],
                    "nodeBin": "/usr/local/bin/node",
                    "webPort": 18787,
                    "codexSocket": "/tmp/codex.sock",
                    "codexBin": "/usr/bin/codex"})]
        calls = []

        def run(command, *args, **kwargs):
            calls.append(list(command))
            return MagicMock(returncode=0)

        with (patch.object(sys, "argv", argv),
              patch.object(rollout.subprocess, "run", side_effect=run),
              patch("urllib.request.urlopen", return_value=MagicMock())):
            self.assertEqual(rollout.main(), 0)
        # the rollout of the owner restarts its own unit and nothing else
        self.assertEqual(calls, [["systemctl", "--user", "daemon-reload"],
                                 ["systemctl", "--user", "restart", "agent-herder.service"]])
        return drop_in

    def test_owner_rollout_leaves_current_on_the_new_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            catalog = pathlib.Path(temporary) / "catalog"
            catalog.mkdir()
            drop_in = self.rollout_owner(catalog, "releases")

            link = catalog / "current"
            self.assertTrue(link.is_symlink())
            # the link names the release of this rollout, the same name the
            # builder writes and the same name the builder checks
            self.assertEqual(os.readlink(link), f"releases/{NEW_SHA}")
            self.assertFalse(os.readlink(link).startswith("rollback/"))
            # the link names a directory that exists
            self.assertTrue((catalog / os.readlink(link)).is_dir())
            # the drop-in and the config of the node name the same release
            self.assertIn(f"{catalog}/releases/{NEW_SHA}/dist/index.js", drop_in.read_text())
            self.assertEqual(json.loads((catalog / "node-config.json").read_text())["sourceSha"],
                             NEW_SHA)
            # the point of rollback stays real: the old release lives in
            # rollback/ and the saved drop-in points at it
            self.assertTrue((catalog / "rollback" / OLD_SHA).is_dir())
            saved = sorted(drop_in.parent.glob("10-release-exec.conf.bak-*"))
            self.assertEqual(len(saved), 1)
            self.assertIn(f"/rollback/{OLD_SHA}/dist/index.js", saved[0].read_text())
            # the owner keeps one release directory
            self.assertEqual(sorted(item.name for item in (catalog / "releases").iterdir()),
                             [NEW_SHA])
            # nothing is left over from the switch
            self.assertFalse((catalog / ".current.new").exists())

    def test_owner_rollout_restores_current_after_a_rollback_moved_it(self):
        """The state of the 19:40 rollback: current named rollback/<old>."""
        with tempfile.TemporaryDirectory() as temporary:
            catalog = pathlib.Path(temporary) / "catalog"
            catalog.mkdir()
            drop_in = self.rollout_owner(catalog, "rollback")

            self.assertEqual(os.readlink(catalog / "current"), f"releases/{NEW_SHA}")
            self.assertIn(f"{catalog}/releases/{NEW_SHA}/dist/index.js", drop_in.read_text())
            self.assertEqual(json.loads((catalog / "node-config.json").read_text())["sourceSha"],
                             NEW_SHA)
            # the release of the rollback is still there and still startable
            self.assertTrue((catalog / "rollback" / OLD_SHA / "dist" / "index.js").is_file())
            saved = sorted(drop_in.parent.glob("10-release-exec.conf.bak-*"))
            self.assertEqual(len(saved), 1)
            self.assertIn(f"/rollback/{OLD_SHA}/dist/index.js", saved[0].read_text())

    def test_fleet_path_still_delegates_to_rollout_node(self):
        """The fleet branch is unchanged: its node side is rollout-node.py.

        A fleet node runs through bootstrap.py and the current symlink is its
        way of choosing the release, so the fleet branch of this script does
        not move that symlink itself.
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            fleet = root / "fleet"
            (fleet / "releases" / OLD_SHA / "dist").mkdir(parents=True)
            (fleet / "releases" / OLD_SHA / "dist" / "index.js").write_text("old\n")
            (fleet / "current").symlink_to(f"releases/{OLD_SHA}")
            source = root / "source"
            (source / "dist").mkdir(parents=True)
            (source / "dist" / "index.js").write_text("new\n")
            archive = root / "release.tar"
            rollout.pack_release(source, archive)
            commands = []

            def run(command, *args, **kwargs):
                commands.append(list(command))
                return MagicMock(returncode=0)

            argv = ["rollout-candidate.py", "--node-side", "--kind", "fleet",
                    "--sha", NEW_SHA, "--archive", str(archive),
                    "--fleet-dir", str(fleet), "--previous-sha", OLD_SHA,
                    "--restart-cmd", "systemctl --user restart agent-herder-fleet.service",
                    "--web-port", "18791", "--unit", "agent-herder-fleet.service",
                    "--state-dir", str(root / "state")]
            with (patch.object(sys, "argv", argv),
                  patch.object(rollout.subprocess, "run", side_effect=run)):
                self.assertEqual(rollout.main(), 0)

            self.assertEqual(len(commands), 1)
            self.assertTrue(commands[0][1].endswith("rollout-node.py"))
            self.assertIn("--kind", commands[0])
            self.assertEqual(commands[0][commands[0].index("--kind") + 1], "fleet")
            # the fleet branch did not move the symlink itself
            self.assertEqual(os.readlink(fleet / "current"), f"releases/{OLD_SHA}")


if __name__ == "__main__":
    unittest.main()
