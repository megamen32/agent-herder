# Focused integration, expected .1s/max2s: format/integrity/rollback, not a UI proof.
import unittest,tempfile,json,struct,hashlib
from pathlib import Path
from asar_catalog_install import apply_archive,read_entry,rollback_archive
class ArchiveUpdate(unittest.TestCase):
 def fixture(self,root):
  entry={'size':3,'offset':'0','integrity':{'algorithm':'SHA256','hash':hashlib.sha256(b'old').hexdigest(),'blockSize':4194304,'blocks':[hashlib.sha256(b'old').hexdigest()]}}
  j={'files':{'out':{'files':{'host':{'files':{'index.js':entry}}}}}};raw=json.dumps(j,separators=(',',':')).encode();pad=b'\0'*((-len(raw))%4);header_size=8+len(raw)+len(pad);p=root/'app.asar';p.write_bytes(struct.pack('<IIII',4,header_size,header_size-4,len(raw))+raw+pad+b'old');return p
 def test_integrity_readback_and_exact_rollback(self):
  with tempfile.TemporaryDirectory() as name:
   r=Path(name);p=self.fixture(r);before=p.read_bytes();old=hashlib.sha256(b'old').hexdigest();result=apply_archive(p,b'new',r/'backup',old);self.assertTrue(result['installed']);self.assertEqual(read_entry(p)[4],b'new');self.assertEqual(p.read_bytes()[read_entry(p)[5]:][:3],b'old');rollback_archive(r/'backup');self.assertEqual(p.read_bytes(),before)
 def test_unknown_source_refuses_before_any_write(self):
  with tempfile.TemporaryDirectory() as name:
   r=Path(name);p=self.fixture(r);before=p.read_bytes()
   with self.assertRaisesRegex(ValueError,'changed'):apply_archive(p,b'new',r/'backup','unknown')
   self.assertEqual(p.read_bytes(),before);self.assertFalse((r/'backup').exists())
 def test_rollback_never_overwrites_a_later_archive_change(self):
  with tempfile.TemporaryDirectory() as name:
   r=Path(name);p=self.fixture(r);apply_archive(p,b'new',r/'backup',hashlib.sha256(b'old').hexdigest());p.write_bytes(p.read_bytes()+b'foreign');before=p.read_bytes()
   with self.assertRaisesRegex(ValueError,'changed'):rollback_archive(r/'backup')
   self.assertEqual(p.read_bytes(),before)
if __name__=='__main__':unittest.main()
