"""Real isolated release trees, native census binary, no service or configuration mutations."""
import importlib.util,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('rollout_node',ROOT/'deploy/fleet/rollout-node.py')
w=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(w)

class RolloutBudget(unittest.TestCase):
    def tree(self,folder,count,large=False):
        fleet=pathlib.Path(folder);releases=fleet/'releases';releases.mkdir()
        for n in range(count):(releases/str(n)).mkdir()
        source=releases/'0'/'package'
        with source.open('wb') as handle:
            if large:handle.truncate(512*1024**2+1)
            else:handle.write(b'x'*10000)
        for n in range(1,count):(releases/str(n)/'package').hardlink_to(source)
        subprocess.run(['cc','-std=c11','-D_DEFAULT_SOURCE','-Wall','-Wextra','-Werror',str(ROOT/'deploy/fleet/mac-artifact-probe.c'),'-o',str(fleet/'mac-artifact-probe')],check=True,timeout=5)
        (fleet/'node-config.json').write_text(json.dumps({'launcherHashes':{'mac-artifact-probe':w.sha256(fleet/'mac-artifact-probe')}}))
        return fleet

    def test_darwin_three_shared_releases_fit_four_rejects_and_over512_rejects(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,3)
            count,size=w.release_budget(fleet)
            expected=sum(((p.stat().st_size+1023)//1024)*1024 for p in [fleet/'releases',*[fleet/'releases'/str(n) for n in range(3)],fleet/'releases'/'0'/'package'])
            self.assertEqual(count,3);self.assertEqual(size,expected)
            self.assertTrue(w.release_budget_admitted(count,size))
            (fleet/'releases'/'fourth').mkdir()
            self.assertFalse(w.release_budget_admitted(*w.release_budget(fleet)))
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,3,large=True)
            with self.assertRaisesRegex(RuntimeError,'release_budget_census_failed'):w.release_budget(fleet)

    def test_linux_keeps_two_release_limit_and_counts_unique_physical_blocks(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','linux'):
            fleet=self.tree(folder,3)
            paths=[p for release in (fleet/'releases').iterdir() for p in (release,*release.rglob('*'))]
            seen=set();expected=0
            for path in paths:
                info=path.lstat();identity=(info.st_dev,info.st_ino)
                if identity not in seen:
                    expected+=info.st_blocks*512;seen.add(identity)
            self.assertEqual(w.release_budget(fleet),(3,expected))
            self.assertFalse(w.release_budget_admitted(*w.release_budget(fleet)))

    def test_darwin_rejects_probe_drift_before_executing_it(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(w.sys,'platform','darwin'):
            fleet=self.tree(folder,3);(fleet/'mac-artifact-probe').write_bytes(b'drift')
            with patch.object(w.subprocess,'run') as invoke:
                with self.assertRaisesRegex(RuntimeError,'release_budget_probe_identity_mismatch'):w.release_budget(fleet)
                invoke.assert_not_called()

if __name__=='__main__':unittest.main()
