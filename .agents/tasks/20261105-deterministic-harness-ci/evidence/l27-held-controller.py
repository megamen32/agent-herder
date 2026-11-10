import json,os,subprocess,sys,time
from pathlib import Path
shared=Path('/dev/shm/herder-l27-codex-8OyaY6sZ/stage/full/shared');directory=shared/'held-active';peer=sys.argv[1];port=int((shared/'fixture-port').read_text())
def fetch(path):
 code='import json,sys,urllib.request; o=urllib.request.build_opener(urllib.request.ProxyHandler({})); print(o.open("http://127.0.0.1:"+sys.argv[1]+sys.argv[2],timeout=3).read().decode())'
 r=subprocess.run(['sudo','-n','nsenter','-t',peer,'-n','-S',str(os.getuid()),'-G',str(os.getgid()),'env','-i','PATH=/usr/bin:/bin','python3','-c',code,str(port),path],capture_output=True,text=True,check=True,timeout=6)
 return json.loads(r.stdout)
def marker(name,timeout):
 deadline=time.monotonic()+timeout
 while not (directory/name).exists():
  if time.monotonic()>deadline:raise RuntimeError(name+' timeout')
  time.sleep(.05)
 return json.loads((directory/name).read_text())
held=False
try:
 request=marker('hold-request.json',90);nonce=request['nonce'];response=fetch('/_hold');held=response.get('held') is True
 if not held:raise RuntimeError('fixture hold failed')
 (directory/'hold-ready.json').write_text(json.dumps({'nonce':nonce,'fixtureHeld':True}))
 active=marker('active-observed.json',35)
 if active.get('nonce')!=nonce or active.get('sessionId')!=request['sessionId']:raise RuntimeError('wrong active identity')
 stats=fetch('/_stats')
 if stats.get('requests')!=1:raise RuntimeError('held request count not exact')
 released=fetch('/_release');held=False
 if released.get('held') is not False:raise RuntimeError('fixture release failed')
 (directory/'release-ready.json').write_text(json.dumps({'nonce':nonce,'fixtureHeld':False}))
 (shared/'held-controller-receipt.json').write_text(json.dumps({'sessionId':active['sessionId'],'heldRequestCount':stats['requests'],'status':active['status'],'fixtureHeld':True,'released':True}))
finally:
 if held:
  try:fetch('/_release')
  except Exception:pass
