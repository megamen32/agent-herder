"""Focused integration: exact built closure; expected 1s, max 10s."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('manifest', pathlib.Path(__file__).parents[1] / 'deploy/fleet/write-deployment-manifest.py')
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)

class ManifestTest(unittest.TestCase):
    def test_pins_inputs_and_output_without_self_hash_or_unrelated_wip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'src').mkdir(); (root / 'src/index.ts').write_text('original')
            for command in [['init', '-q'], ['add', 'src'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]:
                subprocess.run(['git', '-C', directory, *command], check=True)
            (root / 'foreign.md').write_text('preserve')
            dist = root / 'dist'; (dist / 'web').mkdir(parents=True)
            (dist / 'index.js').write_text('backend'); (dist / 'web/index.html').write_text('frontend')
            (dist / 'fleet-deployment-manifest.json').write_text('stale')
            receipt = root / 'receipt.json'; manifest.capture(root, receipt)
            result = manifest.write(root, dist, receipt); manifest.verify(root, dist)
            self.assertFalse(result['source_dirty']); self.assertTrue(result['checkout_dirty'])
            self.assertEqual(len(result['source_sha']), 40)
            self.assertNotIn('fleet-deployment-manifest.json', result['payload'])
            self.assertEqual((root / 'foreign.md').read_text(), 'preserve')
            (dist / 'index.js').write_text('different')
            with self.assertRaises(ValueError): manifest.verify(root, dist)
            (root / 'src/index.ts').write_text('different')
            with self.assertRaises(ValueError): manifest.write(root, dist, receipt)

if __name__ == '__main__': unittest.main()
