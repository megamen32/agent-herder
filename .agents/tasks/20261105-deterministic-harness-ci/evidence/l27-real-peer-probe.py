import importlib.util,json,os,socket,subprocess,time
from pathlib import Path
stage=Path('/dev/shm/herder-l27-codex-8OyaY6sZ/stage');shared=stage/'shared'
interfaces=[x.split(':',1)[0].strip() for x in Path('/proc/net/dev').read_text().splitlines()[2:] if ':' in x]
if interfaces!=['lo'] or Path('/home/roomhacker/.codex').exists():raise RuntimeError('outer sandbox not isolated')
s=socket.socket();s.settimeout(1);network_errno=s.connect_ex(('192.168.2.5',22));s.close()
if network_errno==0:raise RuntimeError('production network reachable')
cmd=['unshare','--user','--map-root-user','--net','--mount','python3',str(stage/'native-netns-launcher.py'),str(stage),'bwrap','--die-with-parent','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--dir','/etc','--tmpfs','/run','--dir','/tmp','--proc','/proc','--dev','/dev','--ro-bind',str(stage),'/mnt','--dir','/dev/shm','--dir','/dev/shm/herder-l27-codex-8OyaY6sZ','--dir',str(stage),'--bind',str(shared),str(shared),'--ro-bind','/opt','/opt','--bind',str(shared/'tmp'),'/tmp','--clearenv','--setenv','PATH','/usr/local/bin:/usr/sbin:/usr/bin:/bin','/usr/bin/python3','/mnt/codex-unix-boundary.py','--inside',str(shared)]
p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 deadline=time.monotonic()+35
 while not (shared/'ready').exists():
  if p.poll() is not None:raise RuntimeError('peer failed: '+p.stderr.read()[-1500:])
  if time.monotonic()>deadline:raise RuntimeError('peer timeout')
  time.sleep(.1)
 spec=importlib.util.spec_from_file_location('boundary',stage/'codex-unix-boundary.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 target=module.test_socket_target(shared,(shared/'ready').read_text());(shared/'host.sock').symlink_to(target.relative_to(shared))
 js="import {inspectNativeCiPeer} from './native-ci-peer.mjs';console.log(JSON.stringify(await inspectNativeCiPeer(process.argv[1])));"
 v=subprocess.run(['node','--input-type=module','-e',js,str(shared/'host.sock')],cwd=stage,text=True,capture_output=True,check=True,timeout=10)
 peer=json.loads(v.stdout);assert peer['pid']>0 and peer['start'].isdigit()
 (shared/'done').write_text('ok');_,err=p.communicate(timeout=10)
 if p.returncode:raise RuntimeError(err[-1500:])
 stats=json.loads((shared/'stats.json').read_text())
 print(json.dumps({'scope':'shared-pid-real-codex-peer-probe','peer':peer,'interfaces':interfaces,'productionLanConnectErrno':network_errno,'productionHomeVisible':False,'modelRequests':stats['requests'],'status':'PASS'}),flush=True)
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=5)
