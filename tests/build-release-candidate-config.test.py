"""The candidate builder must preserve the exact live node config snapshot."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_release_candidate", ROOT / "deploy/fleet/build-release-candidate.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class BuildNodeConfigSnapshotTests(unittest.TestCase):
    def source(self, root, sha):
        source = root / 'source'
        (source / 'dist').mkdir(parents=True)
        (source / 'dist/fleet-deployment-manifest.json').write_text(
            json.dumps({'source_sha': sha}))
        return source

    def test_assemble_preserves_live_pointer_and_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            catalog = root / 'catalog'
            old = catalog / 'releases' / ('a' * 40)
            old.mkdir(parents=True)
            (old / 'sentinel').write_text('running release')
            current = catalog / 'current'
            current.symlink_to('releases/' + 'a' * 40)
            config = catalog / 'node-config.json'
            config.write_text('{"sourceSha":"old"}\n')
            before = config.read_bytes()
            release = builder.assemble('b' * 40, self.source(root, 'b' * 40), catalog)
            self.assertEqual(current.readlink(), pathlib.Path('releases/' + 'a' * 40))
            self.assertEqual((current / 'sentinel').read_text(), 'running release')
            self.assertEqual(config.read_bytes(), before)
            self.assertTrue((release / 'dist/fleet-deployment-manifest.json').is_file())

    def test_assemble_does_not_install_into_an_empty_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            catalog = root / 'catalog'
            release = builder.assemble('b' * 40, self.source(root, 'b' * 40), catalog)
            self.assertTrue(release.is_dir())
            self.assertFalse((catalog / 'current').is_symlink())
            self.assertFalse((catalog / 'current').exists())

    def test_rebuild_of_active_release_refused_before_moving_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            catalog = root / 'catalog'
            active = catalog / 'releases' / ('b' * 40)
            active.mkdir(parents=True)
            (active / 'sentinel').write_text('running release')
            (catalog / 'current').symlink_to(active)
            with self.assertRaisesRegex(RuntimeError, 'active release'):
                builder.assemble('b' * 40, self.source(root, 'b' * 40), catalog)
            self.assertEqual((active / 'sentinel').read_text(), 'running release')
            self.assertFalse((catalog / 'trash').exists())

    def test_existing_live_config_with_previous_source_sha_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "node-config.json"
            config.write_text('{"sourceSha":"af06240abbe0a9567289b40e0e44328ee49e1942"}\n')
            before = builder.snapshot_node_config(config)

            ok, detail = builder.node_config_matches_snapshot(config, before)

            self.assertTrue(ok, detail)
            self.assertNotEqual(builder.json.loads(before)["sourceSha"], "b" * 40)

    def test_config_change_during_build_fails_exact_snapshot_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "node-config.json"
            config.write_text('{"sourceSha":"af06240abbe0a9567289b40e0e44328ee49e1942"}\n')
            before = builder.snapshot_node_config(config)
            config.write_text('{"sourceSha":"b"}\n')

            ok, detail = builder.node_config_matches_snapshot(config, before)

            self.assertFalse(ok)
            self.assertIn("changed", detail)


if __name__ == "__main__":
    unittest.main()
