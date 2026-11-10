#!/usr/bin/env python3
"""Read native project config inside the isolated launcher; no model turn."""
import json,os,queue,subprocess,sys,threading,time
from pathlib import Path
home=Path(os.environ['HOME']); project=home/'project'; project.mkdir(); (project/'.codex').mkdir()
codex_home=home/'.codex'; codex_home.mkdir(); base=os.environ['HERDER_TEST_MODEL_BASE_URL']
(codex_home/'config.toml').write_text('model_provider = "fixture_default"\n[model_providers.fixture_default]\nname="default"\nbase_url="'+base+'"\nwire_api="responses"\n[projects."'+str(project)+'"]\ntrust_level="trusted"\n')
(project/'.codex/config.toml').write_text('model="project-model"\nmodel_provider="fixture_project"\n[model_providers.fixture_project]\nname="project"\nbase_url="'+base+'"\nwire_api="responses"\n')
env=dict(os.environ,CODEX_HOME=str(codex_home),PATH='/usr/local/bin:/usr/bin:/bin')
p=subprocess.Popen([sys.argv[1],'app-server'],cwd=home,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
q=queue.Queue()
def read():
 for line in p.stdout:
  try:q.put(json.loads(line))
  except ValueError:pass
threading.Thread(target=read,daemon=True).start()
def call(i,method,params):
 p.stdin.write(json.dumps({'id':i,'method':method,'params':params})+'\n');p.stdin.flush();deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  x=q.get(timeout=max(0.1,deadline-time.monotonic()))
  if x.get('id')==i:return x
 raise TimeoutError(method)
try:
 print('initialize', 'result' in call(1,'initialize',{'clientInfo':{'name':'ci-probe','version':'1'},'capabilities':{'experimentalApi':True}}),flush=True)
 result=call(2,'config/read',{'cwd':str(project),'includeLayers':True})
 if 'error' in result: print('config/read error',result['error'].get('message','unknown'))
 else:
  v=result.get('result',{});c=v.get('config',{});print('project provider',c.get('model_provider'),'layers',json.dumps(v.get('layers',[]))[:4000])
finally:
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
