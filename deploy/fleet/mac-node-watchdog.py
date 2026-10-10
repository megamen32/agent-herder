#!/usr/bin/env python3
"""Source-only Darwin local Herder supervisor; activate only through the node owner.

Contract: ~/.local/share/agent-herder/fleet/{node-config.json,current/dist,
releases}; config sourceSha/hostId/nodeBin/harnesses and native pointers match
Linux. launcherHashes seals installed Python wrappers; every declared payload
file is SHA-checked (<=512 files/512MiB/5s); external deps remain owner proof.
Codex JOIN also requires approved codexOwnerPid/codexOwnerStartedAt
(ps lstart) /codexOwnerBin; canonical rendezvous +UID/PID/executable/listen/
inode proof is refreshed each sample, no unknown owner/forward adoption.
OpenCode additionally needs an EXISTING protected opencodeEnvFile.
Never inspect /proc, create a native daemon, copy credentials or prune releases.

Owned child process group: RSS soft256MiB (30s sustained), hard512MiB;
CPU100% over20s,150% per sample after10s startup;128 threads/16 processes;
temp128/state64MiB; <=2 release directories/512MiB; host reserve Mini2/M1 4GiB,
disk2GiB. Poll delay2s plus bounded probes, commands2s, scan1s/30000 entries;
cleanup global10s (within LaunchAgent ExitTimeOut20s), unknown =>unverified. These are
Darwin watchdog observations/stops, NOT kernel reservations or swap0 guarantees.
Detached processes are outside group enforcement; native shared controls remain
outside the group. Watchdog overhead and shared daemon growth require separate
owner measurement. Soft pressure never triggers native RPC or input replay.

--lint-plist PATH parses rendered XML/binary plist and calls native plutil -lint;
owner must run this BEFORE launchctl (JSON/Linux unit content fails closed).
Manifest requires the published40-character sourceSHA and exact index.js digest.
--check is read-only metadata/admission, not a native consumer proof. LaunchAgent
has KeepAlive=false: budget/preflight failures need owner repair, no restart loop.
Official ps -M and launchd semantics: apple-oss-distributions/{adv_cmds,launchd}.
"""
import fcntl
import json
import hashlib
import plistlib
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from xml.parsers.expat import ExpatError

MIB = 1024**2
GIB = 1024**3
MEMORY_SOFT_KIB = 256*1024
MEMORY_MAX_KIB = 512*1024
SOFT_WINDOW = 30
CPU_WINDOW = 20
POLL_SECONDS = 2

class Refused(RuntimeError):
    """Short non-secret reason; underlying commands/config are never printed."""

class Policy:
    def __init__(self, model):
        if model not in ('Macmini6,2', 'MacBookPro18,2'):
            raise Refused('native_model_unverified')
        self.host_reserve_kib = (2 if model == 'Macmini6,2' else 4)*1024**2

def command(argv,deadline=None):
    timeout=min(2,deadline-time.monotonic()) if deadline is not None else 2
    if timeout<=0:raise Refused('owned_cleanup_deadline')
    result = subprocess.run(argv, capture_output=True, timeout=timeout, check=False,
                            env={**os.environ, 'LC_ALL':'C'})
    if result.returncode or len(result.stdout)>1024**2:
        raise Refused('native_observation_failed')
    return result.stdout.decode('utf8', errors='strict')

def json_file(path):
    with path.open('rb') as handle:
        data=handle.read(65537)
    if len(data)>65536:raise Refused('config_size_limit')
    value=json.loads(data)
    if not isinstance(value,dict):raise Refused('config_shape_invalid')
    return value

def executable(value):
    path=Path(value)
    if not path.is_absolute() or not path.is_file() or not os.access(path,os.X_OK):
        raise Refused('native_executable_missing')
    return path

def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:
        raise Refused('owned_directory_permissions')

def storage_bytes(root, limit):
    if root.is_symlink():raise Refused('storage_root_unverified')
    if not root.exists():return 0
    deadline=time.monotonic()+1;count=0;total=0;pending=[root]
    while pending:
        directory=pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                count+=1
                if count>30000 or time.monotonic()>deadline:raise Refused('storage_observation_limit')
                info=entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):pending.append(Path(entry.path))
                else:total+=info.st_size
                if total>limit:raise Refused('storage_budget_exceeded')
    return total

