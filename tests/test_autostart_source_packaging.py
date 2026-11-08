import importlib.util,sys,tempfile,tarfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'deploy/fleet'))
spec=importlib.util.spec_from_file_location('source_rollout',ROOT/'deploy/fleet/rollout-candidate.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Packaging(unittest.TestCase):
 def test_actual_owner_archive_preserves_source_checker(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);release=root/'release';helper=release/'deploy/noticeplace/autostart_source_verifier.py';helper.parent.mkdir(parents=True);helper.write_bytes(b'# isolated source checker\n')
   archive=module.pack_release(release,root/'release.tar')
   with tarfile.open(archive) as packed:
    self.assertIn('./deploy/noticeplace/autostart_source_verifier.py',packed.getnames())
    self.assertEqual(packed.extractfile('./deploy/noticeplace/autostart_source_verifier.py').read(),helper.read_bytes())
if __name__=='__main__':unittest.main()
