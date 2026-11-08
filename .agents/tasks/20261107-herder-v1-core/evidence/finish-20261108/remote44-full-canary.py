#!/usr/bin/env python3
"""One-shot remote44 V1 consumer. No send unless explicitly --execute.

Checkpoint is created exclusively before first mutation. An existing checkpoint
is never resumed/replayed automatically, including after a process crash.
"""
import argparse,hashlib,json,os,pathlib,re,tempfile,time,urllib.request,uuid,subprocess,select,atexit
URL='https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp'
MODEL='gpt-6.1-terra'

def task_ref(result):
 return result.get('task_ref') or result.get('taskId') or result.get('_herder_create_task') or result.get('_herder_delivery_task')

def message_rows(result):
 page=result.get('page')
 return page.get('messages',[]) if isinstance(page,dict) else result.get('messages',[])

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute',action='store_true');ap.add_argument('--checkpoint',required=True,type=pathlib.Path);ap.add_argument('--instance',required=True);ap.add_argument('--node',required=True);ap.add_argument('--manifest',required=True,type=pathlib.Path);ap.add_argument('--manifest-sha256',required=True);ap.add_argument('--profile',required=True,type=pathlib.Path);ap.add_argument('--selector',required=True,type=pathlib.Path);a=ap.parse_args()
 if a.node!='server-44':raise SystemExit('exact remote node must be server-44')
 raw=a.manifest.read_bytes();assert hashlib.sha256(raw).hexdigest()==a.manifest_sha256,'manifest mismatch'
 manifest=json.loads(raw);profile=json.loads(a.profile.read_text());owner=profile['owner'];assert owner['node']==a.node and owner['instance']==a.instance and owner['kind']=='codex','profile identity mismatch'
 st=a.profile.lstat();assert a.profile.is_absolute() and a.profile.resolve()==a.profile and st.st_uid==os.getuid() and st.st_nlink==1 and not st.st_mode & 0o077,'profile not private'
 wrappers=manifest.get('remote_ahap_wrappers',[]);matching=[x for x in wrappers if x.get('node')==a.node and x.get('instance')==a.instance and x.get('kind')=='codex' and x.get('script')==owner.get('ahap_script')];assert len(matching)==1,'manifest remote binding mismatch'
 w=matching[0];script=pathlib.Path(w['script']);companion=pathlib.Path(str(script)+'.json');assert hashlib.sha256(script.read_bytes()).hexdigest()==w['script_sha256'] and hashlib.sha256(companion.read_bytes()).hexdigest()==w['config_sha256'],'wrapper or config mismatch';remote=json.loads(companion.read_text());assert remote.get('nodeRef')==a.node and remote.get('kind')=='codex' and remote.get('model')==MODEL,'remote config identity/model mismatch'
 assert owner.get('executable')==manifest.get('node'),'wrong packaged node'
 selector=json.loads(a.selector.read_text());assert str(a.profile) in selector['profiles'] and pathlib.Path(selector['manifest'])==a.manifest and selector['manifest_sha256']==a.manifest_sha256,'selector mismatch'
 launcher=pathlib.Path(__file__).resolve().parents[3]/'deploy/fleet/launch-v1-core.py'
 # Resolve from the integration checkout, never from current working directory.
 launcher=pathlib.Path('/home/roomhacker/.codex/worktrees/herder-final-acceptance/agent-herder/deploy/fleet/launch-v1-core.py')
 env=dict(os.environ,HERDER_V1_ENTRY=str(a.selector));proc=subprocess.Popen(['python3',str(launcher)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env);atexit.register(lambda: proc.terminate() if proc.poll() is None else None);seq=0
 def rpc(method,params):
  nonlocal seq
  seq+=1;proc.stdin.write(json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n');proc.stdin.flush()
  deadline=time.monotonic()+60
  while time.monotonic()<deadline:
   if not select.select([proc.stdout],[],[],max(0,deadline-time.monotonic()))[0]:break
   line=proc.stdout.readline()
   if not line:break
   d=json.loads(line)
   if d.get('id')!=seq:continue
   if d.get('error'):raise RuntimeError('MCP RPC error: '+str(d['error'].get('code')))
   return d.get('result',{})
  raise TimeoutError('MCP read timeout; outcome unknown')
 def call(name,args):
  r=rpc('tools/call',{'name':name,'arguments':args});v=r.get('structuredContent')
  if not isinstance(v,dict):
   try:v=json.loads(r['content'][0]['text'])
   except (KeyError,ValueError,IndexError,TypeError):v={}
  if r.get('isError'):raise RuntimeError('tool error: '+str(v.get('code') or (v.get('error') or {}).get('code','unknown')))
  return v
 rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'remote44-canary','version':'1'}})
 tools=rpc('tools/list',{}).get('tools',[]);assert {'discover','create','deliver','session','compat_task'} <= {x.get('name') for x in tools}
 instances=call('discover',{'action':'instances','node_ref':a.node});assert any(x.get('node_ref')==a.node and x.get('instance_ref')==a.instance for x in instances.get('instances',[])),'remote instance unavailable'
 if not a.execute:print(json.dumps({'status':'PREFLIGHT_ONLY','model':MODEL,'node':a.node,'instance':a.instance,'manifest_sha256':a.manifest_sha256}));return
 a.checkpoint.parent.mkdir(parents=True,exist_ok=True,mode=0o700);fd=os.open(a.checkpoint,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);run=uuid.uuid4().hex;state={'status':'PREPARED','run':run,'node':a.node,'instance':a.instance,'model':MODEL,'manifest_sha256':a.manifest_sha256,'mutations':{}}
 def save():
  fd2,tmp=tempfile.mkstemp(prefix='.remote44-',dir=a.checkpoint.parent);os.fchmod(fd2,0o600)
  with os.fdopen(fd2,'w') as f:json.dump(state,f,indent=2);f.flush();os.fsync(f.fileno())
  os.replace(tmp,a.checkpoint);directory=os.open(a.checkpoint.parent,os.O_RDONLY);os.fsync(directory);os.close(directory)
 os.close(fd);save()
 def mutate(name,tool,args):
  state['mutations'][name]={'state':'UNKNOWN','request_key':args['request_key']};save()
  result=call(tool,args);state['mutations'][name]['admission']=result;save();return result
 def wait_task(ref):
  end=time.monotonic()+150
  while time.monotonic()<end:
   result=call('compat_task',{'action':'get','task_ref':ref});state['last_task']=result;save()
   if result.get('status') in ('completed','failed','cancelled'):return result
   time.sleep(2)
  raise RuntimeError('task timeout; outcome unknown; no replay')
 def content(task):
  result=task.get('result') or {};return result.get('structuredContent') or {}
 def task_receipt(result):
  ref=task_ref(result);assert ref,'missing task receipt, no replay';t=wait_task(ref);assert t.get('status')=='completed','task not completed, no replay';return content(t)
 markers=['HERDER_REMOTE44_'+run+'_1','HERDER_REMOTE44_'+run+'_2'];prompts=['Reply with exactly '+x for x in markers];state['markers']=markers;save()
 try:
  first=task_receipt(mutate('create','create',{'action':'create','instance_ref':a.instance,'prompt':prompts[0],'request_key':run+'-create'}));ref=first.get('create',{}).get('session_ref');receipt=first.get('prompt',{});assert ref and receipt.get('outcome')=='confirmed' and receipt.get('native_receipt_id'),'create not confirmed';state['session_ref']=ref;state['first_receipt']=receipt;save()
  def wait_marker(marker,prompt):
   end=time.monotonic()+150
   while time.monotonic()<end:
    r=call('session',{'action':'messages','session_ref':ref});state['readback']=r;save();rows=message_rows(r)
    if any(x.get('role')=='user' and prompt==x.get('text','') for x in rows) and any(x.get('role')=='assistant' and marker==x.get('text','').strip() for x in rows):return
    time.sleep(5)
   raise RuntimeError('readback timeout; no resend')
  wait_marker(markers[0],prompts[0]);second=task_receipt(mutate('deliver','deliver',{'action':'session','session_ref':ref,'message':prompts[1],'mode':'queue','request_key':run+'-deliver'}));assert second.get('outcome')=='confirmed' and second.get('native_receipt_id') and second['native_receipt_id']!=receipt['native_receipt_id'],'second receipt unconfirmed';state['second_receipt']=second;save();wait_marker(markers[1],prompts[1]);archive=mutate('archive','session',{'action':'archive','session_ref':ref,'request_key':run+'-archive'});assert archive.get('archived') is True and archive.get('effect')=='confirmed','archive unconfirmed';state['status']='PASS';save();print(json.dumps({'status':'PASS','checkpoint':str(a.checkpoint),'markers':markers}))
 except Exception as e:
  state['status']='INCOMPLETE';state['error_type']=type(e).__name__;state['error']=str(e)[:300];save();raise
if __name__=='__main__':main()