def verify_codex_owner(config):
    pointer=Path(config['codexSocket'])
    if pointer!=Path.home()/'.codex/app-server-control/app-server-control.sock':
        raise Refused('managed_codex_owner_unverified')
    pid=config.get('codexOwnerPid');expected=config.get('codexOwnerStartedAt');binary=config.get('codexOwnerBin')
    if type(pid)!=int or pid<=1 or not isinstance(expected,str) or not isinstance(binary,str):
        raise Refused('managed_codex_owner_unverified')
    logical=pointer.lstat();physical=pointer.resolve(strict=True);info=physical.stat()
    if logical.st_uid!=os.getuid() or info.st_uid!=os.getuid() or not stat.S_ISSOCK(info.st_mode):
        raise Refused('managed_codex_owner_unverified')
    def process_identity():
        row=command(['/bin/ps','-p',str(pid),'-o','uid=,lstart=,command=']).strip().split(maxsplit=6)
        if len(row)!=7 or int(row[0])!=os.getuid() or ' '.join(row[1:6])!=' '.join(expected.split()):
            raise Refused('managed_codex_owner_unverified')
        argv=shlex.split(row[6]);claimed=executable(binary).resolve(strict=True)
        if (len(argv)<2 or not Path(argv[0]).is_absolute() or Path(argv[0]).resolve()!=claimed
                or argv[1]!='app-server' or '--listen' not in argv):
            raise Refused('managed_codex_owner_unverified')
        index=argv.index('--listen')+1
        if index>=len(argv) or argv[index] not in ('unix://','unix://'+str(pointer)):
            raise Refused('managed_codex_owner_unverified')
    process_identity()
    pids=command(['/usr/sbin/lsof','-t','-nP','-a','-U',str(physical)]).split()
    if set(pids)!={str(pid)}:raise Refused('managed_codex_owner_unverified')
    process_identity()
    final=pointer.stat()
    if (final.st_dev,final.st_ino)!=(info.st_dev,info.st_ino):raise Refused('managed_codex_owner_unverified')
    return {'pid':pid,'startedAt':expected,'device':info.st_dev,'inode':info.st_ino}

def codex_environment(config):
    value=config.get('codexSocket')
    if not isinstance(value,str) or not Path(value).is_absolute() or ':' in value or '?' in value:
        raise Refused('managed_codex_socket_missing')
    pointer=Path(value)
    try:
        info=pointer.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid():
            raise Refused('managed_codex_socket_missing')
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as probe:
            probe.settimeout(1);probe.connect(str(pointer))
    except OSError:raise Refused('managed_codex_socket_missing') from None
    verify_codex_owner(config)
    binary=executable(config['codexBin'])
    return {'CODEX_APP_SERVER_SOCKET':str(pointer),'CODEX_TRANSPORT':'app-server',
            'CODEX_BIN':str(binary),'CODEX_CWD':str(Path.home())}

def protected_env(pointer):
    with pointer.open('rb') as handle:
        info=os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:
            raise Refused('protected_pointer_permissions')
        text=handle.read(16385)
    if len(text)>16384:raise Refused('protected_pointer_size')
    values={}
    for line in text.decode('utf8').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):continue
        words=shlex.split(line,comments=True,posix=True)
        if words and words[0]=='export':words=words[1:]
        if len(words)!=1 or '=' not in words[0]:raise Refused('protected_pointer_format')
        name,value=words[0].split('=',1)
        if name in ('OPENCODE_SERVER_PASSWORD','OPENCODE_SERVER_USERNAME'):
            if not value or '\x00' in value:raise Refused('protected_pointer_format')
            values[name]=value
    if not values.get('OPENCODE_SERVER_PASSWORD'):raise Refused('opencode_auth_pointer_missing')
    return values

