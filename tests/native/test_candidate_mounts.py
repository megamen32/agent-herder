import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from launch import candidate_mounts, sandbox_command


class CandidateMountTest(unittest.TestCase):
    def test_candidate_and_store_are_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); candidate = root/'candidate'; store = root/'store'; scratch = root/'scratch'
            for p in (candidate, store, scratch): p.mkdir()
            with patch('launch.shutil.which', return_value='/usr/bin/bwrap'):
                args = sandbox_command(['/usr/bin/python3'], str(scratch), [candidate, store])
            for path in (candidate, store):
                i = args.index(str(path))
                self.assertEqual(args[i-1], '--ro-bind')
                self.assertEqual(args[i+1], str(path))

    def test_explicit_files_are_bound_read_only_without_parent_mount(self):
        with tempfile.TemporaryDirectory() as tmp, patch('launch.shutil.which', return_value='/usr/bin/bwrap'):
            root = Path(tmp); artifact = root/'release'/'core'; artifact.parent.mkdir()
            artifact.write_text('artifact')
            args = sandbox_command(['/usr/bin/python3'], str(root), [artifact])
            idx = args.index(str(artifact))
            self.assertEqual(args[idx - 1:idx + 2], ['--ro-bind', str(artifact), str(artifact)])
            self.assertNotIn(['--ro-bind', str(artifact.parent), str(artifact.parent)],
                             [args[i:i+3] for i in range(len(args)-2)])

    def test_explicit_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, patch('launch.shutil.which', return_value='/usr/bin/bwrap'):
            target = Path(tmp)/'target'; target.write_text('x')
            link = Path(tmp)/'link'; link.symlink_to(target)
            with self.assertRaises(ValueError):
                sandbox_command(['/usr/bin/python3'], tmp, [link])

    def test_missing_or_relative_exposure_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, patch('launch.shutil.which', return_value='/usr/bin/bwrap'):
            for bad in ('relative', str(Path(tmp)/'missing')):
                with self.subTest(path=bad), self.assertRaises(ValueError):
                    sandbox_command(['/usr/bin/python3'], tmp, [Path(bad)])

    def test_only_release_and_its_declared_shared_store_are_exposed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); release = base/'releases'/'abc'; store = base/'shared-node-modules'/'hash'
            (release/'dist').mkdir(parents=True); (release/'node_modules').mkdir()
            (release/'dist'/'index.js').write_text('fixture'); (release/'package.json').write_text('{}')
            (store/'.bin').mkdir(parents=True)
            (release/'node_modules'/'.bin').symlink_to(store/'.bin')
            self.assertEqual(candidate_mounts(release), [release, store])
            (release/'node_modules'/'.bin').unlink(); (release/'node_modules'/'.bin').symlink_to('/tmp')
            with self.assertRaises(ValueError): candidate_mounts(release)

    def test_sandbox_exposes_only_synthetic_passwd(self):
        with tempfile.TemporaryDirectory() as tmp, patch('launch.shutil.which', return_value='/usr/bin/bwrap'):
            args = sandbox_command(['/usr/bin/python3'], tmp)
            idx = args.index('/etc/passwd')
            self.assertEqual(args[idx-2], '--ro-bind')
            self.assertEqual(args[idx-1], str(Path(tmp)/'passwd'))

    def test_shared_store_detected_without_bin_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); release = base/'releases'/'abc'; store = base/'shared-node-modules'/'hash'
            (release/'dist').mkdir(parents=True); scope = release/'node_modules'/'@scope'; scope.mkdir(parents=True)
            (release/'dist'/'index.js').write_text('fixture'); (release/'package.json').write_text('{}')
            (store/'@scope'/'pkg').mkdir(parents=True)
            (scope/'pkg').symlink_to(store/'@scope'/'pkg')
            self.assertEqual(candidate_mounts(release), [release, store])


if __name__ == '__main__': unittest.main()
