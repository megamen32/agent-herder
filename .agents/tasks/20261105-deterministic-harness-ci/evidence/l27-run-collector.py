import importlib.util,json,os,time
from pathlib import Path
stage=Path('/dev/shm/herder-l27-codex-8OyaY6sZ/stage');root=stage.parent;shared=stage/'full/shared'
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('boundary',stage/'codex-unix-boundary.py');i=load('inspector',stage/'inspect-installed-herder.py')
class PeerCompletion:
 def __init__(self):self.returncode=None
 def communicate(self,timeout):
  deadline=time.monotonic()+timeout
  while not (shared/'stats.json').exists():
   if time.monotonic()>deadline:raise TimeoutError('peer stats missing')
   time.sleep(.05)
  self.returncode=0;return ('','')
p=m.PreparedPeer(root/'full-candidate/dist',root/'bin/codex.js');p.root=stage/'full';p.config=shared/'native-ci.json';p.token=json.loads(p.config.read_text())['token'];p.process=PeerCompletion();p.peer=m.inspect_isolated_peer(shared/'host.sock')
partial=i.artifact_fingerprint(root/'full-candidate');expected='d3c92601cdde1ab120cf7152630cf19d1947cb4d95255362dfa320ba14043d38'
receipt=p.collect('herder-l27-ci-full.service',41535,partial,expected)
(stage/'full/collector-result.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'status':receipt['status'],'codexScenarioStatus':receipt['codexScenarioStatus'],'sessions':receipt['sessions'],'pages':receipt['transcriptPages'],'requests':receipt['fixtureRequests'],'pid':receipt['before']['pid'],'starttime':receipt['before']['starttime'],'port':receipt['before']['port'],'fullDigest':receipt['fullArtifactComparison']['installed_sha256'],'artifactEvidenceStatus':receipt['artifactEvidenceStatus']}),flush=True)
