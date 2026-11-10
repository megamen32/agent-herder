import importlib.util,json,os,secrets,signal,socket,subprocess,sys,time,urllib.request
from pathlib import Path
stage=Path('/dev/shm/herder-l27-codex-8OyaY6sZ/stage');root=stage.parent;shared=stage/'full/shared';release=root/'full-release'
if [x.split(':',1)[0].strip() for x in Path('/proc/net/dev').read_text().splitlines()[2:] if ':' in x]!=['lo'] or Path('/home/roomhacker/.codex').exists():raise RuntimeError('unit sandbox not isolated')
s=socket.socket();s.settimeout(1);network_errno=s.connect_ex(('192.168.2.5',22));s.close()
if network_errno==0:raise RuntimeError('production network reachable')
cmd=['unshare','--user','--map-root-user','--net','--mount','python3',str(stage/'native-netns-launcher.py'),str(stage),'bwrap','--die-with-parent','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--dir','/etc','--tmpfs','/run','--dir','/tmp','--proc','/proc','--dev','/dev','--ro-bind',str(stage),'/mnt','--dir','/dev/shm','--dir',str(root),'--dir',str(stage),'--bind',str(shared),str(shared),'--ro-bind','/opt','/opt','--bind',str(shared/'tmp'),'/tmp','--clearenv','--setenv','PATH','/usr/local/bin:/usr/sbin:/usr/bin:/bin','/usr/bin/python3','/mnt/codex-unix-boundary.py','--inside',str(shared)]
peer=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);herder=None
def stop(*_args):raise SystemExit(143)
signal.signal(signal.SIGTERM,stop)
try:
 deadline=time.monotonic()+35
 while not (shared/'ready').exists():
  if peer.poll() is not None:raise RuntimeError('peer failed: '+peer.stderr.read()[-1500:])
  if time.monotonic()>deadline:raise RuntimeError('peer timeout')
  time.sleep(.1)
 spec=importlib.util.spec_from_file_location('boundary',stage/'codex-unix-boundary.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 target=module.test_socket_target(shared,(shared/'ready').read_text());(shared/'host.sock').symlink_to(target.relative_to(shared))
 token=secrets.token_hex(32);(shared/'native-ci.json').write_text(json.dumps({'token':token}));(shared/'native-ci.json').chmod(0o600)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 env={'PATH':'/usr/local/bin:/usr/sbin:/usr/bin:/bin','HOME':str(shared/'home'),'CODEX_HOME':str(shared/'home'/'synthetic-codex-home'),'AGENT_HERDER_NATIVE_CI_CONFIG':str(shared/'native-ci.json'),'AGENT_HERDER_WEB_HOST':'127.0.0.1','AGENT_HERDER_WEB_PORT':str(port),'AGENT_HERDER_SINGLETON_LOCK':str(shared/'stand.lock'),'AGENT_HERDER_FLEET_PEERS':'[]','AGENT_HERDER_HTTP_TOKEN':'synthetic-test-token','AGENT_HERDER_AUTOPILOT_STATE_DIR':str(shared/'autopilot'),'AGENT_HERDER_WORKLOAD_ISOLATION':'off',**{f'ENABLE_{h}':'false' for h in ('CODEX','OPENCODE','CLAUDE','QODER','HERMES','ZCODE','MINIMAX_CODE','FAST_AGENT')}}
 herder=subprocess.Popen(['node',str(release/'dist/index.js')],cwd=shared/'work',env=env,stdout=subprocess.DEVNULL,stderr=(shared/'herder.log').open('w'))
 deadline=time.monotonic()+35
 while True:
  if herder.poll() is not None:raise RuntimeError('Herder exited: '+(shared/'herder.log').read_text()[-2000:])
  try:
   req=urllib.request.Request(f'http://127.0.0.1:{port}/api/sessions',headers={'x-herder-native-ci':token})
   with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=1) as response:
    if response.status==200:break
  except Exception:
   if time.monotonic()>deadline:raise
   time.sleep(.1)
 (shared/'unit-ready.json').write_text(json.dumps({'port':port,'herderNamespacePid':herder.pid,'productionLanConnectErrno':network_errno}))
 deadline=time.monotonic()+300
 while not (shared/'outer-done').exists():
  if herder.poll() is not None:raise RuntimeError('Herder exited')
  if peer.poll() is not None and not (shared/'done').exists():raise RuntimeError('peer exited early')
  if time.monotonic()>deadline:raise RuntimeError('unit test timed out')
  time.sleep(.1)
 if not (shared/'done').exists():(shared/'done').write_text('ok')
 peer.communicate(timeout=10)
finally:
 if herder and herder.poll() is None:herder.terminate();herder.wait(timeout=5)
 if peer.poll() is None:peer.terminate();peer.wait(timeout=5)
