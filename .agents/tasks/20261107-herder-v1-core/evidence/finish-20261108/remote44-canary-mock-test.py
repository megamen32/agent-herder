#!/usr/bin/env python3
"""Run consumer against in-memory fake MCP; never touches network/native."""
import contextlib,hashlib,importlib.util,io,json,os,pathlib,sys,tempfile,unittest
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('canary',HERE/'remote44-full-canary.py');canary=importlib.util.module_from_spec(spec);spec.loader.exec_module(canary)
class Response:
 def __init__(self,result):self.result=result;self.headers={}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,*args):return json.dumps({'jsonrpc':'2.0','id':1,'result':self.result}).encode()
class Fake:
 def __init__(self,checkpoint,fail=False):self.checkpoint=checkpoint;self.fail=fail;self.effects=[];self.prompts=[]
 def __call__(self,req,timeout=0):
  body=json.loads(req.data);method=body['method'];params=body['params']
  if method=='initialize':return Response({'protocolVersion':'2025-06-18'})
  if method=='tools/list':return Response({'tools':[{'name':x} for x in ['discover','create','deliver','session','compat_task']]})
  name=params['name'];a=params['arguments']
  def ok(value):return Response({'isError':False,'structuredContent':value})
  if name=='discover':return ok({'instances':[{'node_ref':'server-44','instance_ref':'remote44'}]})
  if name in ('create','deliver'):
   c=json.loads(self.checkpoint.read_text());assert c['mutations'][name]['state']=='UNKNOWN';self.effects.append(name)
   if self.fail:raise TimeoutError('lost admission')
   self.prompts.append(a.get('prompt',a.get('message')));return ok({'task_ref':'task-'+name})
  if name=='compat_task':
   n=a['task_ref'].split('-')[-1];v={'create':{'session_ref':'s'},'prompt':{'outcome':'confirmed','native_receipt_id':'first'}} if n=='create' else {'outcome':'confirmed','native_receipt_id':'second'}
   return ok({'status':'completed','result':{'structuredContent':v}})
  if name=='session' and a['action']=='messages':
   rows=[]
   for prompt in self.prompts:rows.extend([{'role':'user','text':prompt},{'role':'assistant','text':prompt.split()[-1],'model':'gpt-6.1-terra'}])
   return ok({'page':{'messages':rows}})
  if name=='session' and a['action']=='archive':
   assert json.loads(self.checkpoint.read_text())['mutations']['archive']['state']=='UNKNOWN';self.effects.append('archive');return ok({'archived':True,'effect':'confirmed'})
  raise AssertionError(name)
class CanaryTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);r=pathlib.Path(self.tmp.name);(r/'.codex').mkdir();(r/'.codex/config.toml').write_text('[mcp_servers.gptadmin.http_headers]\nAuthorization = "Bearer fixture"\n');script=r/'wrapper';script.write_text('wrapper');config=pathlib.Path(str(script)+'.json');config.write_text(json.dumps({'nodeRef':'server-44','kind':'codex','model':'gpt-6.1-terra'}));config.chmod(0o600);sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();manifest=r/'manifest';manifest.write_text(json.dumps({'node':'/fixture/node','remote_ahap_wrappers':[{'node':'server-44','instance':'remote44','kind':'codex','script':str(script),'script_sha256':sha(script),'config_sha256':sha(config)}]}));profile=r/'profile';profile.write_text(json.dumps({'owner':{'node':'server-44','instance':'remote44','kind':'codex','executable':'/fixture/node','ahap_script':str(script),'ahap_env':{'AHAP_CODEX_MODEL':'gpt-6.1-terra'}}}));profile.chmod(0o600);self.checkpoint=r/'out/receipt.json';self.argv=['canary','--execute','--checkpoint',str(self.checkpoint),'--instance','remote44','--node','server-44','--manifest',str(manifest),'--manifest-sha256',sha(manifest),'--profile',str(profile)];self.home=patch('pathlib.Path.home',return_value=r);self.home.start();self.addCleanup(self.home.stop)
 def run_fake(self,fake):
  with patch.object(sys,'argv',self.argv),patch('urllib.request.urlopen',fake),contextlib.redirect_stdout(io.StringIO()):canary.main()
 def test_complete_and_refuse_existing_checkpoint(self):
  f=Fake(self.checkpoint);self.run_fake(f);self.assertEqual(f.effects,['create','deliver','archive']);self.assertEqual(json.loads(self.checkpoint.read_text())['status'],'PASS')
  with self.assertRaises(FileExistsError):self.run_fake(f)
  self.assertEqual(f.effects,['create','deliver','archive'])
 def test_unknown_no_replay(self):
  f=Fake(self.checkpoint,True)
  with self.assertRaises(TimeoutError):self.run_fake(f)
  self.assertEqual(json.loads(self.checkpoint.read_text())['mutations']['create']['state'],'UNKNOWN')
  with self.assertRaises(FileExistsError):self.run_fake(f)
  self.assertEqual(f.effects,['create'])
if __name__=='__main__':unittest.main(verbosity=2)
