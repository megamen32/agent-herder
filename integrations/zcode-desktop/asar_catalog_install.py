#!/usr/bin/env python3
"""Journalled single-entry ASAR update. Old entry bytes stay in the archive.
No full archive copy, repack, process restart or application state mutation.
"""
import argparse,copy,fcntl,hashlib,json,os,stat,struct
from pathlib import Path
ENTRY=('out','host','index.js')
def digest(data):return hashlib.sha256(data).hexdigest()
def read_entry(path):
 with Path(path).open('rb') as f:
  first=f.read(16);h=struct.unpack('<IIII',first);raw=f.read(h[3]);header=json.loads(raw);e=header
  for name in ENTRY:e=e['files'][name]
  base=8+h[1];f.seek(base+int(e['offset']));body=f.read(e['size'])
 return h,raw,header,e,body,base

def write_at(fd,data,offset):
 while data:
  count=os.pwrite(fd,data,offset)
  if count<=0:raise OSError('short archive write')
  offset+=count;data=data[count:]

def apply_archive(path,candidate,backup,expected_old_sha256):
 path=Path(path);backup=Path(backup);candidate=bytes(candidate)
 fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX)
  before=os.fstat(fd);h,raw,header,entry,old,base=read_entry(path)
  if digest(old)!=expected_old_sha256:raise ValueError('Installed native host changed; refusing update')
  replacement=copy.deepcopy(entry);replacement['offset']=str(before.st_size-base);replacement['size']=len(candidate)
  if replacement.get('integrity',{}).get('algorithm')!='SHA256':raise ValueError('Unsupported ASAR integrity algorithm')
  integrity=replacement['integrity'];integrity['hash']=digest(candidate);size=integrity['blockSize'];integrity['blocks']=[digest(candidate[i:i+size]) for i in range(0,len(candidate),size)]
  encode=lambda obj:json.dumps(obj,ensure_ascii=False,separators=(',',':')).encode()
  original_meta=encode(entry);patched_meta=encode(replacement)
  if raw.count(original_meta)!=1 or len(patched_meta)!=len(original_meta):raise ValueError('Metadata cannot be updated in one fixed-size entry')
  offset=16+raw.index(original_meta)
  backup.mkdir(mode=0o700,parents=True,exist_ok=False)
  # Protected journal is under8MiB, versus a340MiB full archive. Original
  # source bytes remain intact; rollback restores header and original length.
  (backup/'header.bin').write_bytes(os.pread(fd,base,0));(backup/'header.bin').chmod(0o600)
  journal={'path':str(path.resolve()),'device':before.st_dev,'inode':before.st_ino,'size':before.st_size,'base':base,'metadata_offset':offset,'old_sha256':digest(old),'candidate_sha256':digest(candidate),'new_size':before.st_size+len(candidate)}
  (backup/'manifest.json').write_text(json.dumps(journal));(backup/'manifest.json').chmod(0o600)
  for name in ['header.bin','manifest.json']:
   with (backup/name).open('rb') as f:os.fsync(f.fileno())
  for directory in [backup,backup.parent]:
   directory_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(directory_fd)
   finally:os.close(directory_fd)
  try:
   write_at(fd,candidate,before.st_size);os.fsync(fd)
   write_at(fd,patched_meta,offset);os.fsync(fd)
   if digest(read_entry(path)[4])!=digest(candidate):raise ValueError('Installed entry readback differs')
  except BaseException:
   write_at(fd,original_meta,offset);os.ftruncate(fd,before.st_size);os.fsync(fd);raise
  return {**journal,'installed':True,'rollback':str(backup),'processes_restarted':False}
 finally:os.close(fd)

def rollback_archive(backup):
 backup=Path(backup);j=json.loads((backup/'manifest.json').read_text());fd=os.open(j['path'],os.O_RDWR|os.O_NOFOLLOW)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX);current=os.fstat(fd)
  if (current.st_dev,current.st_ino,current.st_size)!=(j['device'],j['inode'],j['new_size']):raise ValueError('Archive identity/size changed; manual reconciliation required')
  if digest(read_entry(j['path'])[4])!=j['candidate_sha256']:raise ValueError('Installed entry changed since this patch')
  write_at(fd,(backup/'header.bin').read_bytes(),0);os.ftruncate(fd,j['size']);os.fsync(fd)
  if digest(read_entry(j['path'])[4])!=j['old_sha256']:raise ValueError('Rollback readback differs')
  return {'rolled_back':True,'processes_restarted':False}
 finally:os.close(fd)

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--archive');p.add_argument('--candidate');p.add_argument('--backup');p.add_argument('--expected-old-sha256');p.add_argument('--rollback');a=p.parse_args()
 if os.geteuid()!=0:raise SystemExit('Native installation requires the explicitly approved root operation')
 if a.rollback:result=rollback_archive(a.rollback)
 else:
  if not all([a.archive,a.candidate,a.backup,a.expected_old_sha256]):p.error('apply requires archive, candidate, backup and reviewed original hash')
  result=apply_archive(a.archive,Path(a.candidate).read_bytes(),a.backup,a.expected_old_sha256)
 print(json.dumps(result))
