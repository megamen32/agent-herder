"""Real isolated release trees, native census binary, no service or configuration mutations."""
import importlib.util,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('rollout_node',ROOT/'deploy/fleet/rollout-node.py')
w=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(w)

class RolloutBudget(unittest.TestCase):
    def tree(self, folder, sizes):
        fleet=pathlib.Path(folder);releases=fleet/'releases';releases.mkdir()
        for name,size in sizes.items():
            release=releases/name;release.mkdir()
            package=release/'package'
            with package.open('wb') as handle:
                if size > 16*1024*1024:handle.truncate(size)
                else:handle.write(b'x'*size)
        subprocess.run(['cc','-std=c11','-D_DEFAULT_SOURCE','-Wall','-Wextra','-Werror',str(ROOT/'deploy/fleet/mac-artifact-probe.c'),'-o',str(fleet/'mac-artifact-probe')],check=True,timeout=5)
        (fleet/'node-config.json').write_text(json.dumps({'launcherHashes':{'mac-artifact-probe':w.sha256(fleet/'mac-artifact-probe')}}))
        return fleet

    def test_oversized_rollback_release_is_not_charged_against_small_candidate(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,{'old':683*1024**2,'candidate':14*1024**2})
            count,size=w.release_budget(fleet,'candidate')
            candidate=fleet/'releases'/'candidate'
            expected=sum(((p.stat().st_size+1023)//1024)*1024 for p in [candidate,candidate/'package'])
            self.assertEqual(count,2);self.assertEqual(size,expected)
            self.assertTrue(w.release_budget_admitted(count,size))

    def test_oversized_candidate_fails_and_release_count_limit_remains_two(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,{'old':10000,'candidate':512*1024**2+1})
            with self.assertRaisesRegex(RuntimeError,'release_budget_census_failed'):
                w.release_budget(fleet,'candidate')
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,{'old':10000,'candidate':10000,'extra':10000})
            self.assertFalse(w.release_budget_admitted(*w.release_budget(fleet,'candidate')))

    def test_linux_keeps_two_release_limit_and_counts_unique_physical_blocks(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','linux'):
            fleet=self.tree(folder,{'old':10000,'candidate':10000,'extra':10000})
            candidate=fleet/'releases'/'candidate'
            expected=sum(p.lstat().st_blocks*512 for p in [candidate,candidate/'package'])
            self.assertEqual(w.release_budget(fleet,'candidate'),(3,expected))
            self.assertFalse(w.release_budget_admitted(*w.release_budget(fleet,'candidate')))
            with patch.object(w,'linux_release_bytes',side_effect=lambda path: 14*1024**2 if path.name=='candidate' else 683*1024**2):
                count,size=w.release_budget(fleet,'candidate')
            self.assertEqual((count,size),(3,14*1024**2))
            self.assertFalse(w.release_budget_admitted(count,size))
            self.assertFalse(w.release_budget_admitted(2,513*1024**2))

    def test_linux_small_candidate_passes_with_oversized_rollback_release(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','linux'):
            fleet=self.tree(folder,{'old':10000,'candidate':10000})
            with patch.object(w,'linux_release_bytes',side_effect=lambda path: 14*1024**2 if path.name=='candidate' else 683*1024**2):
                count,size=w.release_budget(fleet,'candidate')
            self.assertEqual((count,size),(2,14*1024**2))
            self.assertTrue(w.release_budget_admitted(count,size))
            with patch.object(w,'linux_release_bytes',return_value=513*1024**2):
                count,size=w.release_budget(fleet,'candidate')
            self.assertFalse(w.release_budget_admitted(count,size))

    def test_darwin_rejects_probe_drift_before_executing_it(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,{'old':10000,'candidate':10000});(fleet/'mac-artifact-probe').write_bytes(b'drift')
            with patch.object(w.subprocess,'run') as invoke:
                with self.assertRaisesRegex(RuntimeError,'release_budget_probe_identity_mismatch'):w.release_budget(fleet,'candidate')
                invoke.assert_not_called()

if __name__=='__main__':unittest.main()
