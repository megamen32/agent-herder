import subprocess,json,select,os,time,hashlib
from pathlib import Path
entry='/home/roomhacker/.local/bin/agent-herder-v1'
receipt={'entry':entry,'model_sends':0,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':[]}
for attempt in range(2):
 p=subprocess.Popen([entry],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 buf=b'';seq=0
 def req(method,params):
  global buf,seq
  seq+=1;p.stdin.write((json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n').encode());p.stdin.flush()
  deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   while b'\n' in buf:
    line,buf=buf.split(b'\n',1)
    if not line.strip():continue
    packet=json.loads(line)
    if packet.get('id')==seq:
     if 'error' in packet:raise RuntimeError(json.dumps(packet['error']))
     return packet['result']
   if select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0]:
    chunk=os.read(p.stdout.fileno(),65536)
    if not chunk:raise RuntimeError('core closed: '+p.stderr.read(2000).decode())
    buf+=chunk
  raise TimeoutError(method)
 try:
  init=req('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'herder-installed-readback','version':'1'}})
  p.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n');p.stdin.flush()
  catalog=req('tools/list',{}); names=[t['name'] for t in catalog['tools']]
  instances=req('tools/call',{'name':'discover','arguments':{'action':'instances'}})
  assert not instances.get('isError'),instances
  projects=req('tools/call',{'name':'discover','arguments':{'action':'projects','instance_ref':'codex-local'}})
  assert not projects.get('isError'),projects
  core=[]
  for child in Path('/proc').iterdir():
   if not child.name.isdigit():continue
   try:
    status=(child/'status').read_text()
    if f'PPid:\t{p.pid}\n' in status:
     exe=(child/'exe').resolve()
     core.append({'pid':int(child.name),'exe':str(exe),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest()})
   except (OSError,PermissionError):pass
  row={'run':attempt+1,'protocol':init['protocolVersion'],'tool_count':len(names),'tools':names,'instances':instances.get('structuredContent',instances),'projects':projects.get('structuredContent',projects),'core_children':core}
  receipt['checks'].append(row)
  print(json.dumps({'run':attempt+1,'protocol':init['protocolVersion'],'tools':len(names),'instance_discovery':'PASS','projects_read':'PASS','core_children':core}),flush=True)
 finally:
  p.stdin.close()
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=5)
receipt['result']='PASS'
Path('.agents/tasks/20261107-herder-v1-core/evidence/finish-20261108/installed-v1-startup.json').write_text(json.dumps(receipt,indent=2)+'\n')