def opencode_environment(config):
    pointer=config.get('opencodeEnvFile')
    if not isinstance(pointer,str) or not Path(pointer).is_absolute():
        raise Refused('opencode_auth_pointer_missing')
    values=protected_env(Path(pointer))
    pid=config.get('opencodePid');port=config.get('opencodePort')
    if type(pid)!=int or pid<=1 or type(port)!=int or not 1<=port<=65535:
        raise Refused('opencode_native_identity_missing')
    native=command(['/bin/ps','-p',str(pid),'-o','uid=,command=']).strip().split(maxsplit=1)
    if len(native)!=2 or int(native[0])!=os.getuid():raise Refused('opencode_native_identity_mismatch')
    args=shlex.split(native[1])
    if 'serve' not in args or not any('opencode' in Path(arg).name for arg in args[:2]):
        raise Refused('opencode_native_identity_mismatch')
    actual=args[args.index('--port')+1] if '--port' in args else '4096'
    if actual!=str(port):raise Refused('opencode_native_port_changed')
    listeners=command(['/usr/sbin/lsof','-t','-nP','-a','-p',str(pid),'-iTCP:'+str(port),'-sTCP:LISTEN']).split()
    if set(listeners)!={str(pid)}:raise Refused('opencode_native_listener_mismatch')
    return {**values,'OPENCODE_URL':'http://127.0.0.1:'+str(port)}

def cpu_seconds(value):
    days,sep,clock=value.partition('-');total=float(days)*86400 if sep else 0
    parts=(clock if sep else value).split(':');seconds=0
    for part in parts:seconds=seconds*60+float(part)
    return total+seconds

def parse_processes(text, pgid, uid):
    rows=[]
    for line in text.splitlines():
        fields=line.split(maxsplit=5)
        if len(fields)!=6:raise Refused('process_observation_invalid')
        pid,group,user,rss=map(int,fields[:4])
        if group!=pgid:continue
        if user!=uid:raise Refused('owned_group_identity_lost')
        rows.append({'pid':pid,'pgid':group,'uid':user,'rss_kib':rss,
                     'cpu_seconds':cpu_seconds(fields[4]),'identity':fields[5]})
    return rows

def read_processes(pgid,deadline=None):
    argv=['/bin/ps','-axo','pid=,pgid=,uid=,rss=,time=,lstart=']
    text=command(argv,deadline=deadline) if deadline is not None else command(argv)
    return parse_processes(text,pgid,os.getuid())

def read_threads(rows):
    if not rows:return 0
    text=command(['/bin/ps','-M','-p',','.join(str(r['pid']) for r in rows),'-o','pid='])
    pids=[int(line.strip()) for line in text.splitlines() if line.strip()]
    if not {r['pid'] for r in rows}.issuperset(pids):raise Refused('thread_observation_invalid')
    return len(pids)

def cpu_percent(previous,current,elapsed):
    return sum(max(0,value-previous.get(pid,0)) for pid,value in current.items())/elapsed*100 if elapsed>0 else 0

def rolling_cpu(samples,now):
    return sum(max(0,min(end,now)-max(start,now-CPU_WINDOW))*cpu for start,end,cpu in samples)/CPU_WINDOW

def soft_memory_anchor(rss,now,previous):
    return (now if previous is None else previous) if rss>MEMORY_SOFT_KIB else None

def violations(sample,policy,elapsed,soft_since=None):
    rules=[('memory_hard',sample['rss_kib']>MEMORY_MAX_KIB),
        ('memory_soft_sustained',soft_since is not None and elapsed-soft_since>=SOFT_WINDOW),
        ('processes',sample['processes']>16),('threads',sample['threads']>128),
        ('temp',sample['temp_bytes']>128*MIB),('state',sample['state_bytes']>64*MIB),
        ('artifact',sample['artifact_bytes']>512*MIB),('releases',sample['releases']>2),
        ('host_memory',sample['host_available_kib']<policy.host_reserve_kib),
        ('host_disk',sample['disk_free_bytes']<2*GIB)]
    if elapsed>10:rules.extend([('cpu_instantaneous',sample['cpu_percent']>150),('cpu_sustained',sample['sustained_cpu_percent']>100)])
    return [name for name,failed in rules if failed]

