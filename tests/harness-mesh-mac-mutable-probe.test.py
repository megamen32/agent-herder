"""Focused integration: real C probe/owned files; expected2s/max20s.
Detects scanner/identity/limit regressions; not a Darwin runtime acceptance.
"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MutableNativeProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lease = tempfile.TemporaryDirectory(prefix='mutable-native-')
        cls.binary = Path(cls.lease.name) / 'probe'
        subprocess.run(['cc', '-Wall', '-Wextra', '-Werror',
                        str(ROOT / 'deploy/fleet/mac-artifact-probe.c'), '-o', str(cls.binary)],
                       check=True, capture_output=True, timeout=10)

    @classmethod
    def tearDownClass(cls):
        cls.lease.cleanup()

    def run_probe(self, folder, limit=4096, maximum=30000, inode_delta=0):
        info = folder.lstat()
        return subprocess.run([str(self.binary), '--mutable', str(limit), str(maximum),
                               str(info.st_uid), str(info.st_dev), str(info.st_ino + inode_delta)],
                              cwd=folder, capture_output=True, timeout=3)

    def test_recursive_exact_bytes_no_symlink_traversal_and_same_after_repeat(self):
        with tempfile.TemporaryDirectory(dir=self.lease.name) as tmp:
            base = Path(tmp); observed = base/'observed'; observed.mkdir()
            external = base/'outside'; external.mkdir(); (external/'data').write_bytes(bytes(8192))
            (observed/'nested').mkdir(); (observed/'nested'/'data').write_bytes(b'12345')
            (observed/'link').symlink_to('../outside')
            expected = 5 + (observed/'link').lstat().st_size
            for _ in range(2):
                result = self.run_probe(observed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, f'BYTES {expected}\n'.encode())

    def test_hard_byte_and_entry_limits_refuse_without_partial_stdout(self):
        with tempfile.TemporaryDirectory(dir=self.lease.name) as tmp:
            folder = Path(tmp)
            for i in range(4): (folder/str(i)).write_bytes(b'123')
            for limit, maximum, code in ((5, 30000, 68), (4096, 3, 67)):
                result = self.run_probe(folder, limit, maximum)
                self.assertEqual(result.returncode, code)
                self.assertEqual(result.stdout, b'')

    def test_wrong_root_generation_and_invalid_numeric_args_refuse(self):
        with tempfile.TemporaryDirectory(dir=self.lease.name) as tmp:
            result = self.run_probe(Path(tmp), inode_delta=1)
            self.assertEqual(result.returncode, 69); self.assertEqual(result.stdout, b'')
            for args in ([], ['-1', '30000', str(os.getuid()), '1', '1'],
                         ['4096', '30001', str(os.getuid()), '1', '1']):
                result = subprocess.run([str(self.binary), '--mutable', *args], cwd=tmp,
                                        capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 65)

    def test_existing_artifact_mode_still_reports_conservative_bytes_and_entries(self):
        with tempfile.TemporaryDirectory(dir=self.lease.name) as tmp:
            (Path(tmp)/'data').write_bytes(b'123')
            result = subprocess.run([str(self.binary), '1048576', '30001'], cwd=tmp,
                                    capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0)
            self.assertRegex(result.stdout.decode(), r'^BYTES [0-9]+ ENTRIES 2\n$')


if __name__ == '__main__': unittest.main()
