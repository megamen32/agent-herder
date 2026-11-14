import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/fleet"))
from quarantine_io import publish_exclusive

class QuarantinePublicationTest(unittest.TestCase):
    def test_exclusive_complete_single_link_record(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "receipt.json"
            publish_exclusive(path, b'{"complete":true}\n')
            self.assertEqual(path.read_bytes(), b'{"complete":true}\n')
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)
            with self.assertRaises(FileExistsError):
                publish_exclusive(path, b'changed')
            self.assertEqual(path.read_bytes(), b'{"complete":true}\n')

    def test_process_exit_before_and_after_atomic_publication(self):
        script = """import os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import quarantine_io as q
original=q.rename_noreplace
def crash(source,target):
    if sys.argv[3]=='after': original(source,target)
    os._exit(93)
q.rename_noreplace=crash
q.publish_exclusive(Path(sys.argv[2]),b'{"complete":true}\\n')
"""
        for boundary in ["before", "after"]:
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "receipt.json"
                result = subprocess.run([sys.executable, "-c", script, str(ROOT / "deploy/fleet"), str(path), boundary])
                self.assertEqual(result.returncode, 93)
                if boundary == "before":
                    self.assertFalse(path.exists())
                    publish_exclusive(path, b'{"complete":true}\n')
                self.assertEqual(path.read_bytes(), b'{"complete":true}\n')
                self.assertEqual(path.stat().st_nlink, 1)
                self.assertEqual(path.stat().st_mode & 0o777, 0o400)

if __name__ == "__main__":
    unittest.main()