def host_available_kib():
    pressure=command(['/usr/bin/memory_pressure'])
    match=re.search(r'System-wide memory free percentage:\s*(\d+)%',pressure)
    if not match:raise Refused('host_memory_unverified')
    total=int(command(['/usr/sbin/sysctl','-n','hw.memsize']))//1024
    return total*int(match[1])//100

def release_usage(base):
    root=base/'releases'
    if not root.is_dir() or root.is_symlink():raise Refused('release_layout_invalid')
    releases=[]
    with os.scandir(root) as entries:
        for entry in entries:
            if len(releases)>=2 or not entry.is_dir(follow_symlinks=False):raise Refused('release_budget_exceeded')
            releases.append(entry.name)
    return len(releases),storage_bytes(root,512*MIB)

def validate_launchagent(path,entrypoint='mac-node-watchdog.py'):
    try:
        with path.open('rb') as handle:
            raw=handle.read(16385)
        if len(raw)>16384:raise Refused('launchagent_format_invalid')
        value=plistlib.loads(raw)
        args=value.get('ProgramArguments') if isinstance(value,dict) else None
        if (not isinstance(args,list) or len(args)!=5 or args[1:4]!=['-I','-S','-B']
                or Path(args[-1]).name!=entrypoint
                or any('__' in str(arg) for arg in args)
                or value.get('RunAtLoad') is not True or value.get('KeepAlive') is not False):
            raise Refused('launchagent_format_invalid')
        command(['/usr/bin/plutil','-lint',str(path)])
    except (ValueError,plistlib.InvalidFileException,ExpatError,AttributeError,TypeError):
        raise Refused('launchagent_format_invalid') from None
    return value

def verify_manifest(base,source):
    manifest=json_file(base/'current/dist/fleet-deployment-manifest.json')
    if (not isinstance(source,str) or not re.fullmatch('[a-f0-9]{40}',source)
            or manifest.get('source_sha')!=source or manifest.get('source_dirty') is not False):
        raise Refused('source_identity_mismatch')
    entry=(base/'current/dist/index.js').resolve(strict=True)
    if base.resolve()/'releases' not in entry.parents:raise Refused('release_layout_invalid')
    payload=manifest.get('payload')
    if not isinstance(payload,dict) or not 1<=len(payload)<=512 or 'index.js' not in payload:
        raise Refused('artifact_identity_missing')
    root=(base/'current/dist').resolve(strict=True);total=0;deadline=time.monotonic()+5
    for name,digest in payload.items():
        if (not isinstance(name,str) or Path(name).is_absolute() or '..' in Path(name).parts
                or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest)):
            raise Refused('artifact_manifest_invalid')
        path=(root/name).resolve(strict=True)
        if root not in path.parents or not path.is_file():raise Refused('artifact_manifest_invalid')
        computed=hashlib.sha256()
        with path.open('rb') as handle:
            while True:
                data=handle.read(MIB)
                if not data:break
                total+=len(data)
                if total>512*MIB or time.monotonic()>deadline:raise Refused('artifact_observation_limit')
                computed.update(data)
        if computed.hexdigest()!=digest:raise Refused('artifact_identity_mismatch')
    return entry

def verify_launcher_hashes(base,config,names):
    declared=config.get('launcherHashes')
    if not isinstance(declared,dict):raise Refused('launcher_identity_missing')
    for name in names:
        digest=declared.get(name);path=base/name
        if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise Refused('launcher_identity_missing')
        with path.open('rb') as handle:data=handle.read(MIB+1)
        if len(data)>MIB or hashlib.sha256(data).hexdigest()!=digest:raise Refused('launcher_identity_mismatch')

