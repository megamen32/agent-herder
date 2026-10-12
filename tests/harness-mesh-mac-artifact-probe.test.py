"""Fast unit expected <1s/max5s, tiny portable compile and real isolated trees."""
import pathlib,subprocess,tempfile,unittest
SOURCE=pathlib.Path(__file__).resolve().parents[1]/'deploy/fleet/mac-artifact-probe.c'

class ArtifactProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.exe=pathlib.Path(cls.temp.name)/'probe'
        subprocess.run(['cc','-std=c11','-D_DEFAULT_SOURCE','-Wall','-Wextra','-Werror',str(SOURCE),'-o',str(cls.exe)],check=True,timeout=3)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def run_probe(self,root,limit=536870912,entries=30001):
        return subprocess.run([str(self.exe),str(limit),str(entries)],cwd=root,text=True,capture_output=True,timeout=2)
    def test_physical_tree_counts_hardlinks_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base=pathlib.Path(directory);root=base/'releases';root.mkdir();(root/'a').write_bytes(b'a'*2049)
            (root/'b').hardlink_to(root/'a');(base/'outside').write_bytes(b'x'*1000000);(root/'link').symlink_to(base/'outside')
            r=self.run_probe(root);self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual(int(r.stdout.split()[-1]),4)
            self.assertGreaterEqual(int(r.stdout.split()[1]),2*3072)
            self.assertLess(int(r.stdout.split()[1]),1000000)
    def test_newline_names_are_one_entry_and_directory_postorder_is_not_double_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'child').mkdir();(root/'child'/'line\nbreak').write_text('x')
            r=self.run_probe(root);self.assertEqual(r.returncode,0);self.assertEqual(int(r.stdout.split()[-1]),3)
    def test_hard_byte_and_entry_limits_refuse_without_partial_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'a').write_bytes(b'x'*2000)
            for limit,entries,code in [(536870912,1,67),(1024,30001,68),(536870913,30001,65)]:
                with self.subTest(limit=limit,entries=entries):
                    r=self.run_probe(root,limit,entries);self.assertEqual(r.returncode,code);self.assertEqual(r.stdout,'');self.assertEqual(r.stderr,'')

if __name__=='__main__':unittest.main()
