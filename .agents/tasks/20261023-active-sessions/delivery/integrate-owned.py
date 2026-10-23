from pathlib import Path
import subprocess,os,tempfile,hashlib,json
canonical=Path('/home/roomhacker/agents-projects/agent-herder');worktree=Path.cwd()
def git(*args,cwd=canonical,env=None):return subprocess.check_output(['git',*args],cwd=cwd,env=env)
old=git('rev-parse','HEAD').decode().strip();new=git('rev-parse','HEAD',cwd=worktree).decode().strip()
assert old=='f139e3f6e48a6fbcbd195b44dec5f824f31e4bdc',('canonical_head_changed',old)
assert git('rev-parse','origin/main').decode().strip()==old,'origin_main_changed'
subprocess.run(['git','merge-base','--is-ancestor',old,new],cwd=canonical,check=True)
assert not git('diff','--cached','--name-only'),'foreign_staged_index'
assert not git('diff','--name-only','HEAD','--','src','tests',cwd=worktree),'worker_source_not_committed'
patch=git('diff','--binary',old,new,'--','src','tests',cwd=worktree)
subprocess.run(['git','apply','--check','-'],cwd=canonical,input=patch,check=True)
index=Path(git('rev-parse','--path-format=absolute','--git-path','index').decode().strip());before_index=index.read_bytes();lock=Path(str(index)+'.lock')
fd,temp=tempfile.mkstemp(prefix='active-index-',dir=index.parent);os.close(fd);os.unlink(temp)
env={**os.environ,'GIT_INDEX_FILE':temp};subprocess.run(['git','read-tree',new],cwd=canonical,env=env,check=True)
owned=set(git('diff','--name-only',old,new,cwd=worktree).decode().splitlines())
status=git('status','--porcelain=v1','-z').decode();untouched={}
for entry in status.split('\0'):
 if not entry:continue
 path=entry[3:];file=canonical/path
 if path not in owned and file.is_file():untouched[path]=hashlib.sha256(file.read_bytes()).hexdigest()
receipt={'oldHead':old,'newHead':new,'foreignStatusBefore':status,'unownedWipHashes':untouched,'indexBeforeSHA256':hashlib.sha256(before_index).hexdigest()}
lock_fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
try:
 assert index.read_bytes()==before_index,'index_changed_before_lock'
 assert git('rev-parse','HEAD').decode().strip()==old,'head_changed_before_lock'
 assert not git('diff','--cached','--name-only'),'foreign_staging_during_prepare'
 subprocess.run(['git','apply','-'],cwd=canonical,input=patch,check=True)
 subprocess.run(['git','update-ref','refs/heads/main',new,old],cwd=canonical,check=True)
 os.replace(temp,index)
finally:
 os.close(lock_fd);lock.unlink()
for path,digest in untouched.items():assert hashlib.sha256((canonical/path).read_bytes()).hexdigest()==digest,('unowned_wip_changed',path)
receipt['foreignStatusAfter']=git('status','--porcelain=v1','-z').decode();receipt['newMain']=git('rev-parse','main').decode().strip();receipt['indexStagedAfter']=git('diff','--cached','--name-only').decode()
(worktree/'.tmp/integration-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'main':new,'foreignWipFilesPreserved':len(untouched),'foreignIndexPreserved':not receipt['indexStagedAfter']}))