def prepare(base,config):
    if sys.platform!='darwin':raise Refused('darwin_required')
    policy=Policy(command(['/usr/sbin/sysctl','-n','hw.model']).strip())
    if config['hostId']!=socket.gethostname():raise Refused('native_host_identity_mismatch')
    verify_launcher_hashes(base,config,['mac-node-watchdog.py'])
    entry=verify_manifest(base,config['sourceSha'])
    node=executable(config['nodeBin'])
    harnesses=config['harnesses']
    if not isinstance(harnesses,list) or not harnesses or not set(harnesses)<={'codex','zcode','opencode'}:
        raise Refused('unsupported_node_harnesses')
    native={}
    if 'codex' in harnesses:native.update(codex_environment(config))
    if 'opencode' in harnesses:native.update(opencode_environment(config))
    if 'zcode' in harnesses:
        znode=executable(config['zcodeNode']);zentry=Path(config['zcodeEntry'])
        if not zentry.is_absolute() or not zentry.is_file():raise Refused('zcode_entry_missing')
        native.update(ZCODE_SERVER_NODE=str(znode),ZCODE_SERVER_ENTRY=str(zentry),ZCODE_CWD=str(Path.home()))
    state=Path.home()/'.local/state/agent-herder/fleet-node';temp=base/'run/tmp'
    release_usage(base)
    if host_available_kib()<policy.host_reserve_kib or shutil.disk_usage(base).free<2*GIB:
        raise Refused('host_reserve_insufficient')
    storage_bytes(temp,128*MIB);storage_bytes(state,64*MIB)
    env=os.environ.copy()
    for name in ('codex','zcode','opencode','claude','qoder','hermes','fast-agent','chatgpt','minimax-code'):
        env['ENABLE_'+name.upper().replace('-','_')]='true' if name in harnesses else 'false'
    env.update(native,NODE_OPTIONS='--max-old-space-size=192',UV_THREADPOOL_SIZE='1',
        AGENT_HERDER_WEB_HOST='127.0.0.1',AGENT_HERDER_WEB_PORT=str(config.get('webPort',18789)),
        AGENT_HERDER_ADAPTER_REGISTRY=str(state/'adapters.json'),AGENT_HERDER_AUTOPILOT_STATE_DIR=str(state/'autopilot'),
        AGENT_HERDER_HUMAN_REQUEST_STORE=str(state/'human-requests.json'),AGENT_HERDER_SINGLETON_LOCK=str(base/'run/node.lock'),TMPDIR=str(temp))
    port=config.get('webPort',18789)
    if type(port)!=int or not 1024<=port<=65535:raise Refused('node_port_invalid')
    with socket.socket() as probe:probe.bind(('127.0.0.1',port))
    return policy,node,entry,state,temp,env

def stop_owned(child,observed,timeout=10):
    """Signal the proven live owned group; after leader exit, only pinned members."""
    deadline=time.monotonic()+timeout
    def remaining_time():
        left=deadline-time.monotonic()
        if left<=0:raise Refused('owned_cleanup_deadline')
        return left
    if child.poll() is None:
        remaining_time()
        if os.getpgid(child.pid)!=child.pid or child.pid==os.getpgrp():raise Refused('owned_group_identity_lost')
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=min(5,remaining_time()))
        except subprocess.TimeoutExpired:
            remaining_time()
            if child.poll() is None and os.getpgid(child.pid)==child.pid:
                os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=min(2,remaining_time()))
    pinned={r['pid']:r for r in observed}
    def remaining():
        remaining_time();current=read_processes(child.pid,deadline=deadline);remaining_time()
        if any(r['pid'] not in pinned or any(r[k]!=pinned[r['pid']][k] for k in ('pgid','uid','identity')) for r in current):
            raise Refused('owned_group_identity_lost')
        return current
    # Re-read before every signal. Never use a reaped leader PID as an ownership proof.
    for sig in (signal.SIGTERM,signal.SIGKILL):
        rows=remaining()
        if not rows:return
        for row in rows:
            current=remaining()
            if any(r['pid']==row['pid'] for r in current):
                try:os.kill(row['pid'],sig)
                except ProcessLookupError:pass
        if sig==signal.SIGTERM:time.sleep(min(1,remaining_time()))
    if remaining():raise Refused('owned_cleanup_incomplete')

def atomic_json(path,value):
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(value,separators=(',',':'))+'\n');os.chmod(temporary,0o600);os.replace(temporary,path)

