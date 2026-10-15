"""Fast unit using real SQLite: inherited fleet file cap must permit checkpoint.

Detects live ZCode SQLITE_IOERR when its 97MiB DB inherits a16MiB file cap.
Expected1s, emergency10s. Disposable20MiB fixture, no production DB writes.
"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class NativeSqliteBudgetTest(unittest.TestCase):
    def test_file_budget_permits_existing_server100_database_size(self):
        """Fast unit expected1/max10s: one sparse page past measured3.44GB DB.

        Detects fleet256MiB cap still failing ordinary100 DB growth. Only one
        page is allocated; logical temporary bound8GiB, disposed by this test.
        """
        template = Path(__file__).parents[1] / 'deploy/fleet/linux-node.service'
        mib = int(re.search(r'^LimitFSIZE=(\d+)M$', template.read_text(), re.M)[1])
        with tempfile.TemporaryDirectory() as root:
            script = '''import os,resource,signal,sys
signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
cap=int(sys.argv[2])*1024*1024
resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
with open(sys.argv[1],'wb') as f:
 f.seek(3442515968+1024*1024);f.write(b'x');f.flush();os.fsync(f.fileno())
'''
            result = subprocess.run([sys.executable,'-c',script,str(Path(root)/'database-growth'),str(mib)],
                                    capture_output=True,text=True,timeout=8)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_native_sqlite_checkpoint_with_inherited_fleet_cap(self):
        template = Path(__file__).parents[1] / 'deploy/fleet/linux-node.service'
        mib = int(re.search(r'^LimitFSIZE=(\d+)M$', template.read_text(), re.M)[1])
        with tempfile.TemporaryDirectory() as root:
            script = '''import sqlite3,resource,signal,sys
c=sqlite3.connect(sys.argv[1])
c.execute('create table payload(value blob)')
c.execute('insert into payload values(zeroblob(20*1024*1024))');c.commit()
c.execute('pragma journal_mode=wal')
signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
cap=int(sys.argv[2])*1024*1024
resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
c.execute('insert into payload values(zeroblob(1024*1024))');c.commit()
result=c.execute('pragma wal_checkpoint(truncate)').fetchone()
assert result[0]==0,result
assert c.execute('select count(*) from payload').fetchone()[0]==2
c.close()
print('checkpoint-ok')
'''
            result = subprocess.run([sys.executable, '-c', script, str(Path(root)/'native.sqlite'), str(mib)],
                                    capture_output=True, text=True, timeout=8)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('checkpoint-ok', result.stdout)


if __name__ == '__main__':
    unittest.main()
