"""Run the existing isolated ZCode candidate driver on server-44."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile


REMOTE = r'''
import hashlib,json,os,shutil,subprocess,sys,tarfile,tempfile
from pathlib import Path
sha=sys.argv[1]
home=Path.home(); ci=home/'.local/share/agent-herder-ci'; ci.mkdir(parents=True,exist_ok=True)
runner=ci/'versions/zcode-l45-a7b04/run-isolated-native-ci.py'
if hashlib.sha256(runner.read_bytes()).hexdigest()!='a7b04ad8ad495e93e6c7f1069b494b1e49bddf7bd2606d204d2dc850894ffab0': raise RuntimeError('ZCode runner identity changed')
official=ci/'versions/zcode-server-3.17.2'
codex=home/'.npm-global/lib/node_modules/@openai/codex/bin/codex.js'
opencode=home/'.npm-global/lib/node_modules/@opencode/cli/bin/opencode.exe'
with tempfile.TemporaryDirectory(prefix='zcode-release-ci-',dir=ci) as tmp:
 root=Path(tmp); release=root/'releases'/sha; release.mkdir(parents=True)
 with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
  for member in archive:
   path=Path(member.name)
   if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()): raise RuntimeError('unsafe candidate archive')
   archive.extract(member,release)
 current=(home/'.local/share/agent-herder/fleet/current').resolve(strict=True)
 if hashlib.sha256((release/'package-lock.json').read_bytes()).digest()!=hashlib.sha256((current/'package-lock.json').read_bytes()).digest(): raise RuntimeError('ZCode dependency lock differs from installed store')
 os.symlink(str(current.parent.parent/'shared-node-modules'),root/'shared-node-modules')
 shutil.copytree(current/'node_modules',release/'node_modules',symlinks=True)
 receipt=root/'receipt.json'
 cmd=[sys.executable,str(runner),'--herder-dist',str(release/'dist'),'--codex',str(codex),'--opencode',str(opencode),'--zcode-official-root',str(official),'--zcode-official-only','--receipt',str(receipt)]
 result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=180,check=False)
 if result.returncode or not receipt.is_file(): raise RuntimeError('ZCode isolated runner failed: '+result.stderr[-1200:])
 print(receipt.read_text())
'''


def tested_payload_digest(root):
    root = Path(root)
    files = [root / 'package.json', root / 'packages/agent-resume/package.json']
    for folder in (root / 'dist', root / 'packages/agent-resume/dist'):
        if not folder.is_dir():
            raise ValueError('candidate payload unavailable')
        files.extend(path for path in folder.rglob('*') if path.is_file())
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def run_zcode_candidate(release, sha):
    release = Path(release).resolve(strict=True)
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha) or release.name != sha:
        raise ValueError('ZCode candidate SHA invalid')
    before = tested_payload_digest(release)
    with tempfile.TemporaryFile() as stream:
        with tarfile.open(fileobj=stream, mode='w', dereference=True) as archive:
            for name in ('dist', 'packages', 'package.json', 'package-lock.json', 'build-manifest.json'):
                archive.add(release / name, arcname=name)
        stream.seek(0)
        remote = shlex.join(['python3', '-c', REMOTE, sha])
        result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                 '-o', 'ConnectTimeout=10', 'roomhacker@192.168.2.5', remote],
                                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=240, check=False)
    if result.returncode:
        raise RuntimeError('ZCode server-44 candidate failed: ' + result.stderr[-1200:])
    report = json.loads(result.stdout)
    if before != tested_payload_digest(release):
        raise RuntimeError('candidate payload changed during ZCode CI')
    return report, before