def main():
    os.umask(0o077);base=Path.home()/'.local/share/agent-herder/fleet'
    if len(sys.argv)==3 and sys.argv[1]=='--lint-plist':
        validate_launchagent(Path(sys.argv[2]));print(json.dumps({'plistValid':True,'activated':False}));return 0
    if sys.argv[1:] not in ([],['--check']):raise Refused('unsupported_argument')
    config=json_file(base/'node-config.json')
    policy,node,entry,state,temp,env=prepare(base,config)
    if sys.argv[1:]==['--check']:
        print(json.dumps({'hostId':socket.gethostname(),'sourceSha':config['sourceSha'],'harnesses':config['harnesses'],'nativeCodexSocket':'codex' in config['harnesses'],'secretsPrinted':False,'enforcement':'darwin_watchdog'}));return 0
    for path in (state,base/'run',temp):private_directory(path)
    with (base/'run/watchdog.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Refused('owned_watchdog_already_running') from None
        atomic_json(state/'adapters.json',{'version':1,'enabled':{name:env['ENABLE_'+name.upper().replace('-','_')]=='true' for name in ('codex','zcode','opencode','claude','qoder','hermes','fast-agent','chatgpt')}})
        child=subprocess.Popen([str(node),str(entry)],cwd=entry.parent.parent,env=env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        started=previous=time.monotonic();previous_cpu={};cpu_samples=[];observed=[];sample={};soft=None;reason='node_exit';failed=[]
        def interrupted(*_):raise KeyboardInterrupt
        signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
        try:
            while child.poll() is None:
                if 'codex' in config['harnesses']:verify_codex_owner(config)
                observed=read_processes(child.pid);now=time.monotonic();elapsed=now-started
                if not observed:raise Refused('owned_group_unobserved')
                sample={'rss_kib':sum(r['rss_kib'] for r in observed),'processes':len(observed)}
                failed=[name for name,over in [('memory_hard',sample['rss_kib']>MEMORY_MAX_KIB),('processes',len(observed)>16)] if over]
                if failed:reason='resource_budget';break
                current={(r['pid'],r['identity']):r['cpu_seconds'] for r in observed};cpu=cpu_percent(previous_cpu,current,now-previous)
                cpu_samples.append((previous,now,cpu));cpu_samples=[s for s in cpu_samples if s[1]>now-CPU_WINDOW];previous=now;previous_cpu=current
                releases,artifact=release_usage(base)
                sample={'rss_kib':sum(r['rss_kib'] for r in observed),'processes':len(observed),'threads':read_threads(observed),
                    'cpu_percent':cpu,'sustained_cpu_percent':rolling_cpu(cpu_samples,now),'temp_bytes':storage_bytes(temp,128*MIB),
                    'state_bytes':storage_bytes(state,64*MIB),'artifact_bytes':artifact,'releases':releases,
                    'host_available_kib':host_available_kib(),'disk_free_bytes':shutil.disk_usage(base).free}
                soft=soft_memory_anchor(sample['rss_kib'],elapsed,soft);failed=violations(sample,policy,elapsed,soft)
                if failed:reason='resource_budget';break
                time.sleep(POLL_SECONDS)
        except KeyboardInterrupt:reason='operator_stop'
        except (OSError,ValueError,Refused,subprocess.SubprocessError) as error:
            reason='observation_failed';failed=[str(error) if isinstance(error,Refused) else type(error).__name__]
        finally:
            try:stop_owned(child,observed)
            except (OSError,Refused,subprocess.SubprocessError):reason='cleanup_unverified'
            atomic_json(state/'last-run.json',{'reason':reason,'sourceSha':config['sourceSha'],'hostId':config['hostId'],'nodePid':child.pid,
                'elapsedSeconds':round(time.monotonic()-started,2),'sample':sample,'violations':failed,'enforcement':'darwin_watchdog','swapGuarantee':False})
        return 0 if reason=='operator_stop' or reason=='node_exit' and child.returncode==0 else 78

if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError,TypeError,Refused,subprocess.SubprocessError) as error:
        print(json.dumps({'reason':str(error) if isinstance(error,Refused) else type(error).__name__,'enforcement':'darwin_watchdog','secretsPrinted':False}),file=sys.stderr)
        raise SystemExit(78)
