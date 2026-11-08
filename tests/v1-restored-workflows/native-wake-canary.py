#!/usr/bin/env python3
"""Two-phase native wake canary. No execution unless --prepare or --finish.

Prepare creates two sessions and a rule, then writes a private hook mapping for
installation by the hook owner. Finish verifies that exact installed mapping
before the single child followup. An uncertain effect is never reissued.
"""
import argparse, hashlib, json, os, pathlib, secrets, select, shlex, sqlite3, subprocess, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENDPOINT = 'https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp'
MODEL = 'gpt-6.1-terra'


def save(path, state):
    fd, name = tempfile.mkstemp(prefix='.wake-', dir=path.parent)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f, indent=2); f.flush(); os.fsync(f.fileno())
    os.replace(name, path)
    fd = os.open(path.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)


def private_create(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=2); f.flush(); os.fsync(f.fileno())
    fd = os.open(path.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)


def task_id(v):
    return v.get('task_ref') or v.get('taskId') or v.get('_herder_create_task') or v.get('_herder_delivery_task')


def rows(v):
    return (v.get('page') if isinstance(v.get('page'), dict) else v).get('messages', [])


def hook_matches(config, mapping):
    if config.get('endpoint') != ENDPOINT or config.get('mode') == 'capture' or not isinstance(config.get('bearer_file'), str) or not isinstance(config.get('children'), list): return False
    matches = [x for x in config['children'] if isinstance(x,dict) and x.get('session_id') == mapping['session_id'] and x.get('child_native_id') == mapping['session_id'] and isinstance(x.get('parent_native_id'),str) and x.get('parent_native_id') and x.get('cwd') == mapping['cwd'] and isinstance(x.get('child_ref'),str) and isinstance(x.get('rule_ref'),str)]
    return len(matches)==1 and all(matches[0].get(k)==v for k,v in mapping.items())


