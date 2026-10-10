#!/usr/bin/env python3
"""Explicit common native Codex foreground manager; runtime owner55 only.

This is NOT a per-harness stdio writer or automatic node fallback. Mini's existing
shared socket needs no manager. Config: fleet/native-codex-config.json with exact
hostId, sourceSha, installed codexBin/codexSha256 and canonical codexSocket.
No install, daemon bootstrap/background updater, remote-control, CODEX_HOME change,
auth/config/history copy or external helper adoption. Any existing socket/path
(including stale/unknown) refuses startup; no unlink or forced takeover.

Own group: RSS256 soft30s/512MiB hard; CPU100%20s sustained after10s startup,
200% peak;64threads/16processes; own temp/state16MiB each, host reserve4GiB,
disk2GiB. Startup/readiness30s; native CLI remains foreground, KeepAlivefalse.
Native server itself uses its Unix listener startup lock, plus this wrapper's
canonical flock held for the entire generation. Readiness proves listener PID
and socket inode; it is NOT thread ownership, native input admission or UI proof.
All signals address ONLY the proven child generation on resource failure/stop.
Preserve native durable receipts/global history; UNKNOWN never replays. Shared
native history/auth, detached descendants and Python overhead are not budgeted
owned scratch. Darwin watchdog limits are not kernel/swap guarantees.

Same-generation rollback: bootout only this label, retain config/last-run; do not
remove or restart another listener. A leftover socket requires owner inspection,
not blind deletion. --check validates source/binary/host/reserve/duplicate only,
no native process; --lint-plist PATH runs native plutil before launchctl.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import fcntl

def validate_source_files(base,config):
    # Independent pre-import guard: a drifted companion cannot validate itself.
    hashes=config.get('launcherHashes')
    if not isinstance(hashes,dict):raise ValueError('launcher_identity_missing')
    for name in ('mac-node-watchdog.py','mac-codex-watchdog.py'):
        expected=hashes.get(name)
        if not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected):raise ValueError('launcher_identity_missing')
        with (base/name).open('rb') as handle:data=handle.read(1024**2+1)
        if len(data)>1024**2 or hashlib.sha256(data).hexdigest()!=expected:raise ValueError('launcher_identity_mismatch')

if __name__=='__main__':
    try:
        base=Path.home()/'.local/share/agent-herder/fleet'
        with (base/'native-codex-config.json').open('rb') as handle:data=handle.read(65537)
        if len(data)>65536:raise ValueError('config_size_limit')
        config=json.loads(data)
        if not isinstance(config,dict) or Path(__file__).resolve()!=base/'mac-codex-watchdog.py':raise ValueError('launcher_identity_missing')
        validate_source_files(base,config)
    except (OSError,ValueError,TypeError):
        print(json.dumps({'reason':'launcher_identity_unverified','secretsPrinted':False}),file=sys.stderr)
        raise SystemExit(78)

spec=importlib.util.spec_from_file_location('fleet_mac_node_watchdog',Path(__file__).with_name('mac-node-watchdog.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

class NativePolicy:
    host_reserve_kib=4*1024**2

def native_violations(sample,elapsed,soft=None):
    result=w.violations({**sample,'temp_bytes':0,'state_bytes':0,
        'threads':min(sample['threads'],128),'cpu_percent':0,'sustained_cpu_percent':0},NativePolicy(),elapsed,soft)
    for reason,over in [('threads',sample['threads']>64),('temp',sample['temp_bytes']>16*w.MIB),
            ('state',sample['state_bytes']>16*w.MIB),('cpu_instantaneous',sample['cpu_percent']>200),
            ('cpu_sustained',elapsed>10 and sample['sustained_cpu_percent']>100)]:
        if over:result.append(reason)
    return result

def binary_identity(path,digest):
    binary=w.executable(path)
    if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise w.Refused('native_binary_identity_missing')
    calculated=hashlib.sha256();size=0;deadline=time.monotonic()+5
    with binary.open('rb') as handle:
        while True:
            data=handle.read(1024**2)
            if not data:break
            size+=len(data)
            if size>256*w.MIB or time.monotonic()>deadline:raise w.Refused('native_binary_observation_limit')
            calculated.update(data)
    if calculated.hexdigest()!=digest:raise w.Refused('native_binary_identity_mismatch')
    return binary.resolve(strict=True)

def refuse_existing_socket(pointer):
    # lexists detects broken links too; no foreign/stale path is adopted or removed.
    if os.path.lexists(pointer):raise w.Refused('native_socket_already_owned_or_unknown')

def socket_identity(pointer):
    link=pointer.lstat();physical=pointer.resolve(strict=True);info=physical.stat()
    if (not (stat.S_ISSOCK(link.st_mode) or stat.S_ISLNK(link.st_mode))
            or link.st_uid!=os.getuid() or not stat.S_ISSOCK(info.st_mode)
            or info.st_uid!=os.getuid() or info.st_mode&0o077):
        raise w.Refused('native_socket_identity_mismatch')
    return {'device':info.st_dev,'inode':info.st_ino,'uid':info.st_uid,
            'aliasDevice':link.st_dev,'aliasInode':link.st_ino,'physicalPath':str(physical)}

def verify_socket_generation(pointer,proof):
    try:current=socket_identity(pointer)
    except (OSError,w.Refused):raise w.Refused('native_socket_generation_changed') from None
    if current!=proof:raise w.Refused('native_socket_generation_changed')

def listener_proof(pointer,child):
    if child.poll() is not None:raise w.Refused('native_process_exited_before_ready')
    proof=socket_identity(pointer)
    lines=w.command(['/usr/sbin/lsof','-t','-nP','-a','-p',str(child.pid),'-U',proof['physicalPath']]).split()
    if set(lines)!={str(child.pid)}:raise w.Refused('native_listener_identity_mismatch')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as probe:
        probe.settimeout(1);probe.connect(str(pointer))
    verify_socket_generation(pointer,proof)
    return proof

def prepare(base,config):
    if sys.platform!='darwin':raise w.Refused('darwin_required')
    w.Policy(w.command(['/usr/sbin/sysctl','-n','hw.model']).strip())
    if config['hostId']!=socket.gethostname():raise w.Refused('native_host_identity_mismatch')
    w.verify_launcher_hashes(base,config,['mac-node-watchdog.py','mac-codex-watchdog.py'])
    w.verify_manifest(base,config['sourceSha'])
    binary=binary_identity(config['codexBin'],config.get('codexSha256'))
    pointer=Path(config['codexSocket'])
    canonical=Path.home()/'.codex/app-server-control/app-server-control.sock'
    if pointer!=canonical:raise w.Refused('native_canonical_socket_required')
    refuse_existing_socket(pointer)
    state=Path.home()/'.local/state/agent-herder/fleet-native-codex';temp=base/'run/native-codex-tmp'
    if w.host_available_kib()<NativePolicy.host_reserve_kib or w.shutil.disk_usage(base).free<2*w.GIB:
        raise w.Refused('host_reserve_insufficient')
    w.storage_bytes(state,16*w.MIB);w.storage_bytes(temp,16*w.MIB)
    env=os.environ.copy();env['TMPDIR']=str(temp)
    # Do not redirect native global storage to a copied account/profile.
    if env.get('CODEX_HOME') and Path(env['CODEX_HOME']).resolve()!=Path.home()/'.codex':
        raise w.Refused('native_codex_home_unverified')
    return binary,pointer,state,temp,env

def monitor(child,pointer,state,temp,config):
    generation=time.time_ns();started=previous=time.monotonic();last_cpu={};cpu_samples=[];observed=[];sample={};soft=None;reason='native_exit';failed=[];proof=None
    def interrupted(*_):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        while child.poll() is None:
            observed=w.read_processes(child.pid);now=time.monotonic();elapsed=now-started
            if not observed:raise w.Refused('owned_group_unobserved')
            sample={'rss_kib':sum(r['rss_kib'] for r in observed),'processes':len(observed)}
            failed=[name for name,over in [('memory_hard',sample['rss_kib']>w.MEMORY_MAX_KIB),('processes',len(observed)>16)] if over]
            if failed:reason='resource_budget';break
            current={(r['pid'],r['identity']):r['cpu_seconds'] for r in observed}
            cpu=w.cpu_percent(last_cpu,current,now-previous) if last_cpu else 0
            cpu_samples.append((previous,now,cpu));cpu_samples=[r for r in cpu_samples if r[1]>now-w.CPU_WINDOW];previous=now;last_cpu=current
            sample.update(threads=w.read_threads(observed),cpu_percent=cpu,sustained_cpu_percent=w.rolling_cpu(cpu_samples,now),
                temp_bytes=w.storage_bytes(temp,16*w.MIB),state_bytes=w.storage_bytes(state,16*w.MIB),artifact_bytes=0,releases=0,
                host_available_kib=w.host_available_kib(),disk_free_bytes=w.shutil.disk_usage(temp).free)
            soft=w.soft_memory_anchor(sample['rss_kib'],elapsed,soft);failed=native_violations(sample,elapsed,soft)
            if failed:reason='resource_budget';break
            if proof is None:
                if os.path.lexists(pointer):
                    proof=listener_proof(pointer,child)
                    w.atomic_json(state/'ready.json',{'hostId':config['hostId'],'sourceSha':config['sourceSha'],'pid':child.pid,'generation':generation,'ownerStartedAt':' '.join(next(r['identity'] for r in observed if r['pid']==child.pid).split()),'ownerBin':config['codexBin'],'socket':proof,'ready':True,'readiness':'listener_only','inputAdmissionVerified':False})
                elif elapsed>=30:raise w.Refused('native_startup_deadline')
            else:
                verify_socket_generation(pointer,proof)
            time.sleep(w.POLL_SECONDS)
        if proof is None and reason=='native_exit':reason='native_unready_exit'
    except KeyboardInterrupt:reason='operator_stop'
    except (OSError,ValueError,w.Refused,subprocess.SubprocessError) as error:
        reason='observation_failed';failed=[str(error) if isinstance(error,w.Refused) else type(error).__name__]
    finally:
        w.atomic_json(state/'ready.json',{'hostId':config['hostId'],'sourceSha':config['sourceSha'],'pid':child.pid,'generation':generation,'ready':False,'reason':'cleanup_pending','socket':proof})
        try:w.stop_owned(child,observed)
        except (OSError,w.Refused,subprocess.SubprocessError):reason='cleanup_unverified'
        w.atomic_json(state/'ready.json',{'hostId':config['hostId'],'sourceSha':config['sourceSha'],'pid':child.pid,'generation':generation,'ready':False,'reason':reason,'socket':proof})
        w.atomic_json(state/'last-run.json',{'hostId':config['hostId'],'sourceSha':config['sourceSha'],'pid':child.pid,
            'generation':generation,'elapsedSeconds':round(time.monotonic()-started,2),'reason':reason,'sample':sample,'violations':failed,
            'socketProof':proof,'enforcement':'darwin_watchdog','swapGuarantee':False,'receiptsReplayed':False})
    return 0 if reason=='operator_stop' or reason=='native_exit' and child.returncode==0 else 78

def main():
    os.umask(0o077);base=Path.home()/'.local/share/agent-herder/fleet'
    if len(sys.argv)==3 and sys.argv[1]=='--lint-plist':
        w.validate_launchagent(Path(sys.argv[2]),entrypoint='mac-codex-watchdog.py');print(json.dumps({'plistValid':True,'activated':False}));return 0
    if sys.argv[1:] not in ([],['--check']):raise w.Refused('unsupported_argument')
    config=w.json_file(base/'native-codex-config.json');binary,pointer,state,temp,env=prepare(base,config)
    if sys.argv[1:]==['--check']:
        print(json.dumps({'hostId':config['hostId'],'sourceSha':config['sourceSha'],'socketState':'absent','enforcement':'darwin_watchdog','activated':False}));return 0
    for path in (state,base/'run',temp,pointer.parent):w.private_directory(path)
    # Persistent, native-home lock; never remove another instance's socket or lock.
    with (pointer.parent/'agent-herder-native-startup.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise w.Refused('native_startup_lock_busy') from None
        refuse_existing_socket(pointer)
        child=subprocess.Popen([str(binary),'app-server','--listen','unix://'+str(pointer)],env=env,start_new_session=True,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return monitor(child,pointer,state,temp,config)

if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError,TypeError,w.Refused,subprocess.SubprocessError) as error:
        print(json.dumps({'reason':str(error) if isinstance(error,w.Refused) else type(error).__name__,'enforcement':'darwin_watchdog','secretsPrinted':False}),file=sys.stderr)
        raise SystemExit(78)