class MCP:
    def __init__(self, selector):
        self.proc = subprocess.Popen(['python3', str(ROOT / 'deploy/fleet/launch-v1-core.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env=dict(os.environ, HERDER_V1_ENTRY=str(selector)))
        self.seq = 0; self.buffer = b''
        self.rpc('initialize', {'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'native-wake-canary','version':'1'}})
        names = {x['name'] for x in self.rpc('tools/list', {}).get('tools', [])}
        if not {'discover','create','deliver','session','compat_task','automation'} <= names: raise RuntimeError('required MCP tools missing')

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait()

    def rpc(self, method, params):
        self.seq += 1; current = self.seq
        self.proc.stdin.write((json.dumps({'jsonrpc':'2.0','id':current,'method':method,'params':params})+'\n').encode()); self.proc.stdin.flush()
        deadline = time.monotonic()+60
        while time.monotonic() < deadline:
            if b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n',1); data = json.loads(line)
                if data.get('id') != current: continue
                if 'error' in data: raise RuntimeError('MCP RPC error')
                return data.get('result', {})
            if not select.select([self.proc.stdout], [], [], deadline-time.monotonic())[0]: break
            chunk = os.read(self.proc.stdout.fileno(), 65536)
            if not chunk: break
            self.buffer += chunk
        raise TimeoutError('RPC timeout: effect may be UNKNOWN')

    def call(self, name, args):
        r = self.rpc('tools/call', {'name':name,'arguments':args})
        v = r.get('structuredContent')
        if not isinstance(v, dict):
            try: v = json.loads(r['content'][0]['text'])
            except (KeyError, ValueError, IndexError, TypeError): v = {}
        if r.get('isError'): raise RuntimeError('tool '+name+' error; effect may be UNKNOWN')
        return v


def effect(client, path, state, label, tool, args):
    if label in state['effects']: raise RuntimeError(label+' already attempted: no replay')
    state['effects'][label] = {'state':'UNKNOWN','request_key':args['request_key']}; save(path, state)
    result = client.call(tool, args)
    state['effects'][label]['admission'] = result; save(path, state)
    return result


def task_result(client, path, state, label, admission):
    ref = task_id(admission)
    if not ref: raise RuntimeError(label+' missing durable task ID; no replay')
    state['effects'][label]['task_ref'] = ref; save(path, state)
    deadline = time.monotonic()+180
    while time.monotonic()<deadline:
        t = client.call('compat_task', {'action':'get','task_ref':ref})
        state['effects'][label]['task'] = t; save(path, state)
        if t.get('status') == 'completed':
            r = t.get('result') or {}
            if r.get('isError'): raise RuntimeError(label+' task error')
            return r.get('structuredContent') or {}
        if t.get('status') in ('failed','cancelled'): raise RuntimeError(label+' task '+t['status'])
        time.sleep(2)
    raise TimeoutError(label+' task timeout; no replay')


def wait_reply(client, ref, marker, timeout):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        data = client.call('session', {'action':'messages','session_ref':ref}); messages = rows(data)
        matched = [r for r in messages if r.get('role')=='assistant' and r.get('text','').strip()==marker]
        if matched: return {'marker':marker,'count':len(matched),'messages_complete':(data.get('page') or data).get('complete')}
        time.sleep(3)
    raise TimeoutError('assistant reply missing; no resend or manual reconcile')


def native_id(db, ref):
    with sqlite3.connect('file:'+str(db)+'?mode=ro', uri=True) as con:
        found = con.execute('SELECT native_session_id FROM session_bindings WHERE session_ref=? AND node_ref=? AND instance_id=?', (ref,'server-44','codex-44')).fetchall()
    if len(found)!=1 or not found[0][0]: raise RuntimeError('exact native session binding missing')
    return found[0][0]


def remote_native_cwd(host, native):
    probe = "import json,pathlib,sys; n=sys.argv[1]; root=pathlib.Path.home()/'.codex'; paths=[p for d in ('sessions','archived_sessions') for p in (root/d).rglob('*'+n+'*.jsonl')]; assert len(paths)==1; data=json.loads(paths[0].open().readline()); assert data.get('type')=='session_meta'; print(data['payload']['cwd'])"
    cmd = 'python3 -c '+shlex.quote(probe)+' '+shlex.quote(native)
    result = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,cmd],capture_output=True,text=True,timeout=15,check=True).stdout.strip()
    if not result.startswith('/') or '\n' in result: raise RuntimeError('native cwd unavailable')
    return result


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--selector',type=pathlib.Path,required=True); a.add_argument('--profile',type=pathlib.Path,required=True)
    a.add_argument('--checkpoint',type=pathlib.Path,required=True); a.add_argument('--mapping',type=pathlib.Path,required=True)
    a.add_argument('--remote-hook-config',required=True,help='absolute existing config path on server-44')
    a.add_argument('--remote-host',default='roomhacker@192.168.2.5');a.add_argument('--timeout',type=int,default=180)
    mode=a.add_mutually_exclusive_group(required=True); mode.add_argument('--prepare',action='store_true');mode.add_argument('--finish',action='store_true')
    x=a.parse_args()
    if not all(p.is_absolute() for p in (x.selector,x.profile,x.checkpoint,x.mapping)) or not x.remote_hook_config.startswith('/') or not 10<=x.timeout<=900: raise SystemExit('absolute paths and bounded timeout required')
    profile=json.loads(x.profile.read_text()); owner=profile['owner']; selector=json.loads(x.selector.read_text())
    manifest=pathlib.Path(selector['manifest']); raw=manifest.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=selector['manifest_sha256'] or str(x.profile) not in selector['profiles']: raise SystemExit('selector/manifest mismatch')
    if (owner['node'],owner['instance'],owner['kind'])!=('server-44','codex-44','codex'): raise SystemExit('wrong profile')
    companion=pathlib.Path(owner['ahap_script']+'.json'); wrapper=json.loads(companion.read_text())
    manifest_data=json.loads(raw); matches=[v for v in manifest_data.get('remote_ahap_wrappers',[]) if v.get('node')=='server-44' and v.get('instance')=='codex-44' and v.get('kind')=='codex' and v.get('script')==owner['ahap_script']]
    if len(matches)!=1 or hashlib.sha256(pathlib.Path(owner['ahap_script']).read_bytes()).hexdigest()!=matches[0].get('script_sha256') or hashlib.sha256(companion.read_bytes()).hexdigest()!=matches[0].get('config_sha256'): raise SystemExit('unverified wrapper/config')
    if wrapper.get('nodeRef')!='server-44' or wrapper.get('kind')!='codex' or wrapper.get('model')!=MODEL or x.remote_host != wrapper.get('user','')+'@'+wrapper.get('host','') or wrapper.get('port')!=22: raise SystemExit('wrong remote identity/model')
    if x.prepare:
        if x.mapping.exists(): raise SystemExit('mapping already exists')
        x.checkpoint.parent.mkdir(parents=True,exist_ok=True,mode=0o700); run=secrets.token_hex(16)
        state={'status':'PREPARING','run':run,'model':MODEL,'node':'server-44','instance':'codex-44','manifest_sha256':selector['manifest_sha256'],'selector':str(x.selector),'profile':str(x.profile),'mapping':str(x.mapping),'effects':{}}
        private_create(x.checkpoint,state)
    else:
        st=x.checkpoint.stat()
        if st.st_uid!=os.getuid() or st.st_mode&0o077: raise SystemExit('checkpoint must be private')
        state=json.loads(x.checkpoint.read_text()); run=state['run']
        if state.get('status')!='MAPPING_READY' or any(state.get(k)!=v for k,v in [('manifest_sha256',selector['manifest_sha256']),('selector',str(x.selector)),('profile',str(x.profile)),('mapping',str(x.mapping))]): raise SystemExit('checkpoint not resumable or inputs changed; no replay')
    client=None
    try:
        client=MCP(x.selector)
        instances=client.call('discover',{'action':'instances','node_ref':'server-44'}).get('instances',[])
        if not any(y.get('instance_ref')=='codex-44' and y.get('node_ref')=='server-44' for y in instances): raise RuntimeError('remote instance unavailable')
        if x.prepare:
            for role in ('parent','child'):
                marker='HERDER_WAKE_'+run+'_'+role.upper()+'_READY'; prompt='Reply with exactly '+marker
                admission=effect(client,x.checkpoint,state,'create_'+role,'create',{'action':'create','instance_ref':'codex-44','prompt':prompt,'request_key':run+'-create-'+role})
                result=task_result(client,x.checkpoint,state,'create_'+role,admission); ref=result.get('create',{}).get('session_ref'); receipt=result.get('prompt',{})
                if not ref or receipt.get('outcome')!='confirmed' or not receipt.get('native_receipt_id'): raise RuntimeError('create unconfirmed')
                state[role+'_ref']=ref;state[role+'_receipt']=receipt;save(x.checkpoint,state)
                state[role+'_initial_reply']=wait_reply(client,ref,marker,x.timeout);save(x.checkpoint,state)
            wake='Reply with exactly HERDER_WAKE_'+run+'_PARENT_WAKE'
            result=effect(client,x.checkpoint,state,'rule','automation',{'action':'create','session_ref':state['parent_ref'],'rule':{'kind':'child_completion','child_ref':state['child_ref'],'wake_message':wake},'request_key':run+'-rule'})
            if not result.get('rule_ref'): raise RuntimeError('rule unconfirmed')
            state['rule_ref']=result['rule_ref'];state['wake_marker']='HERDER_WAKE_'+run+'_PARENT_WAKE';save(x.checkpoint,state)
            parent=native_id(profile['database'],state['parent_ref']);child=native_id(profile['database'],state['child_ref'])
            mapping={'session_id':child,'child_native_id':child,'parent_native_id':parent,'cwd':remote_native_cwd(x.remote_host,child),'child_ref':state['child_ref'],'rule_ref':state['rule_ref']}
            x.mapping.parent.mkdir(parents=True,exist_ok=True,mode=0o700);private_create(x.mapping,mapping)
            state['mapping_sha256']=hashlib.sha256(x.mapping.read_bytes()).hexdigest();state['status']='MAPPING_READY';save(x.checkpoint,state)
            print(json.dumps({'status':'MAPPING_READY','checkpoint':str(x.checkpoint),'mapping':str(x.mapping),'mapping_sha256':state['mapping_sha256']}));return
        mapping=json.loads(x.mapping.read_text())
        if x.mapping.stat().st_uid!=os.getuid() or x.mapping.stat().st_mode&0o077 or hashlib.sha256(x.mapping.read_bytes()).hexdigest()!=state['mapping_sha256']: raise RuntimeError('mapping changed or not private')
        # Read only: hook owner installs the file and merges this exact entry.
        probe='import json,os,stat,sys; p=sys.argv[1]; s=os.stat(p); assert stat.S_IMODE(s.st_mode)==0o600; print(open(p).read())'
        command='python3 -c '+shlex.quote(probe)+' '+shlex.quote(x.remote_hook_config)
        proc=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',x.remote_host,command],capture_output=True,text=True,timeout=15,check=True)
        config=json.loads(proc.stdout)
        if not hook_matches(config,mapping): raise RuntimeError('exact installed hook mapping missing')
        marker='HERDER_WAKE_'+run+'_CHILD_FOLLOWUP'; prompt='Reply with exactly '+marker
        admission=effect(client,x.checkpoint,state,'child_followup','deliver',{'action':'session','session_ref':state['child_ref'],'message':prompt,'mode':'queue','request_key':run+'-child-followup'})
        receipt=task_result(client,x.checkpoint,state,'child_followup',admission)
        if receipt.get('outcome')!='confirmed' or not receipt.get('native_receipt_id'): raise RuntimeError('followup unconfirmed')
        state['followup_receipt']=receipt;save(x.checkpoint,state)
        state['child_reply']=wait_reply(client,state['child_ref'],marker,x.timeout);save(x.checkpoint,state)
        state['parent_auto_reply']=wait_reply(client,state['parent_ref'],state['wake_marker'],x.timeout);save(x.checkpoint,state)
        if state['parent_auto_reply']['count']!=1: raise RuntimeError('duplicate wake reply observed')
        for role in ('child','parent'):
            result=effect(client,x.checkpoint,state,'archive_'+role,'session',{'action':'archive','session_ref':state[role+'_ref'],'request_key':run+'-archive-'+role})
            if result.get('archived') is not True or result.get('effect')!='confirmed': raise RuntimeError('archive unconfirmed')
        state['status']='PASS';save(x.checkpoint,state);print(json.dumps({'status':'PASS','checkpoint':str(x.checkpoint),'parent':state['parent_ref'],'child':state['child_ref'],'rule':state['rule_ref']}))
    except Exception as e:
        # Preserve MAPPING_READY for missing installed mapping only; no effect was issued.
        if state.get('status')!='MAPPING_READY' or 'child_followup' in state['effects']:
            state['status']='INCOMPLETE'
        state['error_type']=type(e).__name__;state['error']=str(e)[:250];save(x.checkpoint,state);raise
    finally:
        if client:client.close()

if __name__=='__main__': main()
